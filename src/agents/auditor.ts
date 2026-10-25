// Auditor: has authority to block. It never trusts the Investigator's numbers or
// quotes: it re-checks evidence against the live notice text and re-derives the
// exposure numbers with its own SQL, written differently.
import { lotAppears } from "../feeds.ts";
import { printedForms } from "../../scripts/upc.ts";
import { designatorConflict, grounded, modelsInText, tokens, WEAK } from "../match.ts";
import { inList, lit, say, type AgentContext } from "./context.ts";
import { barcodeJoin, reconcile } from "./cartographer.ts";
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
      // Notices print UPCs whole, without the check digit, or without the leading zero; any of those counts.
      const like = (col: string) => "(" + printedForms(cand.sku.upc).map((f) => `regexp_replace(${col}, '[^0-9]', '') LIKE ${lit("%" + f + "%")}`).join(" OR ") + ")";
      const q = r.feed === "fda_food"
        ? `SELECT COUNT(*) AS n FROM recallfeeds.fda_food WHERE recall_number = ${lit(r.number)} AND ${like("concat(product_description, ' ', code_info, ' ', coalesce(more_code_info, ''))")}`
        : `SELECT COUNT(*) AS n FROM recallfeeds.cpsc_recalls WHERE recall_number = ${lit(r.number)} AND ${like("concat(upcs, ' ', description)")}`;
      // The live feed is re-fetched on every query and can be down; an unverified match goes to a person.
      const res = await ctx.sql.run(q, { agent: "Auditor", purpose: `re-check UPC ${cand.sku.upc} in live notice ${r.id}` }).catch((e: Error) => e);
      if (res instanceof Error) critiques.push({ code: "upc-not-in-notice", sku: d.sku, detail: `could not re-check UPC ${cand.sku.upc} in the live notice ${r.id} (${res.message.split("\n")[0].slice(0, 120)})` });
      else if (Number(res.rows[0]?.n ?? 0) > 0) checks.push(`${d.sku}: UPC found in live notice (${res.sqlId})`);
      else critiques.push({ code: "upc-not-in-notice", sku: d.sku, detail: `UPC ${cand.sku.upc} not found in notice ${r.id} (${res.sqlId})` });
    }
    if (d.verdict === "same" && d.basis === "model") {
      if (modelsInText(r).some((m) => m.replace(/[^A-Z0-9]/g, "") === cand.evidence)) checks.push(`${d.sku}: model ${cand.evidence} is in the notice`);
      else critiques.push({ code: "model-not-in-notice", sku: d.sku, detail: `model ${cand.evidence} not in notice` });
    }
    if ((d.decidedBy === "judge" || d.decidedBy === "agent-memory") && d.verdict !== "unsure") {
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
        // A size on our label that the notice never lists (7 oz vs a notice for 10 oz) is another product.
        const ours = sizes(cand.sku.title);
        const theirs = sizes(`${r.text} ${r.codeInfo}`);
        if (ours.length && theirs.length && !ours.some((x) => theirs.includes(x))) critiques.push({ code: "size-not-in-notice", sku: d.sku, detail: `our item is ${ours.join("/")}; the notice lists ${[...new Set(theirs)].slice(0, 6).join(", ")}` });
        // Our product named only inside another product's ingredient list is not a match.
        const cut = r.text.search(/\bingredients?\s*:/i);
        if (cut > 0) {
          const head = new Set(tokens(`${r.feed === "cpsc" ? r.title : ""} ${r.text.slice(0, cut)}`));
          const words = tokens(cand.sku.title).filter((w) => !brand.has(w) && !/\d/.test(w) && w.length > 2);
          if (words.length && !words.some((w) => head.has(w))) critiques.push({ code: "only-an-ingredient", sku: d.sku, detail: `"${cand.sku.title}" appears in the notice only as an ingredient of another product` });
        }
      }
      // The opposite error, and the dangerous one: a dismissal whose own quote names our product.
      if (d.verdict === "not-this" && d.quote && dismissalNamesItem(cand.sku.title, cand.sku.brand, d.quote))
        critiques.push({ code: "dismissal-names-our-item", sku: d.sku, detail: `dismissed, but the quoted recalled product "${d.quote.slice(0, 120)}" contains every product word of our item "${cand.sku.title}"` });
      // Same brand, and the recalled product the judge quotes is the same kind as ours (another size,
      // count or variety of the line): telling those apart takes the package, so a person decides.
      else if (d.verdict === "not-this" && d.quote && dismissalSameLine(cand.sku.title, cand.sku.brand, d.quote))
        critiques.push({ code: "dismissal-same-line", sku: d.sku, detail: `dismissed, but the quoted recalled product "${d.quote.slice(0, 120)}" names every product word of our item "${cand.sku.title}" and differs only in size, count or description; a reviewer checks the package` });
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
    // Cross-source: did the supplier actually ship these lots to us? Reached through the barcode
    // (a different key than the Investigator's SKU join), with the join the Cartographer verified.
    const byBarcode = async (purpose: string) => {
      const r = await ctx.sql.run(
        `SELECT COUNT(DISTINCT a.lot_code) AS lots FROM supplier_portal.ship_notices a JOIN erp.skus s ON ${barcodeJoin(ctx.map, "supplier_portal.ship_notices", "erp.skus", "a", "s")}
         WHERE s.sku IN (${inList(skus)}) AND a.lot_code IN (${inList(n.affectedLots)})`,
        { agent: "Auditor", purpose });
      return { lots: Number(r.rows[0]?.lots ?? 0), sqlId: r.sqlId };
    };
    let viaBarcode = await byBarcode("supplier ship notices reached by barcode confirm the affected lots");
    const viaSku = await ctx.sql.run(
      `SELECT COUNT(DISTINCT lot_code) AS lots FROM supplier_portal.ship_notices WHERE sku IN (${inList(skus)}) AND lot_code IN (${inList(n.affectedLots)}) AND upc <> ''`,
      { agent: "Auditor", purpose: "same lots reached by SKU, barcoded ship notices only" });
    const bySku = Number(viaSku.rows[0]?.lots ?? 0);
    let remapped = "";
    // A key the sources disagree on is the Cartographer's to fix, not the Investigator's.
    if (viaBarcode.lots < bySku && ctx.cartographer !== false) {
      say(ctx, "Auditor", "Cartographer", `${k.id}: ship notices reach ${bySku} affected lots by SKU but only ${viaBarcode.lots} by barcode (${viaBarcode.sqlId}/${viaSku.sqlId}). Check the barcode key for these rows.`, { skus, lots: n.affectedLots });
      const learned = await reconcile(ctx, k.id, skus, n.affectedLots);
      if (learned.length) {
        viaBarcode = await byBarcode("re-check the affected lots by barcode with the corrected map");
        remapped = ` after the Cartographer learned ${learned.map((r) => `${r.supplier} "${r.transform}"`).join(", ")}`;
      }
    }
    if (viaBarcode.lots < bySku) critiques.push({ code: "supplier-barcode-mismatch", detail: `supplier ship notices: ${bySku} affected lots by SKU but only ${viaBarcode.lots} by barcode — the supplier's barcode does not match our item master (${viaBarcode.sqlId}/${viaSku.sqlId})` });
    else checks.push(`supplier ship notices reached by barcode cover ${viaBarcode.lots}/${n.affectedLots.length} affected lots${remapped} (${viaBarcode.sqlId})`);
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

