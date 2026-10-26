// Investigator: decides which candidate SKUs a recall really covers, which of our
// lots are affected, and what the exposure is — every number tied to the SQL that
// produced it. It can be sent back by the Auditor with critiques.
import { detectInjection } from "../guard.ts";
import { lotAppears, lotsFromCodeInfo, type Recall } from "../feeds.ts";
import { designatorConflict, type Candidate } from "../match.ts";
import { inList, lit, say, type AgentContext } from "./context.ts";
import type { Case } from "./scout.ts";
import { decisionNote } from "../memory.ts";

export type MatchVerdict = "same" | "not-this" | "unsure";
export interface MatchDecision {
  sku: string; title: string; basis: Candidate["basis"]; verdict: MatchVerdict;
  why: string; quote?: string; decidedBy: "rule" | "judge" | "human-memory" | "agent-memory"; memoryId?: string;
}
export interface StoreExposure { store_id: string; state: string; on_hand: number; lots: string[] }
export interface Numbers {
  storesWithStock: number; onHandUnits: number; unitsSoldSince: number; loyaltyCustomers: number;
  affectedLots: string[]; lotRule: "listed-lots" | "all-lots" | "no-matching-lots";
  outsideDistribution: string[]; supplier?: string; sql: Record<string, string>;
}
export interface Finding {
  caseId: string; round: number; decisions: MatchDecision[]; recallLots: string[];
  lotSources: Record<string, "regex" | "model">; numbers?: Numbers; stores: StoreExposure[];
  verdict: "act-now" | "notify" | "no-exposure" | "not-ours" | "needs-human";
}
export interface Critique { code: "ungrounded-quote" | "lot-not-in-notice" | "number-mismatch" | "upc-not-in-notice" | "model-not-in-notice" | "designator-conflict" | "item-word-missing" | "only-an-ingredient" | "size-not-in-notice" | "supplier-barcode-mismatch" | "dismissal-names-our-item" | "dismissal-same-line"; sku?: string; lot?: string; detail: string }

const JUDGE_SYSTEM = "You check a retailer's item-master line against a U.S. federal recall notice. You answer on ONE line and you copy words from the notice exactly.";

function judgePrompt(r: Recall, c: Candidate, memories: string[], strict?: string) {
  return [
    `RECALL NOTICE (${r.id}, firm: ${r.firm}):`, r.text.slice(0, 1400), "",
    // The item master's "brand" column holds the vendor we buy from (taken from the firm name),
    // which is often the manufacturer or distributor rather than the brand printed on the package.
    `OUR ITEM: ${c.sku.sku} | vendor ${c.sku.brand} | ${c.sku.title} | dept ${c.sku.department}${c.sku.upc ? ` | UPC ${c.sku.upc}` : ""}`,
    "(The vendor is the firm we buy from; it can be the manufacturer or distributor, not the brand on the package. Item-master titles are abbreviated and cut off, so a missing word is not a difference.)",
    memories.length ? `\nPAST DECISIONS THAT MAY BE RELEVANT:\n${memories.map((m) => "- " + m).join("\n")}` : "",
    "", "Is our item the product this notice recalls? It must be the same product from the same firm or brand AND the same product variety: a different flavor, variety, model or product line of the same brand is DIFFERENT, and so is a different package size or a product that merely contains our item as an ingredient.",
    "Reply exactly one of:", "SAME: <words copied from the notice that name our product>",
    "DIFFERENT: <words copied from the notice that name what IS recalled>", "UNSURE: <short reason>",
    strict ? `\nYour previous answer was rejected: ${strict}. Copy the words verbatim from the notice.` : "",
  ].join("\n");
}

