// Cartographer: before any case is opened, discovers what data the team can reach through
// Zetaris and how the fragments connect. It lists every datasource, Lightning database and
// schemastore view, describes their columns, profiles the identifier columns, and tests the
// candidate join keys with real federated queries. The result (a source map) is written to the
// World Model with the query id behind every number, and the Auditor uses the barcode join it
// verified. The map is a hypothesis: when the Auditor finds ship notices its join cannot reach,
// it sends them back, and the Cartographer diagnoses that supplier's barcodes (reconcile) and
// corrects the map for the rest of the run.
import { inList, lit, say, type AgentContext } from "./context.ts";

export type Role = "barcode" | "sku" | "lot";
export interface TableInfo { name: string; kind: "jdbc" | "rest" | "view"; source: string; columns: { name: string; type: string; role?: Role }[] }
export interface BarcodeProfile { table: string; column: string; lengths: Record<string, number>; sqlId: string }
export type Transform = "no-leading-zeros" | "no-check-digit";
/** A supplier whose barcodes need their own transform, learned from a case the Auditor sent back. */
export interface SupplierRule { supplier: string; transform: Transform; rows: number; learnedFrom: string; sqlId: string }
export interface JoinCheck { left: string; right: string; column: string; leftRows: number; asWritten: number; normalized: number; chosen: "as-written" | "normalized" | "none"; sqlIds: string[]; rules?: SupplierRule[] }
/** How a live feed writes the identifiers our matching depends on. */
export interface FeedProfile { view: string; notices: number; barcodeField?: number; barcodeInText?: number; barcodeInTextSplit?: number; models?: number; dateExample?: string; dateFormat?: string; sqlId: string }
export interface SourceMap { tables: TableInfo[]; skipped: { name: string; why: string }[]; barcodes: BarcodeProfile[]; joins: JoinCheck[]; feeds?: FeedProfile[] }

// Zetaris has no statement that lists schemastore containers, so the view container this
// project creates (sql/01_feeds.sql) is named here.
const VIEW_CONTAINERS = ["recallfeeds"];

const ROLE: [Role, RegExp][] = [["barcode", /^(upc|gtin|ean|barcode)$/i], ["sku", /^sku$/i], ["lot", /^lot(_code)?$/i]];
const roleOf = (col: string) => ROLE.find(([, re]) => re.test(col))?.[0];

const ASN = "supplier_portal.ship_notices", ITEMS = "erp.skus";

/** Barcode equality under a transform; `asn` is the ship-notice alias, `item` the item-master one. */
function keyEq(t: Transform | "as-written", asn: string, item: string): string {
  if (t === "no-leading-zeros") return `regexp_replace(${asn}.upc, '^0+', '') = regexp_replace(${item}.upc, '^0+', '')`;
  if (t === "no-check-digit") return `${asn}.upc = substr(${item}.upc, 1, 11)`;
  return `${asn}.upc = ${item}.upc`;
}

/** The join predicate for two tables' barcode columns, as verified (and corrected) by the Cartographer. */
export function barcodeJoin(map: SourceMap | undefined, left: string, right: string, a: string, b: string): string {
  const j = map?.joins.find((x) => (x.left === left && x.right === right) || (x.left === right && x.right === left));
  const base = j?.chosen === "normalized" ? keyEq("no-leading-zeros", a, b) : `${a}.upc = ${b}.upc`;
  if (!j?.rules?.length) return base;
  const [asn, item] = left === ASN ? [a, b] : [b, a];
  return `(${[base, ...j.rules.map((r) => `(${asn}.supplier_id = ${lit(r.supplier)} AND ${keyEq(r.transform, asn, item)})`)].join(" OR ")})`;
}