/** Package sizes normalised to one unit family: "Net Wt. 10 oz" → "10oz", "4/5#" → "5lb", "2.5 lbs" → "2.5lb". */
/** True when every product word of our item title (vendor words, numbers and short words aside) is in the quote. */
export function dismissalNamesItem(title: string, vendor: string, quote: string): boolean {
  const skip = new Set(tokens(vendor));
  const words = tokens(title).filter((w) => !skip.has(w) && !/\d/.test(w) && w.length > 2);
  const q = new Set(tokens(quote));
  return words.length >= 2 && words.every((w) => q.has(w));
}

/** Words that say how much, not what: a dismissal over these alone is a size or count question. */
const UNIT_WORDS = new Set("pcs pc pieces piece count ct pack pk packs bag bags box case cs each ea oz lb lbs fl ml gram grams kg dozen".split(" "));

/**
 * True when the recalled product the judge quotes names every product word of our item, leaving out only
 * vendor words, numbers, units and descriptive words (large, organic, medium…). Then the difference the judge
 * saw is a size, count or descriptor of the same line, which the package settles, not the notice; a person
 * decides. A different flavour or variety ("Mango Pico de Gallo" vs "Hot Pico de Gallo") names a word of ours
 * the quote lacks, so it stays dismissed.
 */
export function dismissalSameLine(title: string, vendor: string, quote: string): boolean {
  const skip = new Set(tokens(vendor));
  const words = [...new Set(tokens(title).filter((w) => !skip.has(w) && !/\d/.test(w) && w.length > 2 && !UNIT_WORDS.has(w) && !WEAK.has(w)))];
  const q = new Set(tokens(quote));
  return words.length > 0 && words.every((w) => q.has(w));
}

export function sizes(text: string): string[] {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(/(\d+(?:\.\d+)?)\s*-?\s*(oz|ounces?|lbs?|pounds?|#|g|grams?|kg|ml|l|ct|count|pk|pack)(?![a-z])\.?/gi)) {
    const n = String(Number(m[1]));
    const u = m[2].toLowerCase();
    const unit = /^(oz|ounce)/.test(u) ? "oz" : /^(lb|pound|#)/.test(u) ? "lb" : /^(g|gram)/.test(u) ? "g" : u === "kg" ? "kg" : /^(ml|l)$/.test(u) ? u : "ct";
    out.push(n + unit);
  }
  return out;
}
