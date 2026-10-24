// Scout: reads the live recall feeds and our catalog through Zetaris, opens one
// case per recall that touches something we stock.
import { fromCpsc, fromFda, type CpscRow, type FdaRow, type Recall } from "../feeds.ts";
import { candidates, indexCatalog, type Candidate, type Sku } from "../match.ts";
import { lit, say, type AgentContext } from "./context.ts";
import type { SqlResult } from "../sql/index.ts";

export interface Case { id: string; recall: Recall; recallEntity: string; candidates: Candidate[] }

export async function scout(ctx: AgentContext, opts: { since: string; only?: string[] }): Promise<{ cases: Case[]; scanned: number; catalog: Sku[] }> {
  const sinceCompact = opts.since.replace(/-/g, "");
  // A live feed can be down (openFDA answers 500 at times). Read each one on its own; a failed
  // feed is reported to the Orchestrator and the run goes on with the others.
  const feed = async (name: string, q: Promise<SqlResult>): Promise<SqlResult> => {
    try { return await q; } catch (e) {
      say(ctx, "Scout", "Orchestrator", `${name} feed unavailable (${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160)}); continuing without it`);
      return { sqlId: "", engine: ctx.sql.engine, columns: [], rows: [], ms: 0 };
    }
  };
  const fda = await feed("FDA", ctx.sql.run(
    `SELECT recall_number, recalling_firm, product_description, reason_for_recall, code_info, more_code_info, distribution_pattern, classification, report_date, recall_initiation_date, status
     FROM recallfeeds.fda_food WHERE report_date >= ${lit(sinceCompact)}`,
    { agent: "Scout", purpose: "FDA food enforcement notices since " + opts.since }));
  const cpsc = await feed("CPSC", ctx.sql.run(
    `SELECT recall_number, recall_date, last_publish, title, description, product_names, models, upcs, firms, hazard, url
     FROM recallfeeds.cpsc_recalls WHERE recall_date >= ${lit(opts.since)}`,
    { agent: "Scout", purpose: "CPSC recalls since " + opts.since }));
  let recalls = [...fda.rows.map((r) => fromFda(r as unknown as FdaRow)), ...cpsc.rows.map((r) => fromCpsc(r as unknown as CpscRow))];
  if (opts.only?.length) recalls = recalls.filter((r) => opts.only!.includes(r.number) || opts.only!.includes(r.id));

  const cat = await ctx.sql.run(`SELECT sku, upc, title, brand, department, supplier_id FROM erp.skus`, { agent: "Scout", purpose: "item master (ERP)" });
  const catalog = cat.rows.map((r) => ({ ...r, upc: String(r.upc ?? "") }) as unknown as Sku);
  const ix = indexCatalog(catalog);

  // One federated query across the live FDA feed (REST) and the ERP (JDBC): any SKU whose UPC
  // occurs anywhere in the digits of a notice. Catches UPCs written in ways the parser misses.
  const sweep = !fda.sqlId ? fda : await ctx.sql.run(
    `SELECT f.recall_number, s.sku FROM recallfeeds.fda_food f JOIN erp.skus s
       ON s.upc <> '' AND regexp_replace(concat(f.product_description, ' ', f.code_info, ' ', coalesce(f.more_code_info, '')), '[^0-9]', '') LIKE concat('%', s.upc, '%')
     WHERE f.report_date >= ${lit(sinceCompact)}`,
    { agent: "Scout", purpose: "UPC sweep: live FDA feed x ERP item master" });
  const sweepHits = new Map<string, Set<string>>();
  for (const r of sweep.rows) { const k = `fda:${r.recall_number}`; (sweepHits.get(k) ?? sweepHits.set(k, new Set()).get(k)!).add(String(r.sku)); }

  const cases: Case[] = [];
  for (const recall of recalls) {
    const cands = candidates(recall, ix);
    for (const sku of sweepHits.get(recall.id) ?? []) {
      if (cands.some((c) => c.sku.sku === sku)) continue;
      const s = catalog.find((x) => x.sku === sku);
      if (s) cands.unshift({ sku: s, basis: "upc", evidence: s.upc, brandWords: [], kindWords: [] });
    }
    if (!cands.length) continue;
    const src = { kind: ctx.sql.engine, by: "Scout", ref: recall.feed === "cpsc" ? cpsc.sqlId : fda.sqlId };
    const recallEntity = await ctx.world.entity("recall", recall.feed, recall.number, recall.title, { firm: recall.firm }, src);
    await ctx.world.fact(recallEntity, "notice_firm", recall.firm, src);
    await ctx.world.fact(recallEntity, "notice_product_text", recall.text.slice(0, 300), src);
    await ctx.world.fact(recallEntity, "notice_reason", recall.reason, src);
    await ctx.world.fact(recallEntity, "notice_recall_date", recall.date, src);
    await ctx.world.fact(recallEntity, "notice_distribution_states", recall.states, src);
    if (recall.codeInfo) await ctx.world.fact(recallEntity, "notice_code_info", recall.codeInfo.slice(0, 400), src);
    if (recall.upcs.length) await ctx.world.fact(recallEntity, "notice_upcs", recall.upcs, src);
    cases.push({ id: `case-${recall.id.replace(/[^A-Za-z0-9]+/g, "-")}`, recall, recallEntity, candidates: cands });
  }
  say(ctx, "Scout", "Orchestrator", `scanned ${recalls.length} recalls since ${opts.since}; ${cases.length} touch our catalog`, {
    scanned: recalls.length, cases: cases.map((c) => ({ id: c.id, candidates: c.candidates.map((x) => `${x.sku.sku}:${x.basis}`) })) });
  return { cases, scanned: recalls.length, catalog };
}