export async function chart(ctx: AgentContext): Promise<SourceMap> {
  const map: SourceMap = { tables: [], skipped: [], barcodes: [], joins: [] };
  map.tables = ctx.sql.engine === "zetaris" ? await zetarisCatalog(ctx, map) : await duckCatalog(ctx);
  for (const t of map.tables) for (const c of t.columns) c.role = roleOf(c.name);

  const withBarcode = map.tables.filter((t) => t.kind === "jdbc" && t.columns.some((c) => c.role === "barcode"));
  for (const t of withBarcode) {
    const r = await ctx.sql.run(`SELECT length(upc) AS len, COUNT(*) AS n FROM ${t.name} GROUP BY length(upc)`, { agent: "Cartographer", purpose: `profile barcode column ${t.name}.upc` });
    const lengths = Object.fromEntries(r.rows.map((x) => [String(x.len ?? 0), Number(x.n)]));
    map.barcodes.push({ table: t.name, column: "upc", lengths, sqlId: r.sqlId });
    const ent = await ctx.world.entity("source_column", ctx.sql.engine, `${t.name}.upc`, `${t.name}.upc`, { role: "barcode" }, { kind: ctx.sql.engine, by: "Cartographer", ref: r.sqlId });
    await ctx.world.fact(ent, "barcode_lengths", lengths, { kind: ctx.sql.engine, by: "Cartographer", ref: r.sqlId });
  }

  // Every pair of barcode columns in different sources: does the key join as written, or only
  // after stripping leading zeros (GTIN-14 / EAN-13 padding of a UPC-12)?
  for (let i = 0; i < withBarcode.length; i++) for (let j = i + 1; j < withBarcode.length; j++) {
    const [big, small] = [withBarcode[i], withBarcode[j]].sort((x, y) => total(map, y.name) - total(map, x.name));
    if (big.source === small.source) continue;
    const q = async (on: string, purpose: string) => ctx.sql.run(
      `SELECT COUNT(*) AS n FROM ${big.name} a JOIN ${small.name} b ON ${on} WHERE a.upc <> ''`, { agent: "Cartographer", purpose });
    const raw = await q("a.upc = b.upc", `join test ${big.name} x ${small.name} on barcode as written`);
    const norm = await q("regexp_replace(a.upc, '^0+', '') = regexp_replace(b.upc, '^0+', '')", `join test ${big.name} x ${small.name} on barcode without leading zeros`);
    const nonBlank = Object.entries(map.barcodes.find((b) => b.table === big.name)!.lengths).filter(([l]) => l !== "0").reduce((s, [, n]) => s + n, 0);
    const asWritten = Number(raw.rows[0]?.n ?? 0), normalized = Number(norm.rows[0]?.n ?? 0);
    const chosen = normalized > asWritten ? "normalized" : asWritten > 0 ? "as-written" : "none";
    const check: JoinCheck = { left: big.name, right: small.name, column: "upc", leftRows: nonBlank, asWritten, normalized, chosen, sqlIds: [raw.sqlId, norm.sqlId] };
    map.joins.push(check);
    const ent = await ctx.world.entity("join_key", ctx.sql.engine, `${big.name}~${small.name}:upc`, `${big.name} x ${small.name} on barcode`, {}, { kind: ctx.sql.engine, by: "Cartographer", ref: raw.sqlId });
    await ctx.world.fact(ent, "rows_joined_as_written", asWritten, { kind: ctx.sql.engine, by: "Cartographer", ref: raw.sqlId });
    await ctx.world.fact(ent, "rows_joined_without_leading_zeros", normalized, { kind: ctx.sql.engine, by: "Cartographer", ref: norm.sqlId });
    await ctx.world.fact(ent, "chosen_join", chosen, { kind: "agent", by: "Cartographer" });
  }

  for (const j of map.joins) {
    const gap = j.normalized - j.asWritten;
    const open = j.leftRows - Math.max(j.asWritten, j.normalized);
    say(ctx, "Cartographer", "Auditor", (gap > 0
      ? `${j.left} x ${j.right}: ${j.asWritten}/${j.leftRows} barcoded rows join as written, ${j.normalized}/${j.leftRows} after stripping leading zeros (${gap} rows are GTIN-14/EAN-13 padded). Use the normalized key.`
      : `${j.left} x ${j.right}: ${j.asWritten}/${j.leftRows} barcoded rows join as written; no padding found.`)
      + (open > 0 ? ` ${open} barcoded rows join neither way; left open until a case needs them — send me any you hit.` : ""),
      { join: j });
  }
  // Profiling queries the live feeds; one that is down must not stop the map.
  map.feeds = await profileFeeds(ctx, map).catch((e) => {
    say(ctx, "Cartographer", "Orchestrator", `could not profile the live feeds (${String(e instanceof Error ? e.message : e).split("\n")[0].slice(0, 160)}); the rest of the map stands`);
    return [];
  });
  const blanks = map.barcodes.filter((b) => (b.lengths["0"] ?? 0) > 0).map((b) => `${b.table} has ${b.lengths["0"]} rows with no barcode`);
  say(ctx, "Cartographer", "Orchestrator", `mapped ${map.tables.length} tables in ${new Set(map.tables.map((t) => t.source)).size} sources (${map.skipped.length} skipped). ${blanks.join("; ")}${blanks.length ? " — those rows are reachable by SKU only." : ""}`,
    { tables: map.tables.map((t) => `${t.kind}:${t.name}`), skipped: map.skipped });
  return map;
}

