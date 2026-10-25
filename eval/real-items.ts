// Text matching on REAL product titles. The synthetic item master's covered titles were
// generated from the notice text, so a judge could match them by construction. Here the
// titles come from a real catalog (data/real/catalog.json, scripts/build-real-catalog.ts):
// USDA FoodData Central label descriptions and Open Food Facts names, found through the
// barcode the notice prints. The barcode is then hidden from the agents (stripped from the
// notice, not given on our item), so what is measured is the Investigator's judge + the
// Auditor's text checks on title vs notice alone. Same code path as production: decide /
// audit / revise. The barcode path (barcode visible, exact UPC join) is reported separately,
// since that is how the product actually finds these items.
//   npx tsx eval/real-items.ts [--provider meterless|none] [--model nvidia/nemotron-3-ultra-550b-a55b] [--catalog data/real/catalog.json]
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fromFda, type FdaRow, type Recall } from "../src/feeds.ts";
import { tokens, type Candidate, type Sku } from "../src/match.ts";
import { Trace } from "../src/trace.ts";
import { makeGenerator, llmFromEnv, type Generator, type LlmConfig } from "../src/llm.ts";
import { CaseMemory } from "../src/memory.ts";
import { World } from "../src/world.ts";
import { sqlId, type SqlRunner } from "../src/sql/types.ts";
import type { AgentContext } from "../src/agents/context.ts";
import type { Case } from "../src/agents/scout.ts";
import { decide, revise, type Finding, type MatchVerdict } from "../src/agents/investigator.ts";
import { audit } from "../src/agents/auditor.ts";
import type { RealCatalog, RealItem, RealNegative } from "../scripts/build-real-catalog.ts";

const MAX_REVISIONS = 2; // same as src/orchestrator.ts

export type PairKind = "positive" | "other-notice" | "same-brand";
export interface Pair { kind: PairKind; item: RealItem | RealNegative; recall: Recall; label: "same" | "not-this"; overlap: number }
export interface PairRow { kind: PairKind; id: string; source: string; title: string; brand: string; recall: string; firm: string; label: Pair["label"]; first: MatchVerdict; firstBy: string; final: MatchVerdict | "unsure"; rounds: number; critiques: string[]; quote?: string }