export function parseJudge(text: string): { label: "SAME" | "DIFFERENT" | "UNSURE"; quote: string } | undefined {
  const m = text.replace(/[*`]/g, "").match(/\b(SAME|DIFFERENT|UNSURE)\b\s*[:\-–]\s*(.+)/i);
  if (!m) { const b = text.match(/\b(SAME|DIFFERENT|UNSURE)\b/i); return b ? { label: b[1].toUpperCase() as "SAME", quote: "" } : undefined; }
  return { label: m[1].toUpperCase() as "SAME" | "DIFFERENT" | "UNSURE", quote: m[2].trim().split("\n")[0].replace(/^["']|["']$/g, "").slice(0, 240) };
}

async function judge(ctx: AgentContext, k: Case, c: Candidate, strict?: string): Promise<MatchDecision> {
  const base = { sku: c.sku.sku, title: c.sku.title, basis: c.basis };
  // Scout Intent guard: a notice that carries instructions for a model is not sent to the judge.
  const g = detectInjection(`${k.recall.text}\n${k.recall.codeInfo}`);
  if (g.flagged) {
    ctx.trace.emit("guard", "Investigator", { caseId: k.id, sku: c.sku.sku, cls: g.cls, match: g.match });
    return { ...base, verdict: "unsure", why: `the notice text carries instructions for a model (${g.cls}: "${g.match}"), so it is not sent to the judge; a reviewer decides`, decidedBy: "rule" };
  }
  const similar = ctx.memory.similar(`${k.recall.firm} ${c.sku.title}`, "Investigator", 3).map((m) => m.content);
  const out = await ctx.gen(judgePrompt(k.recall, c, similar, strict), { agent: "Investigator", purpose: `judge ${c.sku.sku} vs ${k.recall.id}`, system: JUDGE_SYSTEM, maxTokens: 120 }).catch((e) => (/no model configured/.test(e.message) ? "UNSURE: no model is configured, so a reviewer decides this text match" : `UNSURE: the model call failed (${e.message.slice(0, 80)}), so a reviewer decides`));
  const a = parseJudge(out);
  if (!a) return { ...base, verdict: "unsure", why: "judge gave no usable answer", decidedBy: "judge" };
  const verdict: MatchVerdict = a.label === "SAME" ? "same" : a.label === "DIFFERENT" ? "not-this" : "unsure";
  return { ...base, verdict, quote: a.quote, why: a.label === "SAME" ? `notice names "${a.quote}"` : a.label === "DIFFERENT" ? `notice is about "${a.quote}"` : a.quote, decidedBy: "judge" };
}

export async function decide(ctx: AgentContext, k: Case, c: Candidate): Promise<MatchDecision> {
  const base = { sku: c.sku.sku, title: c.sku.title, basis: c.basis };
  const prior = ctx.memory.priorDecisions(k.recall.id, c.sku.sku, "Investigator");
  const human = prior.find((m) => m.tags.includes("by:human"));
  if (human) {
    const v = (human.tags.find((t) => t.startsWith("verdict:"))?.slice(8) ?? "unsure") as MatchVerdict;
    say(ctx, "Investigator", "Orchestrator", `${c.sku.sku}: following human decision ${human.id} (${v})`);
    const note = decisionNote(human.content);
    return { ...base, verdict: v, why: `a reviewer decided ${v === "same" ? "it is this product" : "it is not this product"}${note ? `: ${note}` : ""}`, decidedBy: "human-memory", memoryId: human.id };
  }
  // An earlier run's audited decision on this exact pair is reused (no new model call);
  // the Auditor still re-checks it against the notice.
  const earlier = prior.find((m) => m.tags.includes("by:agent") && !m.tags.includes("verdict:unsure"));
  if (earlier && c.basis === "text") {
    const v = (earlier.tags.find((t) => t.startsWith("verdict:"))?.slice(8) ?? "unsure") as MatchVerdict;
    const quote = earlier.content.match(/"([^"]+)"/)?.[1];
    say(ctx, "Investigator", "Orchestrator", `${c.sku.sku}: reusing decision ${earlier.id} from ${earlier.source} (${v})`);
    return { ...base, verdict: v, quote, why: `earlier run decided: ${earlier.content.replace(/^.*?: /, "")}`, decidedBy: "agent-memory", memoryId: earlier.id };
  }
  if (c.basis === "upc") return { ...base, verdict: "same", why: `our UPC ${c.evidence} is printed in the notice`, decidedBy: "rule" };
  if (c.basis === "model") return { ...base, verdict: "same", why: `model ${c.evidence} from the notice is in our item title`, decidedBy: "rule" };
  const conflict = designatorConflict(c, k.recall);
  if (conflict) return { ...base, verdict: "not-this", why: conflict, decidedBy: "rule" };
  return judge(ctx, k, c);
}

async function readLots(ctx: AgentContext, r: Recall): Promise<{ lots: string[]; sources: Record<string, "regex" | "model"> }> {
  const sources: Record<string, "regex" | "model"> = {};
  for (const l of lotsFromCodeInfo(r.codeInfo)) sources[l] = "regex";
  const messy = r.feed === "fda_food" && r.codeInfo.length > 12 && !/no lot codes?/i.test(r.codeInfo) && !detectInjection(r.codeInfo).flagged;
  if (messy) {
    const out = await ctx.gen(
      `Text from a food recall notice:\n"""${r.codeInfo.slice(0, 1500)}"""\n\nList every lot code or batch code in it as a JSON array of strings, copied exactly. Do not include dates, best-by dates, UPC numbers or product names. If there are none, answer [].`,
      { agent: "Investigator", purpose: `read lot codes ${r.id}`, maxTokens: 400 }).catch(() => "[]");
    const m = out.match(/\[[\s\S]*?\]/);
    const dates: string[] = [];
    try { for (const l of JSON.parse(m?.[0] ?? "[]") as unknown[]) if (typeof l === "string" && l.trim()) { if (isDateLike(l)) dates.push(l.trim()); else sources[l.trim()] ??= "model"; } } catch { /* model gave no JSON: regex lots only */ }
    // A date is not a lot code (expiration and best-by dates sit next to lots in code_info): reading one as a
    // lot would narrow the recall to "lots" we never hold and clear stock that is recalled.
    if (dates.length) ctx.trace.emit("critique", "Auditor", { caseId: `case-${r.id.replace(":", "-")}`, code: "lot-is-a-date", detail: `the model read ${dates.length} date(s) as lot codes (${dates.slice(0, 4).join(", ")}); dropped` });
  }
  return { lots: Object.keys(sources), sources };
}

/** True for a date written the ways recall notices write them (9/4/26, 2026-09-04, Sep 4 2026, 04SEP2026, 09/2026). */
export function isDateLike(v: string): boolean {
  const t = v.trim();
  return /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(t) || /^\d{4}[/.-]\d{1,2}[/.-]\d{1,2}$/.test(t) || /^\d{1,2}[/.-]\d{4}$/.test(t)
    || /^(\d{1,2}\s*)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{1,2}?,?\s*\d{2,4}$/i.test(t) || /^\d{1,2}(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\d{2,4}$/i.test(t);
}

/** Exposure for the SKUs we believe are covered. One query per source, all through the SQL runner. */
async function exposure(ctx: AgentContext, k: Case, skus: string[], recallLots: string[]): Promise<{ numbers: Numbers; stores: StoreExposure[] }> {
  const inv = await ctx.sql.run(
    `SELECT i.store_id, st.state, i.sku, i.lot_code, SUM(i.on_hand) AS on_hand
     FROM erp.inventory i JOIN erp.stores st ON st.store_id = i.store_id
     WHERE i.sku IN (${inList(skus)}) GROUP BY i.store_id, st.state, i.sku, i.lot_code`,
    { agent: "Investigator", purpose: `on-hand by store and lot for ${skus.join(",")}` });
  const asn = await ctx.sql.run(
    `SELECT a.sku, a.lot_code, a.dc_state, SUM(a.units) AS shipped_units, MAX(p.name) AS supplier
     FROM supplier_portal.ship_notices a JOIN supplier_portal.suppliers p ON p.supplier_id = a.supplier_id
     JOIN erp.skus s ON s.sku = a.sku
     WHERE a.sku IN (${inList(skus)}) GROUP BY a.sku, a.lot_code, a.dc_state`,
    { agent: "Investigator", purpose: `supplier ship notices x ERP for ${skus.join(",")}` });
  const ourLots = new Set([...inv.rows, ...asn.rows].map((r) => String(r.lot_code)));
  let lotRule: Numbers["lotRule"];
  let affected: string[];
  if (!recallLots.length) { lotRule = "all-lots"; affected = [...ourLots]; }
  else { affected = [...ourLots].filter((l) => recallLots.some((x) => x.toUpperCase() === l.toUpperCase())); lotRule = affected.length ? "listed-lots" : "no-matching-lots"; }
  const aff = new Set(affected);
  const sales = affected.length ? await ctx.sql.run(
    `SELECT store_id, lot_code, SUM(units) AS units, SUM(loyalty_customers) AS customers
     FROM erp.sales WHERE sku IN (${inList(skus)}) AND lot_code IN (${inList(affected)}) AND sold_on >= CAST(${lit(k.recall.date || "2026-01-01")} AS DATE)
     GROUP BY store_id, lot_code`,
    { agent: "Investigator", purpose: `units sold since ${k.recall.date} in affected lots` }) : undefined;

  const byStore = new Map<string, StoreExposure>();
  for (const r of inv.rows) {
    if (!aff.has(String(r.lot_code)) || Number(r.on_hand) <= 0) continue;
    const s = byStore.get(String(r.store_id)) ?? { store_id: String(r.store_id), state: String(r.state), on_hand: 0, lots: [] };
    s.on_hand += Number(r.on_hand); if (!s.lots.includes(String(r.lot_code))) s.lots.push(String(r.lot_code));
    byStore.set(s.store_id, s);
  }
  const stores = [...byStore.values()].sort((a, b) => b.on_hand - a.on_hand);
  const states = k.recall.states;
  const ourStates = [...new Set(stores.map((s) => s.state))];
  const outsideDistribution = Array.isArray(states) ? ourStates.filter((s) => !states.includes(s)) : [];
  const numbers: Numbers = {
    storesWithStock: stores.length,
    onHandUnits: stores.reduce((a, s) => a + s.on_hand, 0),
    unitsSoldSince: (sales?.rows ?? []).reduce((a, r) => a + Number(r.units), 0),
    loyaltyCustomers: (sales?.rows ?? []).reduce((a, r) => a + Number(r.customers), 0),
    affectedLots: affected.sort(), lotRule, outsideDistribution,
    supplier: asn.rows[0]?.supplier ? String(asn.rows[0].supplier) : undefined,
    sql: { inventory: inv.sqlId, shipNotices: asn.sqlId, ...(sales ? { sales: sales.sqlId } : {}) },
  };
  return { numbers, stores };
}

function verdictOf(decisions: MatchDecision[], n?: Numbers): Finding["verdict"] {
  if (!decisions.some((d) => d.verdict === "same")) return decisions.some((d) => d.verdict === "unsure") ? "needs-human" : "not-ours";
  if (!n) return "needs-human";
  if (n.onHandUnits > 0) return "act-now";
  if (n.unitsSoldSince > 0) return "notify";
  return "no-exposure";
}

export async function investigate(ctx: AgentContext, k: Case): Promise<Finding> {
  say(ctx, "Investigator", "Orchestrator", `opening ${k.id}: ${k.candidates.length} candidate SKU(s) for ${k.recall.id}`);
  const decisions: MatchDecision[] = [];
  for (const c of k.candidates) decisions.push(await decide(ctx, k, c));
  const { lots, sources } = await readLots(ctx, k.recall);
  return finish(ctx, k, { caseId: k.id, round: 1, decisions, recallLots: lots, lotSources: sources, stores: [], verdict: "needs-human" });
}

async function finish(ctx: AgentContext, k: Case, f: Finding): Promise<Finding> {
  const covered = f.decisions.filter((d) => d.verdict === "same").map((d) => d.sku);
  if (covered.length) { const e = await exposure(ctx, k, covered, f.recallLots); f.numbers = e.numbers; f.stores = e.stores; }
  else { f.numbers = undefined; f.stores = []; }
  f.verdict = verdictOf(f.decisions, f.numbers);
  say(ctx, "Investigator", "Auditor", `${k.id} round ${f.round}: ${f.verdict}${f.numbers ? ` — ${f.numbers.onHandUnits} units on hand in ${f.numbers.storesWithStock} stores, ${f.numbers.unitsSoldSince} sold since ${k.recall.date}` : ""}`, { finding: summary(f) });
  return f;
}

/** Address the Auditor's critiques, then recompute. */
export async function revise(ctx: AgentContext, k: Case, f: Finding, critiques: Critique[]): Promise<Finding> {
  const next: Finding = { ...f, round: f.round + 1, decisions: [...f.decisions], recallLots: [...f.recallLots], lotSources: { ...f.lotSources } };
  for (const c of critiques) {
    if (c.code === "lot-not-in-notice" && c.lot) { next.recallLots = next.recallLots.filter((l) => l !== c.lot); delete next.lotSources[c.lot]; }
    if ((c.code === "ungrounded-quote" || c.code === "item-word-missing" || c.code === "only-an-ingredient" || c.code === "size-not-in-notice" || c.code === "dismissal-names-our-item") && c.sku) {
      const cand = k.candidates.find((x) => x.sku.sku === c.sku)!;
      const i = next.decisions.findIndex((d) => d.sku === c.sku);
      next.decisions[i] = await judge(ctx, k, cand, c.detail);
    }
    if ((c.code === "upc-not-in-notice" || c.code === "model-not-in-notice" || c.code === "designator-conflict" || c.code === "dismissal-same-line") && c.sku) {
      const i = next.decisions.findIndex((d) => d.sku === c.sku);
      next.decisions[i] = { ...next.decisions[i], verdict: "unsure", why: `Auditor: ${c.detail}` };
    }
  }
  say(ctx, "Investigator", "Auditor", `revised ${k.id} after ${critiques.length} critique(s): ${critiques.map((c) => c.code).join(", ")}`);
  return finish(ctx, k, next);
}

export const summary = (f: Finding) => ({
  verdict: f.verdict, round: f.round,
  decisions: f.decisions.map((d) => `${d.sku} ${d.verdict} (${d.decidedBy}/${d.basis}): ${d.why}`.slice(0, 200)),
  recallLots: f.recallLots.slice(0, 20), numbers: f.numbers,
});

export { lotAppears };
