// The safety manager's digest of a whole run, read through the Meterless Markovian engine: the cases go
// in fixed-size batches, one bounded chunk each, and only a compressed state (running totals, what is
// most urgent so far) is carried from chunk to chunk. A run with 200 cases costs the same per call as
// one with 10. Totals and the case table are computed in code; the model writes only the short
// "what needs you first" lines, and the Auditor rejects any number in them that no case line contains.
import { writeFileSync } from "node:fs";
import { Markovian } from "./engines/markovian/index.ts";
import { auditBrief } from "./agents/auditor.ts";
import { say, type AgentContext } from "./agents/context.ts";
import type { RunResult } from "./orchestrator.ts";

export interface DigestCase { id: string; recall: string; firm: string; product: string; verdict: string; onHand: number; stores: number; sold: number; customers: number; packet?: string }

const RANK = ["act-now", "notify", "needs-human", "no-exposure", "not-ours"];
const line = (c: DigestCase) => `${c.id} | ${c.firm} | ${c.product.slice(0, 90)} | ${c.verdict}` +
  (c.verdict === "act-now" || c.verdict === "notify" ? ` | on hand ${c.onHand} in ${c.stores} store(s) | sold ${c.sold} | customers ${c.customers}${c.packet ? ` | packet ${c.packet}` : ""}` : "");

export interface Digest { markdown: string; chunks: number; status: string; efficiencyPercent: number; tokensSaved: number; by: "model" | "template"; rejected?: string }

