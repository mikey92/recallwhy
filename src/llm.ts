// The single injected model generator. Every agent that needs a model gets
// this function; it never builds its own client.
import type { Trace } from "./trace.ts";

export interface GenOpts { purpose: string; agent: string; system?: string; maxTokens?: number; json?: boolean }
export type Generator = (prompt: string, opts: GenOpts) => Promise<string>;

export interface LlmConfig { provider: "ollama" | "openai" | "none"; model: string; ollamaUrl?: string; baseUrl?: string; apiKey?: string }

export function makeGenerator(cfg: LlmConfig, trace: Trace): Generator {
  return async (prompt, opts) => {
    const t0 = Date.now();
    let output = "";
    let error: string | undefined;
    try {
      if (cfg.provider === "none") throw new Error("no model configured (LLM_PROVIDER=none)");
      output = cfg.provider === "ollama" ? await ollama(cfg, prompt, opts) : await openai(cfg, prompt, opts);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    trace.emit("llm", opts.agent, { model: `${cfg.provider}:${cfg.model}`, purpose: opts.purpose, prompt: prompt.slice(0, 4000), output: error ? `ERROR ${error}` : output, ms: Date.now() - t0 });
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
      options: { temperature: 0, num_predict: opts.maxTokens ?? 300 } }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { message?: { content?: string } };
  return stripThink(j.message?.content ?? "");
}

async function openai(cfg: LlmConfig, prompt: string, opts: GenOpts): Promise<string> {
  if (!cfg.baseUrl) throw new Error("OPENAI_BASE_URL is not set");
  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: JSON.stringify({ model: cfg.model, messages: messages(prompt, opts), temperature: 0, max_tokens: opts.maxTokens ?? 300 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`model endpoint HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return stripThink(j.choices?.[0]?.message?.content ?? "");
}

export const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
