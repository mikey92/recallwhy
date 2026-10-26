// The single injected model generator. Every agent that needs a model gets
// this function; it never builds its own client.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Trace } from "./trace.ts";
import { classify, profiles, route } from "./scout-intent.ts";

/** `purpose` names the task; Scout Intent routing (src/scout-intent.ts) classifies it and picks the model. */
export interface GenOpts { purpose: string; agent: string; system?: string; maxTokens?: number }
export type Generator = (prompt: string, opts: GenOpts) => Promise<string>;

export interface LlmConfig { provider: "meterless" | "ollama" | "openai" | "none"; model: string; ollamaUrl?: string; baseUrl?: string; apiKey?: string; numCtx?: number; app?: string; note?: string; rpm?: number; fastModel?: string }

const NIGHTSHIFT_URL = "http://127.0.0.1:8088/v1";
// Hosted NVIDIA endpoints rate-limit per minute, so the last waits reach past a minute.
const RETRIES = [3_000, 8_000, 20_000, 45_000, 90_000]; // backoff before attempts 2-6
// Hosted NVIDIA models through Nightshift answered about 4 calls a minute (2026-10-24: 239 of
// 931 upstream calls in an hour succeeded, the rest were 429). Pacing to that keeps a run as fast
// and avoids the 429 → Nightshift 502 → retry chain. LLM_RPM overrides; 0 turns pacing off.
const NVIDIA_RPM = 4;

/** Provider settings from the environment. Meterless Nightshift is the default (hackathon rule: primary AI provider). */
export function llmFromEnv(env: NodeJS.ProcessEnv): LlmConfig {
  const provider = (env.LLM_PROVIDER as LlmConfig["provider"]) || "meterless";
  if (provider === "meterless") {
    const apiKey = env.METERLESS_RUNTIME_TOKEN || nightshiftToken();
    // No Nightshift on this machine (a judge's laptop, a container): run without a model rather
    // than fail every call. Text matches then go to the human queue and briefs use the template.
    if (!apiKey) return { provider: "none", model: "none", note: "Meterless Nightshift is not configured (no METERLESS_RUNTIME_TOKEN): running without a model; text matches go to the human queue." };
    const model = env.METERLESS_MODEL || "nvidia/nemotron-3-ultra-550b-a55b";
    // Narrow, checked tasks go to the small Nemotron (3.5 Lightning) when the judge is a hosted Nemotron;
    // METERLESS_FAST_MODEL overrides, and an empty value sends everything to the main model.
    const fastModel = env.METERLESS_FAST_MODEL !== undefined ? env.METERLESS_FAST_MODEL || undefined : /^nvidia\/nemotron/i.test(model) ? "nvidia/nemotron-3.5-lightning-30b-a3b" : undefined;
    return { provider, model, fastModel, baseUrl: env.METERLESS_BASE_URL || NIGHTSHIFT_URL, apiKey, app: env.METERLESS_APP || "recallwhy", rpm: rpmFromEnv(env, model) };
  }
  if (provider === "none") return { provider, model: "none" };
  const model = env.LLM_MODEL ?? "nemotron-3-nano";
  return { provider, model, ollamaUrl: env.OLLAMA_URL, baseUrl: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY, rpm: rpmFromEnv(env, provider === "openai" ? model : "") };
}

function rpmFromEnv(env: NodeJS.ProcessEnv, model: string): number {
  const set = Number(env.LLM_RPM);
  if (env.LLM_RPM?.trim() && Number.isFinite(set) && set >= 0) return set;
  return /^nvidia\//i.test(model) ? NVIDIA_RPM : 0;
}

interface Clock { now(): number; sleep(ms: number): Promise<void> }
const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Token bucket: up to `perMinute` calls start at once, then one every 60/perMinute s. Calls wait in order. */
export function makePacer(perMinute: number, clock: Clock = realClock): () => Promise<void> {
  if (!(perMinute > 0)) return async () => {};
  const interval = 60_000 / perMinute;
  let tokens = perMinute;
  let last = clock.now();
  let queue: Promise<void> = Promise.resolve();
  return () => (queue = queue.then(async () => {
    const t = clock.now();
    tokens = Math.min(perMinute, tokens + (t - last) / interval);
    last = t;
    if (tokens < 1) {
      await clock.sleep(Math.ceil((1 - tokens) * interval));
      tokens = 1;
      last = clock.now();
    }
    tokens -= 1;
  }));
}

/** The Runtime API key Nightshift writes next to its settings on this Mac (used when METERLESS_RUNTIME_TOKEN is unset). Never logged. */
function nightshiftToken(): string | undefined {
  const base = join(homedir(), "Library", "Application Support");
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base).filter((n) => n.startsWith("ai.meterless.nightshift"))) {
    const f = join(base, d, "runtime-token");
    if (existsSync(f)) return readFileSync(f, "utf8").trim();
  }
  return undefined;
}