export async function digest(ctx: AgentContext, run: Pick<RunResult, "runId" | "scanned">, cases: DigestCase[], outDir: string): Promise<Digest> {
  const sorted = [...cases].sort((a, b) => RANK.indexOf(a.verdict) - RANK.indexOf(b.verdict) || b.onHand - a.onHand);
  const urgent = sorted.filter((c) => c.verdict === "act-now" || c.verdict === "notify" || c.verdict === "needs-human");
  const batch = Math.max(6, Math.ceil(urgent.length / 30));
  const batches: DigestCase[][] = [];
  for (let i = 0; i < urgent.length; i += batch) batches.push(urgent.slice(i, i + batch));
  const useModel = !ctx.model.startsWith("none:") && batches.length > 0;
  const goal = "Tell a retail product-safety manager which recalls need them first this week, one short line each, most urgent first.";
  const m = new Markovian({ chunkConfig: { chunkSize: 2000, carryoverTokens: 256, maxChunks: Math.min(32, Math.max(1, batches.length)) } });
  let step = 0;
  const r = await m.run({
    goal, mode: "RESEARCH", reflect: false,
    stepFn: async ({ carryover }) => {
      const b = batches[step++] ?? [];
      const last = step >= batches.length;
      const state = `TOTAL SO FAR: ${batches.slice(0, step - 1).flat().length} case(s) read`;
      if (!useModel) {
        // No model: the chain still runs, one deterministic line per case.
        const lines = b.map((c) => `- ${c.firm}: ${c.verdict}${c.onHand ? `, pull ${c.onHand} unit(s) in ${c.stores} store(s)` : ""}${c.customers ? `, notify at most ${c.customers} customer(s)` : ""} (${c.id})`);
        return { content: `${lines.join("\n")}\n${last ? "[TASK_COMPLETE]" : `[STATE_CHECKPOINT]\nCOMPLETED: ${state}; ${b.length} more\nREMAINING: ${batches.length - step} batch(es)\nDECISIONS: none\nCONTEXT: most urgent first`}` };
      }
      const prompt = [goal, "", carryover ? `[CARRYOVER STATE]\n${carryover}\n` : "",
        "CASES IN THIS BATCH (case | firm | product | verdict | our numbers):", ...b.map(line), "",
        "Write one line per case that needs action, starting with '- ', most urgent first: the firm, what to do, and the case id in brackets.",
        "Use only numbers that appear in the case lines. Do not invent states, people or dates.",
        last ? "This is the last batch: end with [TASK_COMPLETE]." : "Then write [STATE_CHECKPOINT] and a state block of at most 4 lines (COMPLETED, REMAINING, DECISIONS, CONTEXT) with the most urgent cases so far."].join("\n");
      const out = await ctx.gen(prompt, { agent: "Briefer", purpose: `digest chunk ${step}/${batches.length} (Markovian)`, maxTokens: 500 }).catch(() => "");
      return { content: out || b.map((c) => `- ${c.firm}: ${c.verdict} (${c.id})`).join("\n") + (last ? "\n[TASK_COMPLETE]" : "") };
    },
  });
  let body = r.output.split("\n").filter((l) => /^\s*-\s/.test(l)).join("\n");
  let by: Digest["by"] = useModel ? "model" : "template";
  let rejected: string | undefined;
  if (useModel) {
    // The model's lines may only state numbers the case lines contain.
    const evidence = urgent.map(line).join("\n");
    const problems = auditBrief(body.replace(/\[([^\]]+)\]/g, "($1)") + " [E1]", new Set(["E1"]), evidence + " 1").filter((p) => !/cites/.test(p));
    if (problems.length) {
      rejected = problems.slice(0, 3).join("; ");
      ctx.trace.emit("critique", "Auditor", { code: "digest-unsupported", detail: rejected });
      say(ctx, "Auditor", "Briefer", `digest lines rejected: ${rejected}; using the computed list`);
      body = urgent.map((c) => `- ${c.firm}: ${c.verdict}${c.onHand ? `, pull ${c.onHand} unit(s) in ${c.stores} store(s)` : ""}${c.customers ? `, notify at most ${c.customers} customer(s)` : ""} (${c.id})`).join("\n");
      by = "template";
    }
  }
  const count = (v: string) => cases.filter((c) => c.verdict === v).length;
  const md = [
    `# This week's recalls — ${run.runId}`, "",
    `${run.scanned} recall notice(s) read; ${cases.length} touch our catalog: **${count("act-now")} act now**, ${count("notify")} notify, ${count("needs-human")} need a person, ${count("no-exposure")} no exposure, ${count("not-ours")} not ours.`,
    `On our shelves in recalled lots: **${cases.reduce((a, c) => a + (c.verdict === "act-now" ? c.onHand : 0), 0)} unit(s)**; customers to notify: at most ${cases.reduce((a, c) => a + c.customers, 0)}.`, "",
    "## What needs you first", body || "- Nothing this week.", "",
    "## All cases", "| Case | Firm | Verdict | On hand | Stores | Sold since recall | Customers |", "|---|---|---|---|---|---|---|",
    ...sorted.map((c) => `| [${c.id}](briefs/${c.id}.md) | ${c.firm.replace(/\|/g, "/")} | ${c.verdict} | ${c.onHand || ""} | ${c.stores || ""} | ${c.sold || ""} | ${c.customers || ""} |`), "",
    `_Read through the Meterless Markovian engine: ${r.chunks.length} chunk(s) of at most ${batch} case(s), ${r.status}; carryover state ≤ 256 tokens; estimated ${Math.round(r.efficiencyPercent)}% fewer input tokens than re-reading all earlier batches (${r.totalTokensSaved} tokens, ${r.tokenLabel}). Lines by ${by === "model" ? `${ctx.model}, numbers checked by the Auditor` : rejected ? "the computed list (model lines failed the Auditor's number check)" : "the computed list (no model configured)"}._`,
  ].join("\n");
  writeFileSync(`${outDir}/digest.md`, md + "\n");
  ctx.trace.emit("note", "Briefer", { text: `digest written through Markovian: ${r.chunks.length} chunk(s), ${r.status}, ${r.efficiencyPercent}% estimated input tokens saved`, markovian: { chunks: r.chunks.length, status: r.status, efficiencyPercent: r.efficiencyPercent, tokensSaved: r.totalTokensSaved, chunkConfig: r.chunkConfig } });
  say(ctx, "Briefer", "Human", `weekly digest ready: ${count("act-now")} act now, ${count("needs-human")} need a person (${r.chunks.length} Markovian chunk(s))`);
  return { markdown: md, chunks: r.chunks.length, status: r.status, efficiencyPercent: r.efficiencyPercent, tokensSaved: r.totalTokensSaved, by, rejected };
}
