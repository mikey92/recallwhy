// Baseline: the same model without the agents. For every case eval/run.ts scores (same Scout, same sample data,
// same 322 recall/SKU pairs), one prompt to Nemotron 3 Ultra through Nightshift with the whole notice and every
// candidate item, asking for a verdict per item. No Auditor, no Cartographer, no memory, no revision loop, no
// rules: the model alone decides, and may answer UNSURE (counted as "sent to a person", as for the agents).
//   npx tsx eval/one-prompt.ts [--since 2026-07-01] [--model nvidia/nemotron-3-ultra-550b-a55b]
//   → eval/results/one-prompt-<model>.json, compared pair by pair with the agents' committed run
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { Trace } from "../src/trace.ts";
import { DuckSampleRunner } from "../src/sql/duck.ts";
import { makeGenerator, llmFromEnv } from "../src/llm.ts";
import { CaseMemory } from "../src/memory.ts";
import { World } from "../src/world.ts";
import { scout, type Case } from "../src/agents/scout.ts";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const model = arg("model", "nvidia/nemotron-3-ultra-550b-a55b")!;
const since = arg("since", "2026-07-01")!;
const only = arg("recalls")?.split(",");
const tag = `one-prompt-${model}${only ? "-subset" : ""}`.replace(/[^a-z0-9.-]+/gi, "_");

export function prompt(k: Case): string {
  const r = k.recall;
  return [
    "You are a retailer's product-safety analyst. A recall notice and the items in our catalog that might be the recalled product are below.",
    "For EVERY item, decide whether it is the product the notice recalls (the same product, not another flavour, size or line of the same brand).",
    "",
    `RECALL NOTICE ${r.id} (${r.firm})`,
    `Product: ${r.text}`,
    `Reason: ${r.reason}`,
    `Codes / models: ${r.codeInfo || "(none)"}`,
    `Barcodes printed in the notice: ${r.upcs.join(", ") || "(none)"}`,
    "",
    "OUR ITEMS",
    ...k.candidates.map((c) => `${c.sku.sku} | UPC ${c.sku.upc || "(none)"} | ${c.sku.brand} | ${c.sku.title}`),
    "",
    "Answer one line per item, nothing else: <SKU> SAME, <SKU> NOT, or <SKU> UNSURE (if you cannot tell).",
  ].join("\n");
}

export function parse(out: string, skus: string[]): Map<string, "same" | "not-this" | "unsure"> {
  const res = new Map<string, "same" | "not-this" | "unsure">();
  for (const s of skus) {
    const m = out.match(new RegExp(`${s}\\W+(SAME|NOT|UNSURE)`, "i"));
    res.set(s, !m ? "unsure" : m[1].toUpperCase() === "SAME" ? "same" : m[1].toUpperCase() === "NOT" ? "not-this" : "unsure");
  }
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const gt = new Map(readFileSync("data/synthetic/eval/ground_truth.csv", "utf8").trim().split("\n").slice(1).map((l) => { const [sku, rec] = l.split(","); return [sku, rec] as const; }));
  const state = `state/eval-${tag}`;
  rmSync(state, { recursive: true, force: true });
  rmSync(`logs/eval/trace-eval-${tag}.jsonl`, { force: true });
  const trace = new Trace({ dir: "logs/eval", quiet: true, runId: `eval-${tag}` });
  const sql = new DuckSampleRunner({ trace });
  const gen = makeGenerator(llmFromEnv({ ...process.env, LLM_PROVIDER: "meterless", METERLESS_MODEL: model, METERLESS_FAST_MODEL: "" }), trace);
  const ctx = { sql, gen, memory: new CaseMemory(trace, `${state}/hmem`), world: new World(trace, `${state}/world`), trace, model: `meterless:${model}` } as never;
  const t0 = Date.now();
  const found = await scout(ctx, { since });
  const cases = only ? found.cases.filter((k) => only.includes(k.recall.id)) : found.cases;
  const rows: { recall: string; sku: string; basis: string; label: "same" | "not-this"; final: string; agents?: string }[] = [];
  const agents = new Map((JSON.parse(readFileSync("eval/results/meterless-nvidia_nemotron-3-ultra-550b-a55b.json", "utf8")).rows as { recall: string; sku: string; final: string }[]).map((r) => [`${r.recall}|${r.sku}`, r.final]));
  let i = 0, unparsed = 0;
  for (const k of cases) {
    const out = await (gen as (p: string, o: { purpose: string; agent: string; maxTokens?: number }) => Promise<string>)(prompt(k), { purpose: `judge one-prompt baseline ${k.recall.id}`, agent: "Baseline", maxTokens: 600 }).catch(() => "");
    const skus = k.candidates.map((c) => c.sku.sku);
    const v = parse(out, skus);
    unparsed += skus.filter((s) => !new RegExp(`${s}\\W+(SAME|NOT|UNSURE)`, "i").test(out)).length;
    for (const c of k.candidates) {
      const label = (gt.get(c.sku.sku) ?? "").split("|").includes(k.recall.number) || (c.sku.upc && k.recall.upcs.includes(c.sku.upc)) ? "same" : "not-this";
      rows.push({ recall: k.recall.id, sku: c.sku.sku, basis: c.basis, label, final: v.get(c.sku.sku)!, agents: agents.get(`${k.recall.id}|${c.sku.sku}`) });
    }
    if (++i % 20 === 0) console.error(`${i}/${cases.length} cases, ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  await sql.close();
  const m = (xs: typeof rows, f: (r: (typeof rows)[number]) => string | undefined) => ({
    pairs: xs.length, positives: xs.filter((r) => r.label === "same").length,
    caught: xs.filter((r) => r.label === "same" && f(r) === "same").length,
    wronglyDismissed: xs.filter((r) => r.label === "same" && f(r) === "not-this").length,
    falseAlarms: xs.filter((r) => r.label === "not-this" && f(r) === "same").length,
    toHuman: xs.filter((r) => f(r) === "unsure").length,
  });
  const events = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "llm");
  const out = {
    note: "One prompt per case to the same model (notice + every candidate item), no agents; scored on the same pairs as eval/run.ts, next to the agents' committed run.",
    model, since, cases: cases.length, seconds: Math.round((Date.now() - t0) / 1000),
    onePrompt: m(rows, (r) => r.final), agents: m(rows, (r) => r.agents),
    onePromptText: m(rows.filter((r) => r.basis === "text"), (r) => r.final), agentsText: m(rows.filter((r) => r.basis === "text"), (r) => r.agents),
    unparsedVerdicts: unparsed,
    modelCalls: { total: events.length, failedAfterRetries: events.filter((e) => String(e.output ?? "").startsWith("ERROR")).length },
    rows,
  };
  mkdirSync("eval/results", { recursive: true });
  writeFileSync(`eval/results/${tag}.json`, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify({ onePrompt: out.onePrompt, agents: out.agents, unparsed, calls: out.modelCalls }));
}
