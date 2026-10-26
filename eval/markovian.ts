// What the Meterless Markovian engine changes in the weekly digest, measured on the prompts the digest actually
// sends, not estimated. The gain is a bounded prompt: every call stays small however many cases a run has. Its
// total tokens are NOT lower than one prompt holding every case (that is reported too), only lower than a loop
// that re-reads its history on each call. Setup: a full sample-mode run since 2026-07-01 (every recall that touches the catalog), with a
// stand-in model that records each digest prompt and answers in the engine's checkpoint format. For every
// chunk, the Markovian prompt (this batch + a carryover of at most 256 tokens) is compared with what a loop
// without Markovian would send: the same prompt plus every earlier batch's case lines, re-read each time.
// Tokens are counted as characters / 4 (the same rule for both sides).
//   npx tsx eval/markovian.ts   → eval/results/markovian.json
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Trace } from "../src/trace.ts";
import { makeRunner } from "../src/sql/index.ts";
import { CaseMemory } from "../src/memory.ts";
import { World } from "../src/world.ts";
import { run } from "../src/orchestrator.ts";

const repo = resolve(".");
const dir = mkdtempSync(join(tmpdir(), "rw-markovian-"));
process.chdir(dir);
const trace = new Trace({ quiet: true });
const sql = await makeRunner({ SAMPLE_MODE: "true" } as NodeJS.ProcessEnv, trace);
const digestPrompts: string[] = [];
const gen = async (prompt: string, opts: { purpose: string }) => {
  if (!/^digest chunk/.test(opts.purpose)) return "UNSURE"; // the judge and the rest: no model answer
  digestPrompts.push(prompt);
  const ids = [...prompt.matchAll(/^(case-\S+) \|/gm)].map((m) => m[1]);
  const last = /This is the last batch/.test(prompt);
  return `${ids.map((id) => `- action for [${id}]`).join("\n")}\n${last ? "[TASK_COMPLETE]" : `[STATE_CHECKPOINT]\nCOMPLETED: ${ids.length} more cases read\nREMAINING: more batches\nDECISIONS: none\nCONTEXT: most urgent so far ${ids.slice(0, 3).join(", ")}`}`;
};
const ctx = { sql, gen, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), trace, model: "measure:stand-in" } as never;
const r = await run(ctx, { since: "2026-07-01" });
await sql.close();

const tokens = (s: string) => Math.ceil(s.length / 4);
const batchLines = (p: string) => { const i = p.indexOf("CASES IN THIS BATCH"); const j = p.indexOf("\n\n", i); return i < 0 ? "" : p.slice(i, j < 0 ? undefined : j); };
let markov = 0, full = 0;
const chunks = digestPrompts.map((p, k) => {
  const earlier = digestPrompts.slice(0, k).map(batchLines).join("\n");
  const carry = (p.match(/\[CARRYOVER STATE\]\n[\s\S]*?\n\n/)?.[0] ?? "");
  const withMarkovian = tokens(p), without = tokens(p.replace(carry, "")) + tokens(earlier);
  markov += withMarkovian; full += without;
  return { chunk: k + 1, markovianPromptTokens: withMarkovian, fullHistoryPromptTokens: without };
});
const out = {
  note: "Prompt tokens of the weekly digest over a full sample-mode run since 2026-07-01. Markovian: each batch + a ≤256-token carryover, so the largest prompt stays small. Compared with (a) one prompt holding every case (fewer tokens in total, but its size grows with the run) and (b) a chunked loop that re-reads every earlier batch. Tokens = characters / 4 on all sides.",
  cases: r.cases.length, urgentChunks: digestPrompts.length,
  markovianPromptTokens: markov, fullHistoryPromptTokens: full,
  savedPercent: full ? Math.round((1 - markov / full) * 1000) / 10 : 0,
  onePromptAllCasesTokens: chunks.length ? chunks[chunks.length - 1].fullHistoryPromptTokens : 0,
  largestPromptTokens: { markovian: Math.max(...chunks.map((c) => c.markovianPromptTokens)), fullHistory: Math.max(...chunks.map((c) => c.fullHistoryPromptTokens)) },
  chunks,
};
writeFileSync(join(repo, "eval/results/markovian.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`${out.cases} cases, ${out.urgentChunks} digest chunks: largest prompt ${out.largestPromptTokens.markovian} tokens with Markovian vs ${out.onePromptAllCasesTokens} for one prompt holding every case; total ${markov} (Markovian) vs ${out.onePromptAllCasesTokens} (one prompt) vs ${full} (re-reading earlier batches)`);
