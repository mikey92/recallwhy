// The single injected model generator. Every agent that needs a model gets
// this function; it never builds its own client.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Trace } from "./trace.ts";

export interface GenOpts { purpose: string; agent: string; system?: string; maxTokens?: number; json?: boolean }
export type Generator = (prompt: string, opts: GenOpts) => Promise<string>;

export interface LlmConfig { provider: "meterless" | "ollama" | "openai" | "none"; model: string; ollamaUrl?: string; baseUrl?: string; apiKey?: string; numCtx?: number; app?: string; note?: string }

const NIGHTSHIFT_URL = "http://127.0.0.1:8088/v1";
// Hosted NVIDIA endpoints rate-limit per minute, so the last waits reach past a minute.
const RETRIES = [3_000, 8_000, 20_000, 45_000, 90_000]; // backoff before attempts 2-6

/** Provider settings from the environment. Meterless Nightshift is the default (hackathon rule: primary AI provider). */
export function llmFromEnv(env: NodeJS.ProcessEnv): LlmConfig {
  const provider = (env.LLM_PROVIDER as LlmConfig["provider"]) || "meterless";
  if (provider === "meterless") {
    const apiKey = env.METERLESS_RUNTIME_TOKEN || nightshiftToken();
    // No Nightshift on this machine (a judge's laptop, a container): run without a model rather
    // than fail every call. Text matches then go to the human queue and briefs use the template.
    if (!apiKey) return { provider: "none", model: "none", note: "Meterless Nightshift is not configured (no METERLESS_RUNTIME_TOKEN): running without a model; text matches go to the human queue." };
    return { provider, model: env.METERLESS_MODEL || "meterless/auto", baseUrl: env.METERLESS_BASE_URL || NIGHTSHIFT_URL, apiKey, app: env.METERLESS_APP || "recallwhy" };
  }
  if (provider === "none") return { provider, model: "none" };
  return { provider, model: env.LLM_MODEL ?? "nemotron-3-nano", ollamaUrl: env.OLLAMA_URL, baseUrl: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY };
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
  return async (prompt, opts) => {
    const t0 = Date.now();
    let output = "";
    let error: string | undefined;
    let served: Served = {};
    try {
      if (cfg.provider === "none") throw new Error("no model configured (LLM_PROVIDER=none)");
      if (cfg.provider === "ollama") output = await ollama(cfg, prompt, opts);
      else {
        // Rate limits (429) and slow first tokens (502/504) from the hosted model are transient:
        // wait and try again, and record each retry so the trace shows the recovery.
        for (let attempt = 1; ; attempt++) {
          try { ({ output, served } = await openai(cfg, prompt, opts)); break; } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt >= RETRIES.length + 1 || !/HTTP (429|502|503|504)\b|\b429\b|first token|fetch failed/i.test(msg)) throw e;
            trace.emit("llm.retry", opts.agent, { purpose: opts.purpose, attempt, waitMs: RETRIES[attempt - 1], reason: msg.slice(0, 160) });
            await new Promise((r) => setTimeout(r, RETRIES[attempt - 1]));
          }
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    // Which model actually answered: Nightshift may route meterless/auto to any model, so record what it reports.
    trace.emit("llm", opts.agent, { model: `${cfg.provider}:${cfg.model}`, served_model: served.model, receipt: served.receipt, purpose: opts.purpose, prompt: prompt.slice(0, 4000), output: error ? `ERROR ${error}` : output, ms: Date.now() - t0 });
    if (error) throw new Error(error);
    return output;
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

interface Served { model?: string; receipt?: string }

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
  const j = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[]; meterless?: { routed_model?: string; receipt_id?: string } };
  return { output: stripThink(j.choices?.[0]?.message?.content ?? ""), served: { model: j.meterless?.routed_model ?? j.model, receipt: j.meterless?.receipt_id } };
}

export const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