/** Every printed barcode (11–14 digits, with or without spaces/dashes) becomes "[barcode removed]". */
export function stripUpcs(text: string): string {
  return (text ?? "").replace(/(?<!\d)\d(?:[\d \-]{9,16})\d(?!\d)/g, (m) => (m.replace(/[ \-]/g, "").length >= 11 ? "[barcode removed]" : m))
    .replace(/\b(upc|gtin|barcode)s?\s*[:#]?\s*\[barcode removed\]/gi, "[barcode removed]");
}

/** The notice as the agents will see it: no barcode anywhere, nothing to join on but words. */
export function hideBarcodes(r: Recall): Recall {
  return { ...r, title: stripUpcs(r.title), text: stripUpcs(r.text), codeInfo: stripUpcs(r.codeInfo), upcs: [] };
}

/** Our item-master line for a real product: catalog title, the brand owner (or package brand) as vendor; the UPC only when the barcode path is being measured. */
export function skuFor(item: RealItem | RealNegative, withUpc = false): Sku {
  return { sku: item.id, upc: withUpc ? item.upc : "", title: item.title, brand: item.brand || "(unknown)", department: "grocery", supplier_id: "" };
}

const digitsIn = (s: string) => (s ?? "").replace(/[^0-9]/g, "");
const printsKey = (digits: string, key: string) => digits.includes(key) || (key.length === 12 && digits.includes(key.replace(/^0+/, "")));

/**
 * Pairs:
 *  - positive: one per (item, notice that prints its barcode);
 *  - other-notice: per item, the most similar OTHER notice (best token overlap of item title+brand
 *    with firm+product text, ties to the same firm); notices from the same FDA event or printing
 *    the same barcode are not negatives (they can be the same product under another recall number);
 *  - same-brand: a real product of the same brand owner (different product, never printed in any
 *    notice) against each notice that recalls its sibling.
 */
export function buildPairs(catalog: Pick<RealCatalog, "items" | "negatives">, rows: (FdaRow & { event_id?: string })[]): Pair[] {
  const recalls = rows.map((r) => ({ row: r, recall: fromFda(r), digits: digitsIn(`${r.product_description} ${r.code_info ?? ""} ${r.more_code_info ?? ""}`), words: new Set(tokens(`${r.recalling_firm} ${r.product_description}`)) }));
  const byNumber = new Map(recalls.map((x) => [x.row.recall_number, x]));
  const pairs: Pair[] = [];
  const homeOf = new Map<string, Recall[]>();
  for (const item of catalog.items) {
    const homes = item.recall_numbers.map((n) => byNumber.get(n)).filter((x): x is NonNullable<typeof x> => !!x);
    if (!homes.length) continue;
    const homeEvents = new Set(homes.map((h) => h.row.event_id).filter(Boolean));
    const itemWords = tokens(`${item.brand} ${item.title}`).filter((w) => !/\d/.test(w));
    const firmWords = new Set(homes.flatMap((h) => tokens(h.row.recalling_firm)));
    let best: { x: (typeof recalls)[number]; score: number } | undefined;
    const mine: Recall[] = [];
    for (const x of recalls) {
      const isPositive = item.recall_numbers.includes(x.row.recall_number) || printsKey(x.digits, item.upc);
      if (isPositive) { mine.push(x.recall); pairs.push({ kind: "positive", item, recall: x.recall, label: "same", overlap: itemWords.filter((w) => x.words.has(w)).length }); continue; }
      if (x.row.event_id && homeEvents.has(x.row.event_id)) continue;
      const overlap = itemWords.filter((w) => x.words.has(w)).length;
      const sameFirm = [...firmWords].some((w) => w.length > 3 && tokens(x.row.recalling_firm).includes(w)) ? 0.5 : 0;
      const score = overlap + sameFirm;
      if (!best || score > best.score) best = { x, score };
    }
    homeOf.set(item.id, mine);
    if (best && best.score > 0) pairs.push({ kind: "other-notice", item, recall: best.x.recall, label: "not-this", overlap: Math.floor(best.score) });
  }
  for (const n of catalog.negatives) {
    for (const r of homeOf.get(n.forItem) ?? []) {
      const x = byNumber.get(r.number)!;
      if (printsKey(x.digits, n.upc)) continue; // the notice prints this barcode too: not a negative
      pairs.push({ kind: "same-brand", item: n, recall: r, label: "not-this", overlap: tokens(n.title).filter((w) => x.words.has(w)).length });
    }
  }
  return pairs;
}

/** A SQL runner that answers every query with no rows: this eval has no inventory, lots or stores. */
function noRows(trace: Trace): SqlRunner {
  return { engine: "duckdb-sample", async run(sql, meta) { const id = sqlId(sql); trace.emit("sql", meta.agent, { sqlId: id, engine: "none", purpose: meta.purpose, rows: 0, ms: 0 }); return { sqlId: id, engine: "duckdb-sample", columns: [], rows: [], ms: 0 }; }, async close() {} };
}

export function makeCtx(gen: Generator, stateDir: string, model: string, trace = new Trace({ dir: `${stateDir}/logs`, quiet: true, runId: "real-items" })): AgentContext {
  return { sql: noRows(trace), gen, memory: new CaseMemory(trace, `${stateDir}/hmem`), world: new World(trace, `${stateDir}/world`), trace, model, cartographer: false, queueFile: `${stateDir}/review-queue.json` };
}

const rowOf = (p: Pair, recall: Recall, extra: Omit<PairRow, "kind" | "id" | "source" | "title" | "brand" | "recall" | "firm" | "label">): PairRow =>
  ({ kind: p.kind, id: p.item.id, source: "source" in p.item ? p.item.source : "fdc", title: p.item.title, brand: p.item.brand, recall: recall.id, firm: recall.firm, label: p.label, ...extra });

/** One pair through the production loop, barcode hidden: Investigator decides, Auditor checks, up to two revisions, else a reviewer. */
export async function judgePair(ctx: AgentContext, p: Pair): Promise<PairRow> {
  const recall = hideBarcodes(p.recall);
  const c: Candidate = { sku: skuFor(p.item), basis: "text", evidence: "", brandWords: [], kindWords: [] };
  const k: Case = { id: `real-${p.kind}-${p.item.id}-${recall.number}`, recall, recallEntity: "", candidates: [c] };
  const d0 = await decide(ctx, k, c);
  let f: Finding = { caseId: k.id, round: 1, decisions: [d0], recallLots: [], lotSources: {}, stores: [], verdict: "needs-human" };
  const critiques: string[] = [];
  for (;;) {
    const a = await audit(ctx, k, f);
    critiques.push(...a.critiques.map((x) => x.code));
    const d = f.decisions[0];
    if (a.ok) return rowOf(p, recall, { first: d0.verdict, firstBy: d0.decidedBy, final: d.verdict, rounds: f.round, critiques, quote: d.quote });
    if (f.round > MAX_REVISIONS) return rowOf(p, recall, { first: d0.verdict, firstBy: d0.decidedBy, final: "unsure", rounds: f.round, critiques, quote: d.quote });
    f = await revise(ctx, k, f, a.critiques);
  }
}

export interface BarcodeRow { kind: PairKind; id: string; upc: string; recall: string; label: Pair["label"]; basis: "upc" | "text"; verdict: MatchVerdict; decidedBy: string; digitsInNotice: boolean }

/**
 * The barcode path, as production runs it: the notice keeps its barcodes, our item carries its UPC.
 * A SKU whose UPC the Scout finds in the notice is a "upc" candidate, which the Investigator settles
 * by rule (no model call) and the Auditor re-checks against the notice's digits. Anything else is a
 * text candidate, which is what judgePair measures. No model is called here.
 */
export async function barcodePath(ctx: AgentContext, pairs: Pair[]): Promise<BarcodeRow[]> {
  const out: BarcodeRow[] = [];
  for (const p of pairs) {
    const sku = skuFor(p.item, true);
    const basis: Candidate["basis"] = sku.upc && p.recall.upcs.includes(sku.upc) ? "upc" : "text";
    const digitsInNotice = printsKey(digitsIn(`${p.recall.text} ${p.recall.codeInfo}`), sku.upc);
    if (basis === "text") { out.push({ kind: p.kind, id: p.item.id, upc: sku.upc, recall: p.recall.id, label: p.label, basis, verdict: "unsure", decidedBy: "none", digitsInNotice }); continue; }
    const c: Candidate = { sku, basis, evidence: sku.upc, brandWords: [], kindWords: [] };
    const k: Case = { id: `barcode-${p.kind}-${p.item.id}-${p.recall.number}`, recall: p.recall, recallEntity: "", candidates: [c] };
    const d = await decide(ctx, k, c);
    out.push({ kind: p.kind, id: p.item.id, upc: sku.upc, recall: p.recall.id, label: p.label, basis, verdict: d.verdict, decidedBy: d.decidedBy, digitsInNotice });
  }
  return out;
}

export const barcodeMetrics = (rows: BarcodeRow[]) => {
  const pos = rows.filter((r) => r.label === "same");
  const neg = rows.filter((r) => r.label === "not-this");
  return { positives: pos.length, settledByUpcRule: pos.filter((r) => r.basis === "upc" && r.verdict === "same" && r.decidedBy === "rule").length,
    settledAndAuditorDigitsAgree: pos.filter((r) => r.basis === "upc" && r.verdict === "same" && r.digitsInNotice).length,
    leftToText: pos.filter((r) => r.basis === "text").length, negatives: neg.length, negativesSettledSame: neg.filter((r) => r.verdict === "same").length };
};

export const metrics = (rows: PairRow[], at: "first" | "final") => {
  const v = (r: PairRow) => r[at];
  const pos = rows.filter((r) => r.label === "same");
  const neg = rows.filter((r) => r.label === "not-this");
  const fa = (kind: PairKind) => neg.filter((r) => r.kind === kind && v(r) === "same").length;
  return { pairs: rows.length, positives: pos.length, negatives: neg.length,
    caught: pos.filter((r) => v(r) === "same").length, wronglyDismissed: pos.filter((r) => v(r) === "not-this").length,
    falseAlarms: neg.filter((r) => v(r) === "same").length, falseAlarmsOtherNotice: fa("other-notice"), falseAlarmsSameBrand: fa("same-brand"),
    correctlyDismissed: neg.filter((r) => v(r) === "not-this").length,
    toHuman: rows.filter((r) => v(r) === "unsure").length, positivesToHuman: pos.filter((r) => v(r) === "unsure").length };
};

async function main() {
  const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const provider = arg("provider", "meterless") as LlmConfig["provider"];
  const model = arg("model", provider === "meterless" ? (process.env.METERLESS_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b") : "none")!;
  const tag = `real-items-${model}`.replace(/[^a-z0-9.-]+/gi, "_");
  const catalog = JSON.parse(readFileSync(arg("catalog", "data/real/catalog.json")!, "utf8")) as RealCatalog;
  const feed = JSON.parse(readFileSync("sample/fda_food_enforcement.json", "utf8")) as { results: (FdaRow & { event_id?: string })[] };
  const pairs = buildPairs(catalog, feed.results);
  const llm: LlmConfig = provider === "meterless" ? llmFromEnv({ ...process.env, LLM_PROVIDER: "meterless", METERLESS_MODEL: model }) : { provider, model, ollamaUrl: process.env.OLLAMA_URL };
  const state = `state/eval-${tag}`;
  rmSync(state, { recursive: true, force: true });
  const trace = new Trace({ dir: "logs/eval", quiet: true, runId: `eval-${tag}` });
  rmSync(trace.file, { force: true });
  const ctx = makeCtx(makeGenerator(llm, trace), state, `${provider}:${model}`, trace);
  const t0 = Date.now();
  const barcode = await barcodePath(makeCtx(ctx.gen, `${state}/barcode`, ctx.model, trace), pairs);
  const rows: PairRow[] = [];
  for (const [i, p] of pairs.entries()) {
    rows.push(await judgePair(ctx, p));
    if ((i + 1) % 10 === 0) console.error(`${i + 1}/${pairs.length} pairs, ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  const events = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const calls = events.filter((e) => e.kind === "llm");
  const bySource = (src: string) => metrics(rows.filter((r) => r.label !== "same" || r.source === src), "final");
  const out = { model: ctx.model, startedAt: new Date(t0).toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    catalog: { ...catalog.counts, builtAt: catalog.builtAt }, pairs: pairs.length, pairKinds: { positive: pairs.filter((p) => p.kind === "positive").length, otherNotice: pairs.filter((p) => p.kind === "other-notice").length, sameBrand: pairs.filter((p) => p.kind === "same-brand").length },
    barcodePath: barcodeMetrics(barcode),
    judgeFirstAnswer: metrics(rows, "first"), afterAuditor: metrics(rows, "final"),
    afterAuditorBySource: { fdc: { caught: bySource("fdc").caught, positives: bySource("fdc").positives, wronglyDismissed: bySource("fdc").wronglyDismissed }, off: { caught: bySource("off").caught, positives: bySource("off").positives, wronglyDismissed: bySource("off").wronglyDismissed } },
    ruledWithoutJudge: rows.filter((r) => r.firstBy === "rule").length, revisedPairs: rows.filter((r) => r.rounds > 1).length,
    modelCalls: llm.provider === "none" ? undefined : { total: calls.length, failedAfterRetries: calls.filter((e) => String(e.output ?? "").startsWith("ERROR")).length },
    critiqueCounts: rows.flatMap((r) => r.critiques).reduce<Record<string, number>>((a, c) => ((a[c] = (a[c] ?? 0) + 1), a), {}) };
  mkdirSync("eval/results", { recursive: true });
  writeFileSync(`eval/results/${tag}.json`, JSON.stringify({ ...out, rows, barcodeRows: barcode }, null, 2));
  console.log(JSON.stringify(out, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
