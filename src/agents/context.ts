// What every agent gets: the SQL runner (Zetaris or the sample stand-in), the
// single model generator, the two Meterless engines, and the trace.
import type { SqlRunner } from "../sql/types.ts";
import type { Generator } from "../llm.ts";
import type { CaseMemory } from "../memory.ts";
import type { World } from "../world.ts";
import type { Trace } from "../trace.ts";
import type { SourceMap } from "./cartographer.ts";

export interface AgentContext {
  sql: SqlRunner; gen: Generator; memory: CaseMemory; world: World; trace: Trace; model: string;
  map?: SourceMap;
  /** false only in the evaluation's ablation: no source map and no Auditor → Cartographer loop */
  cartographer?: boolean;
  /** Where escalated cases go (default state/review-queue.json); the evaluation keeps its own. */
  queueFile?: string;
}

export type AgentName = "Orchestrator" | "Cartographer" | "Scout" | "Investigator" | "Auditor" | "Briefer";

export function say(ctx: AgentContext, from: AgentName, to: AgentName | "Human", text: string, data: Record<string, unknown> = {}) {
  ctx.trace.emit("msg", from, { to, text, ...data });
}

/** SQL string literal. Values come from feeds and our own catalog, still always escaped. */
export const lit = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
export const inList = (xs: string[]) => (xs.length ? xs.map(lit).join(", ") : "''");
