// One run of the agent team, shared by the CLI and the HTTP API: build the context
// (SQL runner, model generator, engines, trace), run the orchestrator, close.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Trace } from "./trace.ts";
import { makeRunner } from "./sql/index.ts";
import { makeGenerator, llmFromEnv } from "./llm.ts";
import { CaseMemory, decisionNote } from "./memory.ts";
import { World } from "./world.ts";
import { run, type RunResult } from "./orchestrator.ts";

export interface RunOptions { since: string; only?: string[]; limit?: number }

export async function runOnce(env: NodeJS.ProcessEnv, opts: RunOptions, trace = new Trace()): Promise<RunResult & { trace: string; engine: string; model: string; briefs: Record<string, string> }> {
  const sql = await makeRunner(env, trace);
  const llm = llmFromEnv(env);
  if (llm.provider === "none" && llm.note) console.warn(llm.note);
  const ctx = { sql, gen: makeGenerator(llm, trace), memory: new CaseMemory(trace), world: new World(trace), trace, model: `${llm.provider}:${llm.model}` };
  try {
    const r = await run(ctx, opts);
    const dir = `${r.outDir}/briefs`;
    const briefs = existsSync(dir) ? Object.fromEntries(readdirSync(dir).map((f) => [f.replace(/\.md$/, ""), readFileSync(`${dir}/${f}`, "utf8")])) : {};
    return { ...r, trace: trace.file, engine: sql.engine, model: ctx.model, briefs };
  } finally {
    await sql.close();
  }
}

/** "H-1407-2026" → "fda:H-1407-2026", "26717" → "cpsc:26717"; already-prefixed ids pass through. */
const recallKey = (r: string) => (r.includes(":") ? r : /^[A-Z]-\d+-\d{4}$/.test(r) ? `fda:${r}` : `cpsc:${r}`);

/** A reviewer's decision, stored in H-MEM with high trust; the next run follows it. Shared by the CLI and the API. */
export function decide(recallId: string, sku: string, verdict: "same" | "not-this", note = ""): { recall: string; memoryId: string } {
  const trace = new Trace({ quiet: true });
  const id = recallKey(recallId);
  const rec = new CaseMemory(trace).record({ recallId: id, sku, verdict, reason: note, by: "human", runId: trace.runId }, "Human");
  return { recall: id, memoryId: rec.id };
}

/** Cases the Auditor escalated, newest last. */
export function reviewQueue(): unknown[] {
  const f = "state/review-queue.json";
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
}

/** Reviewer decisions already stored in H-MEM, so a review screen can show what is settled. */
export function humanDecisions(): { recall: string; sku: string; verdict: string; memoryId: string; note: string }[] {
  const mem = new CaseMemory(new Trace({ quiet: true, dir: "logs/review" }));
  return mem.hmem.store.all().filter((m) => m.tags.includes("by:human") && !m.supersededBy).map((m) => ({
    recall: m.tags.find((t) => t.startsWith("recall:"))!.slice(7),
    sku: m.tags.find((t) => t.startsWith("sku:"))!.slice(4),
    verdict: m.tags.find((t) => t.startsWith("verdict:"))!.slice(8),
    memoryId: m.id,
    note: decisionNote(m.content),
  }));
}

/** Is this recall/SKU pair waiting in the review queue? The API and the review screen only take decisions for those. */
export function inQueue(recallId: string, sku: string): boolean {
  const id = recallKey(recallId);
  return (reviewQueue() as { recall: string; skus: { sku: string }[] }[]).some((c) => c.recall === id && c.skus.some((s) => s.sku === sku));
}
