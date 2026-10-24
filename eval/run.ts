// Match-level evaluation of the real Investigator ⇄ Auditor loop (no shortcuts):
// every candidate pair the Scout finds since --since, final decision vs labels.
// Runs on the sample snapshots with the DuckDB stand-in so it needs no Zetaris.
//   npx tsx eval/run.ts --provider meterless --model nvidia/nemotron-3-super-120b-a12b   (through Nightshift)
//   npx tsx eval/run.ts --model nemotron-3-nano:latest [--provider ollama|none] [--since 2026-07-01]
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { Trace } from "../src/trace.ts";
import { DuckSampleRunner } from "../src/sql/duck.ts";
import { makeGenerator, llmFromEnv, type LlmConfig } from "../src/llm.ts";
import { CaseMemory } from "../src/memory.ts";
import { World } from "../src/world.ts";
import { scout } from "../src/agents/scout.ts";
import { adjudicate } from "../src/orchestrator.ts";
import { chart } from "../src/agents/cartographer.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const provider = arg("provider", "meterless") as LlmConfig["provider"];
const model = arg("model", provider === "meterless" ? (process.env.METERLESS_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b") : "none")!;
const since = arg("since", "2026-07-01")!;
// Ablations: --no-cartographer (no source map, no Auditor → Cartographer loop; barcodes join as
// written) and --map-on-demand (no upfront map; the Cartographer only fixes keys the Auditor sends back).
const ablation = process.argv.includes("--no-cartographer") ? "no-cartographer" : process.argv.includes("--map-on-demand") ? "map-on-demand" : "";
// --recalls a,b,c: spot check on those recalls only (written under a separate "-subset" tag)
const only = arg("recalls")?.split(",");
// --map-model <model>: the Cartographer asks this Nightshift model for barcode transforms even when the judge is off,
// which isolates what model-proposed (and SQL-proven) transforms add to the map.
const mapModel = arg("map-model");
const tag = `${provider}-${model}${ablation ? `-${ablation}` : ""}${mapModel ? `-map-${mapModel}` : ""}${only ? "-subset" : ""}`.replace(/[^a-z0-9.-]+/gi, "_");

// Labels: a SKU is covered if it was generated from this recall, or if its UPC is printed in the notice.
const gt = new Map(readFileSync("data/synthetic/eval/ground_truth.csv", "utf8").trim().split("\n").slice(1).map((l) => { const [sku, rec] = l.split(","); return [sku, rec] as const; }));

const state = `state/eval-${tag}`;
rmSync(state, { recursive: true, force: true });
rmSync(`logs/eval/trace-eval-${tag}.jsonl`, { force: true });
const trace = new Trace({ dir: "logs/eval", quiet: true, runId: `eval-${tag}` });
const sql = new DuckSampleRunner({ trace });
const llm: LlmConfig = provider === "meterless" ? llmFromEnv({ ...process.env, LLM_PROVIDER: "meterless", METERLESS_MODEL: model }) : { provider, model, ollamaUrl: process.env.OLLAMA_URL };
const ctx = { sql, gen: makeGenerator(llm, trace), memory: new CaseMemory(trace, `${state}/hmem`), world: new World(trace, `${state}/world`), trace, model: `${provider}:${model}`, queueFile: `${state}/review-queue.json`,
  ...(mapModel ? { mapGen: makeGenerator(llmFromEnv({ ...process.env, LLM_PROVIDER: "meterless", METERLESS_MODEL: mapModel }), trace), mapModel: `meterless:${mapModel}` } : {}) };

const t0 = Date.now();
const startedAt = new Date().toISOString();
if (ablation === "no-cartographer") (ctx as { cartographer?: boolean }).cartographer = false;
else if (!ablation) (ctx as { map?: unknown }).map = await chart(ctx);
const found = await scout(ctx, { since });
const scanned = found.scanned, cases = only ? found.cases.filter((k) => only.includes(k.recall.id)) : found.cases;
const rows: { recall: string; sku: string; basis: string; label: "same" | "not-this"; final: string; rounds: number }[] = [];
let i = 0;
for (const k of cases) {
  const { finding, open, openSkus } = await adjudicate(ctx, k);
  for (const d of finding.decisions) {
    const cand = k.candidates.find((c) => c.sku.sku === d.sku)!;
    const label = gt.get(d.sku) === k.recall.number || (cand.sku.upc && k.recall.upcs.includes(cand.sku.upc)) ? "same" : "not-this";
    // An escalated case goes to a reviewer: its "same" calls and any pair still under objection are theirs.
    rows.push({ recall: k.recall.id, sku: d.sku, basis: d.basis, label, final: open.length && (d.verdict === "same" || openSkus.includes(d.sku)) ? "unsure" : d.verdict, rounds: finding.round });
  }
  if (++i % 20 === 0) console.error(`${i}/${cases.length} cases, ${Math.round((Date.now() - t0) / 1000)}s`);
}
await sql.close();

const m = (xs: typeof rows) => {
  const tp = xs.filter((r) => r.label === "same" && r.final === "same").length;
  const fp = xs.filter((r) => r.label === "not-this" && r.final === "same").length;
  const fn = xs.filter((r) => r.label === "same" && r.final === "not-this").length;
  const unsure = xs.filter((r) => r.final === "unsure").length;
  const pos = xs.filter((r) => r.label === "same").length;
  return { pairs: xs.length, positives: pos, caught: tp, falseAlarms: fp, wronglyDismissed: fn, toHuman: unsure,
    precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: pos ? +(tp / pos).toFixed(3) : null };
};
// Model calls that still failed after every retry fell back (judge → UNSURE, lots → regex); report them.
const events = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const calls = events.filter((e) => e.kind === "llm");
// Supplier barcode rules the Cartographer learned from cases the Auditor sent back.
const cartographerRules = events.flatMap((e) => (e.kind === "msg" && e.agent === "Cartographer" && Array.isArray(e.learned) ? e.learned : [])).map((r: { supplier: string; transform: string; rows: number; learnedFrom: string }) => ({ supplier: r.supplier, transform: r.transform, rows: r.rows, learnedFrom: r.learnedFrom }));
const modelCalls = llm.provider === "none" ? undefined : { total: calls.length, failedAfterRetries: calls.filter((e) => String(e.output ?? "").startsWith("ERROR")).length };
const out = { model: ctx.model, startedAt, since, scanned, cases: cases.length, seconds: Math.round((Date.now() - t0) / 1000),
  all: m(rows), textOnly: m(rows.filter((r) => r.basis === "text")), revisedCases: new Set(rows.filter((r) => r.rounds > 1).map((r) => r.recall)).size, modelCalls, cartographerRules };
mkdirSync("eval/results", { recursive: true });
writeFileSync(`eval/results/${tag}.json`, JSON.stringify({ ...out, rows }, null, 2));
console.log(JSON.stringify(out, null, 2));
