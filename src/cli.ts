#!/usr/bin/env -S npx tsx
// recallwhy run [--since YYYY-MM-DD] [--only H-1361-2026,27024] [--limit N]
// recallwhy decide <recall-id> <sku> same|not-this [--note "..."]
// recallwhy queue
import { readFileSync, existsSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { Trace } from "./trace.ts";
import { makeRunner } from "./sql/index.ts";
import { makeGenerator, type LlmConfig } from "./llm.ts";
import { CaseMemory } from "./memory.ts";
import { World } from "./world.ts";
import { run } from "./orchestrator.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const env = loadConfig();

async function main() {
  const cmd = args[0] ?? "run";
  if (cmd === "decide") {
    const [, recallId, sku, verdict] = args;
    if (!recallId || !sku || !["same", "not-this"].includes(verdict)) throw new Error('usage: decide <recall-id> <sku> same|not-this [--note "..."]');
    const trace = new Trace({ quiet: false });
    const mem = new CaseMemory(trace);
    const id = recallId.includes(":") ? recallId : /^[A-Z]-\d+-\d{4}$/.test(recallId) ? `fda:${recallId}` : `cpsc:${recallId}`;
    mem.record({ recallId: id, sku, verdict: verdict as "same" | "not-this", reason: flag("note") ?? "no note", by: "human", runId: trace.runId }, "Human");
    console.log(`stored: ${sku} ${verdict} for ${id} (high trust; used on the next run)`);
    return;
  }
  if (cmd === "queue") {
    const f = "state/review-queue.json";
    console.log(existsSync(f) ? readFileSync(f, "utf8") : "[]");
    return;
  }
  const trace = new Trace();
  const sql = await makeRunner(env, trace);
  const llm: LlmConfig = { provider: (env.LLM_PROVIDER as LlmConfig["provider"]) ?? "ollama", model: env.LLM_MODEL ?? "nemotron-3-nano", ollamaUrl: env.OLLAMA_URL, baseUrl: env.OPENAI_BASE_URL, apiKey: env.OPENAI_API_KEY };
  const ctx = { sql, gen: makeGenerator(llm, trace), memory: new CaseMemory(trace), world: new World(trace), trace, model: `${llm.provider}:${llm.model}` };
  try {
    const r = await run(ctx, { since: flag("since") ?? "2026-09-15", only: flag("only")?.split(","), limit: flag("limit") ? Number(flag("limit")) : undefined });
    console.log(`\n${r.cases.length} case(s) from ${r.scanned} recalls → ${r.outDir}/report.md\ntrace: ${trace.file}`);
  } finally { await sql.close(); }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
