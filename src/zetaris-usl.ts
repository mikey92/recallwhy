// The recall_exposure Unified Semantic Layer in Zetaris (created by sql/04_usl.sql): what the agents keep
// up to date in it during a run, and what they read back from it.
//   - After the Cartographer proves a supplier's barcode rule and rewrites reconciled.ship_notice_item_keys,
//     the ship_notice table is re-bound to it and Zetaris's data-quality engine checks the key
//     ship_notice.matched_sku -> item. Its invalid records are the barcoded ship notices no proven rule
//     reaches yet, which Zetaris names one by one (SHOW DQ INVALID RECORD); we count them per supplier.
//   - At the end of a run the Orchestrator writes every verdict back as reconciled.case_verdicts, re-binds
//     the decision table and lets Zetaris check its keys (each verdict points at a live notice and an item
//     we carry) and its custom rule. The next run reads the view and flags a verdict that changed.
// Only on the Zetaris engine; the DuckDB stand-in has no USL.
import { lit, say, type AgentContext } from "./agents/context.ts";
import { issueContract, verifyContract } from "./contract.ts";

export const USL = "lightning.metastore.recallwhy.recall_exposure";
export const VERDICTS = "reconciled.case_verdicts";
export const SHIP_NOTICE_ACTIVATION = `SELECT a.asn_id, a.supplier_id, a.sku AS notice_sku, COALESCE(r.item_sku, 'unreached') AS matched_sku, a.upc AS notice_upc, a.lot_code, CAST(a.units AS INT) AS units
FROM supplier_portal.ship_notices a LEFT JOIN reconciled.ship_notice_item_keys r ON r.asn_id = a.asn_id WHERE a.upc <> ''`;

export interface DqResult { rule: string; table: string; total: number; valid: number; invalid: number; sqlId: string }
export interface KeyCheck extends DqResult { bySupplier: { supplier: string; n: number }[]; examples: { asn_id: string; supplier_id: string; notice_upc: string }[] }
export interface VerdictRow { recall_id: string; sku: string; verdict: string; basis: string; decided_by: "agent" | "person" }

/** RUN DQ returns one row per constraint type a rule name stands for (a column can be in a key and a foreign key). */
export function dqRow(rows: Record<string, unknown>[], rule: string, table: string, type?: RegExp): Omit<DqResult, "sqlId"> | undefined {
  const r = rows.find((x) => !type || type.test(String(x.type ?? ""))) ?? rows[0];
  if (!r) return undefined;
  return { rule, table, total: Number(r.total_record ?? 0), valid: Number(r.valid_record ?? 0), invalid: Number(r.invalid_record ?? 0) };
}

/** Invalid records of the barcode key, counted per supplier, largest first. */
export function bySupplier(rows: Record<string, unknown>[]): { supplier: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) { const s = String(r.supplier_id ?? "?"); m.set(s, (m.get(s) ?? 0) + 1); }
  return [...m].map(([supplier, n]) => ({ supplier, n })).sort((a, b) => b.n - a.n || a.supplier.localeCompare(b.supplier));
}

/**
 * Re-bind ship_notice to the corrected map and let Zetaris check the barcode key. RUN DQ gives the exact
 * valid/invalid count; the per-supplier breakdown of the invalid records is one aggregate over the same
 * table (exact at any size, unlike SHOW DQ INVALID RECORD's row limit).
 */
export async function checkShipNoticeKey(ctx: AgentContext, evidence: Record<string, unknown> = {}): Promise<KeyCheck | undefined> {
  if (ctx.sql.engine !== "zetaris") return undefined;
  const run = (sql: string, purpose: string) => ctx.sql.run(sql, { agent: "Cartographer", purpose });
  const table = `${USL}.ship_notice`;
  const contract = issueContract(ctx.trace, { intent: "write-back.rebind-ship-notice", parameters: evidence, capabilities: [`zetaris.usl.activate:${table}`] });
  verifyContract(ctx.trace, contract, `zetaris.usl.activate:${table}`, "Cartographer");
  await run(`ACTIVATE USL TABLE ${table} AS\n${SHIP_NOTICE_ACTIVATION}`, `re-bind the USL table ${table} to the corrected map`);
  const dq = await run(`RUN DQ matched_sku TABLE ${table}`, "Zetaris data-quality check of the barcode key ship_notice.matched_sku -> item");
  const row = dqRow(dq.rows, "matched_sku", table, /foreign/i);
  if (!row) return undefined;
  const bad = row.invalid ? await run(`SELECT supplier_id, COUNT(*) AS n, MIN(asn_id) AS asn_id, MIN(notice_upc) AS notice_upc FROM ${table} WHERE matched_sku = 'unreached' GROUP BY supplier_id ORDER BY n DESC, supplier_id`, "the ship notices Zetaris finds no item for, by supplier") : undefined;
  const rows = bad?.rows ?? [];
  return { ...row, sqlId: dq.sqlId, bySupplier: rows.map((r) => ({ supplier: String(r.supplier_id), n: Number(r.n) })), examples: rows.slice(0, 3).map((r) => ({ asn_id: String(r.asn_id), supplier_id: String(r.supplier_id), notice_upc: String(r.notice_upc) })) };
}