export function makeGenerator(cfg: LlmConfig, trace: Trace): Generator {
  const pace = makePacer(cfg.rpm ?? 0);
  // Circuit breaker: when Nightshift cannot be reached at all (wrong URL, not running), stop calling it after
  // a few tries and let every later call take the no-model path at once, instead of waiting minutes per call.
  let unreachable = 0;
  const BREAK_AFTER = 3;
  const ps = profiles(cfg);
  // One attempt on one model: rate limits and slow first tokens are retried with backoff, each retry traced.
  const attempt = async (model: string, prompt: string, opts: GenOpts): Promise<{ output: string; served: Served }> => {
    const call = { ...cfg, model };
    if (cfg.provider === "ollama") return { output: await ollama(call, prompt, opts), served: {} };
    for (let n = 1; ; n++) {
      await pace();
      try { return await openai(call, prompt, opts); } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Rate limits and slow first tokens are transient; a connection that cannot be opened is not.
        if (n >= RETRIES.length + 1 || !/HTTP (429|502|503|504)\b|\b429\b|first token|aborted due to timeout/i.test(msg)) throw e;
        trace.emit("llm.retry", opts.agent, { purpose: opts.purpose, model, attempt: n, waitMs: RETRIES[n - 1], reason: msg.slice(0, 160) });
        await new Promise((r) => setTimeout(r, RETRIES[n - 1]));
      }
    }
  };
  return async (prompt, opts) => {
    // No model: callers fall back (judge → UNSURE, lots → regex, brief → template); nothing was called, so nothing is logged.
    if (cfg.provider === "none") throw new Error("no model configured (LLM_PROVIDER=none)");
    if (unreachable >= BREAK_AFTER) throw new Error("model endpoint unreachable earlier in this run; continuing without a model");
    // Scout Intent: classify the call, route it to a profile by risk and by how its output is checked.
    const r = route(classify(opts.purpose), ps);
    trace.emit("route", opts.agent, { spec: "meterless-scout-intent", purpose: opts.purpose, intent: r.intent, risk: r.risk, profile: r.profile, model: r.model, chain: r.chain, reason: r.reason });
    let lastError = "";
    for (const [k, model] of r.chain.entries()) {
      const t0 = Date.now();
      let output = "", served: Served = {}, error: string | undefined;
      try { ({ output, served } = await attempt(model, prompt, opts)); } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(`${error} ${cause}`)) {
          if (++unreachable === BREAK_AFTER) trace.emit("note", opts.agent, { text: `model endpoint unreachable ${BREAK_AFTER} times in a row (${error.slice(0, 80)}); the rest of this run goes on without a model: text matches go to a person, briefs use the template` });
        } else unreachable = 0;
      }
      // Which model actually answered: Nightshift may route to another model, so record what it reports, with the tokens it counted.
      trace.emit("llm", opts.agent, { model: `${cfg.provider}:${model}`, served_model: served.model, receipt: served.receipt, usage: served.usage, intent: r.intent, purpose: opts.purpose, prompt: prompt.slice(0, 4000), output: error ? `ERROR ${error}` : output, ms: Date.now() - t0 });
      if (!error) return output;
      lastError = error;
      if (unreachable >= BREAK_AFTER) break;
      const next = r.chain[k + 1];
      if (next) trace.emit("route", opts.agent, { spec: "meterless-scout-intent", purpose: opts.purpose, intent: r.intent, fallback: next, from: model, reason: `${model} failed (${error.slice(0, 80)}); the profile's fallback runs it` });
    }
    throw new Error(lastError);
  };
}

function messages(prompt: string, opts: GenOpts) {
  return [...(opts.system ? [{ role: "system", content: opts.system }] : []), { role: "user", content: prompt }];
}

async function ollama(cfg: LlmConfig, prompt: string, opts: GenOpts): Promise<string> {
  const res = await fetch(`${cfg.ollamaUrl ?? "http://127.0.0.1:11434"}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.model, messages: messages(prompt, opts), stream: false, think: false,
      options: { temperature: 0, num_predict: opts.maxTokens ?? 300, num_ctx: cfg.numCtx ?? 8192 }, keep_alive: "2m" }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { message?: { content?: string } };
  return stripThink(j.message?.content ?? "");
}

interface Served { model?: string; receipt?: string; usage?: { prompt?: number; completion?: number } }

async function openai(cfg: LlmConfig, prompt: string, opts: GenOpts): Promise<{ output: string; served: Served }> {
  if (!cfg.baseUrl) throw new Error(cfg.provider === "meterless" ? "METERLESS_BASE_URL is not set" : "OPENAI_BASE_URL is not set");
  if (cfg.provider === "meterless" && !cfg.apiKey) throw new Error("no Nightshift Runtime API key: set METERLESS_RUNTIME_TOKEN (Nightshift ▸ Console ▸ API key)");
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) };
  if (cfg.provider === "meterless") Object.assign(headers, { "meterless-app": cfg.app ?? "recallwhy", "meterless-scope": "user" });
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers,
    // Nemotron 3 / 3.5 think out loud by default; the agents want only the answer.
    body: JSON.stringify({ model: cfg.model, messages: messages(prompt, opts), temperature: 0, max_tokens: opts.maxTokens ?? 300,
      ...(/nemotron-3/i.test(cfg.model) ? { chat_template_kwargs: { enable_thinking: false } } : {}) }),
    signal: AbortSignal.timeout(cfg.provider === "meterless" ? 180_000 : 120_000),
  });
  if (!res.ok) throw new Error(`${cfg.provider === "meterless" ? "Nightshift" : "model endpoint"} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[]; meterless?: { routed_model?: string; receipt_id?: string }; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const usage = j.usage ? { prompt: j.usage.prompt_tokens, completion: j.usage.completion_tokens } : undefined;
  return { output: stripThink(j.choices?.[0]?.message?.content ?? ""), served: { model: j.meterless?.routed_model ?? j.model, receipt: j.meterless?.receipt_id, usage } };
}

export const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