const total = (map: SourceMap, table: string) => Object.values(map.barcodes.find((b) => b.table === table)?.lengths ?? {}).reduce((s, n) => s + n, 0);

async function zetarisCatalog(ctx: AgentContext, map: SourceMap): Promise<TableInfo[]> {
  const run = (sql: string, purpose: string) => ctx.sql.run(sql, { agent: "Cartographer", purpose });
  const tables: TableInfo[] = [];
  const describe = async (name: string, stmt: string) => (await run(stmt, `columns of ${name}`)).rows.map((c) => ({ name: String(c.col_name), type: String(c.data_type) }));
  for (const ds of (await run("SHOW DATASOURCES", "list JDBC datasources")).rows) {
    const src = String(ds.name);
    for (const t of (await run(`SHOW DATASOURCE TABLES ${src}`, `tables in datasource ${src}`)).rows) {
      const name = `${src}.${t.name}`;
      tables.push({ name, kind: "jdbc", source: src, columns: await describe(name, `DESCRIBE DATASOURCE TABLE ${name}`) });
    }
  }
  for (const db of (await run("SHOW LIGHTNING DATABASES", "list Lightning databases")).rows) {
    const name = String(db.name), desc = String(db.description ?? "");
    if (/sample|benchmark/i.test(desc)) { map.skipped.push({ name, why: `described as "${desc}"` }); continue; }
    for (const t of (await run(`SHOW TABLES IN ${name}`, `tables in Lightning database ${name}`)).rows) {
      // REST tables re-fetch the remote API on every query, so they are listed, not described;
      // the flattened views over them are described below.
      tables.push({ name: String(t.table_identifier), kind: "rest", source: name, columns: [] });
    }
  }
  for (const c of VIEW_CONTAINERS) {
    for (const v of (await run(`SHOW TABLES IN ${c}`, `views in schemastore container ${c}`)).rows) {
      const name = `${c}.${String(v.table_identifier).toLowerCase()}`;
      tables.push({ name, kind: "view", source: c, columns: await describe(name, `DESCRIBE ${name}`) });
    }
  }
  return tables;
}

async function duckCatalog(ctx: AgentContext): Promise<TableInfo[]> {
  const r = await ctx.sql.run(
    `SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns
     WHERE table_schema IN (${inList(["erp", "supplier_portal", ...VIEW_CONTAINERS])}) ORDER BY table_schema, table_name, ordinal_position`,
    { agent: "Cartographer", purpose: "catalog of the sample stand-in" });
  const by = new Map<string, TableInfo>();
  for (const x of r.rows) {
    const name = `${x.table_schema}.${x.table_name}`;
    const t = by.get(name) ?? by.set(name, { name, kind: VIEW_CONTAINERS.includes(String(x.table_schema)) ? "view" : "jdbc", source: String(x.table_schema), columns: [] }).get(name)!;
    t.columns.push({ name: String(x.column_name), type: String(x.data_type).toLowerCase() });
  }
  return [...by.values()];
}

/**
 * The Auditor found ship notices that reach a case's lots by SKU but not by barcode. Diagnose
 * them: per supplier, which barcode transform makes those rows join? A transform is adopted only
 * if it also holds for every barcoded ship notice of that supplier, and the map is corrected for
 * the rest of the run. Returns the rules it learned (empty if the gap is not a key format issue).
 */
