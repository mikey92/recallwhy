// One run of the agent team, shared by the CLI and the HTTP API: build the context
// (SQL runner, model generator, engines, trace), run the orchestrator, close.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Trace } from "./trace.ts";
import { makeRunner } from "./sql/index.ts";
import { makeGenerator, llmFromEnv } from "./llm.ts";
import { CaseMemory } from "./memory.ts";
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
