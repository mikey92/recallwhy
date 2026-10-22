// Auditor: has authority to block. It never trusts the Investigator's numbers or
// quotes: it re-checks evidence against the live notice text and re-derives the
// exposure numbers with its own SQL, written differently.
import { lotAppears } from "../feeds.ts";
import { designatorConflict, grounded, modelsInText, tokens } from "../match.ts";
import { inList, lit, say, type AgentContext } from "./context.ts";
import type { Critique, Finding } from "./investigator.ts";
import type { Case } from "./scout.ts";

export interface Audit { ok: boolean; critiques: Critique[]; checks: string[] }

export async function audit(ctx: AgentContext, k: Case, f: Finding): Promise<Audit> {
  const critiques: Critique[] = [];
  const checks: string[] = [];
  const r = k.recall;

  for (const d of f.decisions) {
    const cand = k.candidates.find((c) => c.sku.sku === d.sku)!;
    if (d.decidedBy === "human-memory") { checks.push(`${d.sku}: human decision ${d.memoryId} respected`); continue; }
    if (d.verdict === "same" && d.basis === "upc") {
      // Ask the live feed itself (through Zetaris), not the Investigator's parse.
      const q = r.feed === "fda_food"
        ? `SELECT COUNT(*) AS n FROM recallfeeds.fda_food WHERE recall_number = ${lit(r.number)} AND regexp_replace(concat(product_description, ' ', code_info, ' ', coalesce(more_code_info, '')), '[^0-9]', '') LIKE ${lit("%" + cand.sku.upc + "%")}`
        : `SELECT COUNT(*) AS n FROM recallfeeds.cpsc_recalls WHERE recall_number = ${lit(r.number)} AND regexp_replace(concat(upcs, ' ', description), '[^0-9]', '') LIKE ${lit("%" + cand.sku.upc + "%")}`;
      const res = await ctx.sql.run(q, { agent: "Auditor", purpose: `re-check UPC ${cand.sku.upc} in live notice ${r.id}` });
      if (Number(res.rows[0]?.n ?? 0) > 0) checks.push(`${d.sku}: UPC found in live notice (${res.sqlId})`);
      else critiques.push({ code: "upc-not-in-notice", sku: d.sku, detail: `UPC ${cand.sku.upc} not found in notice ${r.id} (${res.sqlId})` });
    }
    if (d.verdict === "same" && d.basis === "model") {
      if (modelsInText(r).some((m) => m.replace(/[^A-Z0-9]/g, "") === cand.evidence)) checks.push(`${d.sku}: model ${cand.evidence} is in the notice`);
      else critiques.push({ code: "model-not-in-notice", sku: d.sku, detail: `model ${cand.evidence} not in notice` });
    }
    if (d.decidedBy === "judge" && d.verdict !== "unsure") {
      if (!d.quote || !grounded(d.quote, r)) critiques.push({ code: "ungrounded-quote", sku: d.sku, detail: `quote "${d.quote ?? ""}" is not in the notice text` });
      else checks.push(`${d.sku}: judge quote is grounded in the notice`);
      // A grounded quote can still describe a different variety: every product word of our
      // item title must appear somewhere in the notice.
      if (d.verdict === "same") {
        const notice = new Set(tokens(`${r.firm} ${r.title} ${r.text} ${r.codeInfo}`));
        const brand = new Set(tokens(cand.sku.brand));
        const missing = tokens(cand.sku.title).filter((w) => !brand.has(w) && !/\d/.test(w) && w.length > 2 && !notice.has(w));
        if (missing.length) critiques.push({ code: "item-word-missing", sku: d.sku, detail: `our item "${cand.sku.title}" says ${missing.map((w) => `"${w}"`).join(", ")}, which the notice never mentions` });
        else checks.push(`${d.sku}: every product word of our item appears in the notice`);
      }
      const conflict = d.verdict === "same" ? designatorConflict(cand, r) : undefined;
      if (conflict) critiques.push({ code: "designator-conflict", sku: d.sku, detail: conflict });
    }
  }

  for (const lot of f.recallLots) {
    if (!lotAppears(lot, r.codeInfo)) critiques.push({ code: "lot-not-in-notice", lot, detail: `lot "${lot}" (${f.lotSources[lot]}) does not appear in the notice's code_info` });
  }
  if (f.recallLots.length) checks.push(`${f.recallLots.length - critiques.filter((c) => c.code === "lot-not-in-notice").length}/${f.recallLots.length} lot codes appear verbatim in code_info`);

  const n = f.numbers;
  if (n && n.affectedLots.length) {
    const skus = f.decisions.filter((d) => d.verdict === "same").map((d) => d.sku);
    // Independent derivation: aggregate in SQL (the Investigator summed per-store rows in code).
    const onHand = await ctx.sql.run(
      `SELECT COUNT(DISTINCT store_id) AS stores, SUM(on_hand) AS on_hand FROM erp.inventory
       WHERE sku IN (${inList(skus)}) AND lot_code IN (${inList(n.affectedLots)}) AND on_hand > 0`,
      { agent: "Auditor", purpose: "re-derive on-hand units and store count" });
    const sold = await ctx.sql.run(
      `SELECT COALESCE(SUM(units), 0) AS units, COALESCE(SUM(loyalty_customers), 0) AS customers FROM erp.sales
       WHERE sku IN (${inList(skus)}) AND lot_code IN (${inList(n.affectedLots)}) AND sold_on >= CAST(${lit(r.date || "2026-01-01")} AS DATE)`,
      { agent: "Auditor", purpose: "re-derive units sold and loyalty customers" });
    const a = { stores: Number(onHand.rows[0]?.stores ?? 0), onHand: Number(onHand.rows[0]?.on_hand ?? 0), units: Number(sold.rows[0]?.units ?? 0), customers: Number(sold.rows[0]?.customers ?? 0) };
    const pairs: [string, number, number][] = [["stores with stock", n.storesWithStock, a.stores], ["units on hand", n.onHandUnits, a.onHand], ["units sold", n.unitsSoldSince, a.units], ["loyalty customers", n.loyaltyCustomers, a.customers]];
    for (const [label, mine, theirs] of pairs) {
      if (mine !== theirs) critiques.push({ code: "number-mismatch", detail: `${label}: Investigator ${mine}, Auditor ${theirs} (${onHand.sqlId}/${sold.sqlId})` });
    }
    if (pairs.every(([, x, y]) => x === y)) checks.push(`exposure numbers re-derived independently and match (${onHand.sqlId}, ${sold.sqlId})`);
    // Cross-source: did the supplier actually ship these lots to us?
    const shipped = await ctx.sql.run(
      `SELECT COUNT(DISTINCT lot_code) AS lots FROM supplier_portal.ship_notices WHERE sku IN (${inList(skus)}) AND lot_code IN (${inList(n.affectedLots)})`,
      { agent: "Auditor", purpose: "supplier portal confirms affected lots were shipped to us" });
    checks.push(`supplier ship notices cover ${shipped.rows[0]?.lots ?? 0}/${n.affectedLots.length} affected lots (${shipped.sqlId})`);
  }

  const ok = critiques.length === 0;
  say(ctx, "Auditor", ok ? "Briefer" : "Investigator", ok ? `${k.id}: approved (${checks.length} checks passed)` : `${k.id}: BLOCKED — ${critiques.map((c) => c.detail).join("; ")}`.slice(0, 600), { checks, critiques });
  if (!ok) for (const c of critiques) ctx.trace.emit("critique", "Auditor", { caseId: k.id, ...c });
  return { ok, critiques, checks };
}

/** The brief may only state numbers that are in its evidence, and must cite evidence that exists. */
export function auditBrief(text: string, evidenceIds: Set<string>, evidenceText: string): string[] {
  const problems: string[] = [];
  const cited = [...text.matchAll(/\[(E\d+)\]/g)].map((m) => m[1]);
  if (!cited.length) problems.push("the brief cites no evidence ids");
  for (const id of cited) if (!evidenceIds.has(id)) problems.push(`cites ${id}, which is not in the evidence`);
  const allowed = new Set([...evidenceText.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]));
  for (const [w, v] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${w}\\b`, "i").test(text) && !allowed.has(String(v))) problems.push(`says "${w}", which is not a number in the evidence`);
  }
  for (const m of text.replace(/\[E\d+\]/g, "").matchAll(/\b\d+(?:[.,]\d+)?\b/g)) {
    const num = m[0].replace(/,/g, "");
    if (!allowed.has(num)) problems.push(`states the number ${m[0]}, which is not in the evidence`);
  }
  return [...new Set(problems)];
}

const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, dozen: 12 };