export async function reconcile(ctx: AgentContext, caseId: string, skus: string[], lots: string[]): Promise<SupplierRule[]> {
  const run = (sql: string, purpose: string) => ctx.sql.run(sql, { agent: "Cartographer", purpose });
  const t = ["as-written", "no-leading-zeros", "no-check-digit"] as const;
  const counts = t.map((x, i) => `SUM(CASE WHEN ${keyEq(x, "a", "s")} THEN 1 ELSE 0 END) AS k${i}`).join(", ");
  const diag = await run(
    `SELECT a.supplier_id AS supplier, length(a.upc) AS asn_len, length(s.upc) AS item_len, COUNT(*) AS n, ${counts}
     FROM ${ASN} a JOIN ${ITEMS} s ON s.sku = a.sku
     WHERE a.sku IN (${inList(skus)}) AND a.lot_code IN (${inList(lots)}) AND a.upc <> ''
     GROUP BY a.supplier_id, length(a.upc), length(s.upc)`,
    `diagnose barcodes behind the ${caseId} mismatch`);
  const current = barcodeJoin(ctx.map, ASN, ITEMS, "a", "s");
  const learned: SupplierRule[] = [];
  const notes: string[] = [];
  for (const row of diag.rows) {
    const supplier = String(row.supplier), n = Number(row.n);
    const ok = t.map((_, i) => Number(row[`k${i}`] ?? 0));
    const covered = ctx.map?.joins.find((j) => j.left === ASN || j.right === ASN);
    if (ok[0] === n || (covered?.chosen === "normalized" && ok[1] === n) || covered?.rules?.some((r) => r.supplier === supplier)) continue;
    const transform = (["no-leading-zeros", "no-check-digit"] as const).find((_, i) => ok[i + 1] === n);
    if (!transform) { notes.push(`${supplier}: ${n} rows with ${row.asn_len}-digit barcodes match our ${row.item_len}-digit UPCs under no known transform`); continue; }
    // A rule from one case is a guess; check it on everything this supplier has shipped.
    const all = await run(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN ${keyEq(transform, "a", "s")} THEN 1 ELSE 0 END) AS ok
       FROM ${ASN} a JOIN ${ITEMS} s ON s.sku = a.sku WHERE a.supplier_id = ${lit(supplier)} AND a.upc <> ''`,
      `test "${transform}" on every ship notice from ${supplier}`);
    const [tot, hit] = [Number(all.rows[0]?.n ?? 0), Number(all.rows[0]?.ok ?? 0)];
    if (hit !== tot) { notes.push(`${supplier}: "${transform}" fits this case but only ${hit}/${tot} of its ship notices`); continue; }
    learned.push({ supplier, transform, rows: tot, learnedFrom: caseId, sqlId: all.sqlId });
    notes.push(`${supplier} sends ${row.asn_len}-digit barcodes against our ${row.item_len}-digit UPCs: "${transform}" holds for all ${tot} of its ship notices (${all.sqlId})`);
  }
  if (learned.length) {
    ctx.map ??= { tables: [], skipped: [], barcodes: [], joins: [] };
    let j = ctx.map.joins.find((x) => x.left === ASN || x.right === ASN);
    if (!j) ctx.map.joins.push(j = { left: ASN, right: ITEMS, column: "upc", leftRows: 0, asWritten: 0, normalized: 0, chosen: "as-written", sqlIds: [] });
    (j.rules ??= []).push(...learned);
    const ent = await ctx.world.entity("join_key", ctx.sql.engine, `${j.left}~${j.right}:upc`, `${j.left} x ${j.right} on barcode`, {}, { kind: ctx.sql.engine, by: "Cartographer", ref: diag.sqlId });
    for (const r of learned) await ctx.world.fact(ent, `supplier_rule:${r.supplier}`, r.transform, { kind: ctx.sql.engine, by: "Cartographer", ref: r.sqlId });
  }
  say(ctx, "Cartographer", "Auditor", `${caseId}: ${notes.join("; ") || "every row already joins with the current key"}.${learned.length ? " Map corrected; re-run your check." : ""}`,
    { diagnosis: diag.sqlId, learned, before: current });
  return learned;
}

const dateFormat = (v: string) => (/^\d{8}$/.test(v) ? "yyyymmdd" : /^\d{4}-\d{2}-\d{2}/.test(v) ? "yyyy-mm-dd" : "unknown");

/**
 * The live feeds disagree with each other too: where (if anywhere) a notice carries a barcode,
 * whether it has model numbers, and how it writes dates. Profiled on the live views, written to
 * the World Model, and told to the Scout and the Investigator.
 */
async function profileFeeds(ctx: AgentContext, map: SourceMap): Promise<FeedProfile[]> {
  const views = new Set(map.tables.filter((t) => t.kind === "view").map((t) => t.name));
  const run = (sql: string, purpose: string) => ctx.sql.run(sql, { agent: "Cartographer", purpose });
  const digits = (col: string) => `length(regexp_extract(${col}, '[0-9]{12,14}', 0)) > 0`;
  const out: FeedProfile[] = [];
  if (views.has("recallfeeds.fda_food")) {
    const r = await run(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN ${digits("product_description")} THEN 1 ELSE 0 END) AS run_digits,
         SUM(CASE WHEN ${digits("regexp_replace(product_description, '[ -]', '')")} THEN 1 ELSE 0 END) AS split_digits,
         MIN(report_date) AS date_example
       FROM recallfeeds.fda_food`, "profile identifiers in the live FDA feed");
    const x = r.rows[0] ?? {};
    out.push({ view: "recallfeeds.fda_food", notices: Number(x.n ?? 0), barcodeInText: Number(x.run_digits ?? 0), barcodeInTextSplit: Number(x.split_digits ?? 0), dateExample: String(x.date_example ?? ""), dateFormat: dateFormat(String(x.date_example ?? "")), sqlId: r.sqlId });
  }
  if (views.has("recallfeeds.cpsc_recalls")) {
    const r = await run(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN upcs <> '' THEN 1 ELSE 0 END) AS with_upc, SUM(CASE WHEN models <> '' THEN 1 ELSE 0 END) AS with_models,
         MIN(recall_date) AS date_example
       FROM recallfeeds.cpsc_recalls`, "profile identifiers in the live CPSC feed");
    const x = r.rows[0] ?? {};
    out.push({ view: "recallfeeds.cpsc_recalls", notices: Number(x.n ?? 0), barcodeField: Number(x.with_upc ?? 0), models: Number(x.with_models ?? 0), dateExample: String(x.date_example ?? ""), dateFormat: dateFormat(String(x.date_example ?? "")), sqlId: r.sqlId });
  }
  for (const f of out) {
    const ent = await ctx.world.entity("feed", ctx.sql.engine, f.view, f.view, {}, { kind: ctx.sql.engine, by: "Cartographer", ref: f.sqlId });
    for (const [k, v] of Object.entries(f)) if (k !== "view" && k !== "sqlId" && v !== undefined) await ctx.world.fact(ent, k, v, { kind: ctx.sql.engine, by: "Cartographer", ref: f.sqlId });
  }
  const fda = out.find((f) => f.view.endsWith("fda_food")), cpsc = out.find((f) => f.view.endsWith("cpsc_recalls"));
  if (fda) say(ctx, "Cartographer", "Scout", `FDA feed: ${fda.notices} notices, no barcode field; ${fda.barcodeInText} print a 12–14 digit barcode in the product text and ${(fda.barcodeInTextSplit ?? 0) - (fda.barcodeInText ?? 0)} more only once spaces and dashes are removed ("0 87906-01018 7"), so match UPCs on digits only. Dates are ${fda.dateFormat} (${fda.dateExample}).`, { feed: fda });
  if (cpsc) say(ctx, "Cartographer", "Investigator", `CPSC feed: ${cpsc.notices} notices, ${cpsc.barcodeField} with a UPC field and ${cpsc.models} with a model field, so CPSC matches rest on model numbers written in the notice text and on the text itself, not on barcodes. Dates are ${cpsc.dateFormat} (${cpsc.dateExample}).`, { feed: cpsc });
  return out;
}