/** Carry forward earlier verdicts this run did not decide, and keep one row per recall and item. */
export function mergeVerdicts(runId: string, now: VerdictRow[], prior: Map<string, { run_id: string; verdict: string; decided_by: string; basis?: string }>): (VerdictRow & { run_id: string })[] {
  const out = new Map<string, VerdictRow & { run_id: string }>();
  for (const [k, p] of prior) { const [recall_id, sku] = k.split(" "); out.set(k, { run_id: p.run_id, recall_id, sku, verdict: p.verdict, basis: p.basis ?? "earlier run", decided_by: p.decided_by === "person" ? "person" : "agent" }); }
  for (const r of now) out.set(`${r.recall_id} ${r.sku}`, { ...r, run_id: runId });
  return [...out.values()];
}

/** The view of a run's verdicts: one VALUES row per recall and item. */
export function verdictsViewSql(runId: string, rows: (VerdictRow & { run_id?: string })[]): string {
  const values = rows.length
    ? rows.map((r) => `(${[r.run_id ?? runId, r.recall_id, r.sku, r.verdict, r.basis, r.decided_by].map(lit).join(", ")})`).join(",\n  ")
    : `(${[runId, "none", "none", "unsure", "none", "none"].map(lit).join(", ")})`;
  return `CREATE SCHEMASTORE VIEW case_verdicts WITH CONTAINER reconciled AS\nSELECT * FROM VALUES\n  ${values}\nAS t(run_id, recall_id, sku, verdict, basis, decided_by)${rows.length ? "" : " WHERE recall_id <> 'none'"}`;
}

/** Write the run's verdicts back to Zetaris, re-bind the decision table, read it back and run its rules. */
export async function publishVerdicts(ctx: AgentContext, decided: VerdictRow[], prior: Map<string, { run_id: string; verdict: string; decided_by: string; basis?: string }> = new Map()): Promise<{ written: number; read: number; carried: number; dq: DqResult[] } | undefined> {
  if (ctx.sql.engine !== "zetaris") return undefined;
  const rows = mergeVerdicts(ctx.trace.runId, decided, prior);
  const thisRun = rows.filter((r) => r.run_id === ctx.trace.runId).length;
  const run = (sql: string, purpose: string) => ctx.sql.run(sql, { agent: "Orchestrator", purpose });
  const table = `${USL}.decision`;
  const contract = issueContract(ctx.trace, {
    intent: "write-back.case-verdicts", parameters: { verdicts: thisRun, carriedForward: rows.length - thisRun, people: rows.filter((r) => r.decided_by === "person").length },
    capabilities: [`zetaris.view.replace:${VERDICTS}`, `zetaris.usl.activate:${table}`],
  });
  verifyContract(ctx.trace, contract, `zetaris.view.replace:${VERDICTS}`, "Orchestrator");
  await run(`DROP VIEW IF EXISTS ${VERDICTS}`, `replace ${VERDICTS}`);
  await run(verdictsViewSql(ctx.trace.runId, rows), `write this run's ${thisRun} verdict(s) and ${rows.length - thisRun} earlier one(s) back to Zetaris as ${VERDICTS}`);
  verifyContract(ctx.trace, contract, `zetaris.usl.activate:${table}`, "Orchestrator");
  await run(`ACTIVATE USL TABLE ${table} AS\nSELECT run_id, recall_id, sku, verdict, basis, decided_by FROM ${VERDICTS}`, `re-bind the USL table ${table}`);
  const back = await run(`SELECT COUNT(*) AS n FROM ${table} WHERE run_id = ${lit(ctx.trace.runId)}`, `read the verdicts back from ${table}`);
  const read = Number(back.rows[0]?.n ?? 0);
  const total = rows.length;
  const dq: DqResult[] = [];
  for (const [rule, type, purpose] of [["recall_id", /foreign/i, "every verdict names a notice in the live feeds"], ["sku", /foreign/i, "every verdict names an item we carry"], ["known_verdict", undefined, "every verdict is same, not-this or unsure"]] as const) {
    const r = await run(`RUN DQ ${rule} TABLE ${table}`, `Zetaris data-quality check: ${purpose}`).catch(() => undefined);
    const row = r && dqRow(r.rows, rule, table, type);
    if (r && row) dq.push({ ...row, sqlId: r.sqlId });
  }
  const summary = dq.map((d) => `${d.rule} ${d.valid}/${d.total}`).join(", ");
  say(ctx, "Orchestrator", "Human", `${thisRun} verdict(s) written back to Zetaris as ${VERDICTS} (with ${total - thisRun} earlier one(s) carried forward) and read back from ${table}: ${read}/${thisRun}; Zetaris data-quality rules on it: ${summary || "not run"}`);
  ctx.trace.emit("note", "Orchestrator", { text: "verdicts published", verdicts: { view: VERDICTS, table, written: thisRun, carried: total - thisRun, read, dq } });
  return { written: thisRun, read, carried: total - thisRun, dq };
}

/** The verdicts the previous run wrote back, by recall and item. */
export async function priorVerdicts(ctx: AgentContext): Promise<Map<string, { run_id: string; verdict: string; decided_by: string; basis?: string }>> {
  const out = new Map<string, { run_id: string; verdict: string; decided_by: string; basis?: string }>();
  if (ctx.sql.engine !== "zetaris") return out;
  const r = await ctx.sql.run(`SELECT run_id, recall_id, sku, verdict, basis, decided_by FROM ${VERDICTS}`, { agent: "Orchestrator", purpose: `verdicts the previous run wrote back (${VERDICTS})` }).catch(() => undefined);
  for (const x of r?.rows ?? []) out.set(`${x.recall_id} ${x.sku}`, { run_id: String(x.run_id), verdict: String(x.verdict), decided_by: String(x.decided_by), basis: String(x.basis ?? "") });
  return out;
}
