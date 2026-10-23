// Cartographer: before any case is opened, discovers what data the team can reach through
// Zetaris and how the fragments connect. It lists every datasource, Lightning database and
// schemastore view, describes their columns, profiles the identifier columns, and tests the
// candidate join keys with real federated queries. The result (a source map) is written to the
// World Model with the query id behind every number, and the Auditor uses the barcode join it
// verified.
import { inList, say, type AgentContext } from "./context.ts";

export type Role = "barcode" | "sku" | "lot";
export interface TableInfo { name: string; kind: "jdbc" | "rest" | "view"; source: string; columns: { name: string; type: string; role?: Role }[] }
export interface BarcodeProfile { table: string; column: string; lengths: Record<string, number>; sqlId: string }
export interface JoinCheck { left: string; right: string; column: string; leftRows: number; asWritten: number; normalized: number; chosen: "as-written" | "normalized" | "none"; sqlIds: string[] }
export interface SourceMap { tables: TableInfo[]; skipped: { name: string; why: string }[]; barcodes: BarcodeProfile[]; joins: JoinCheck[] }

// Zetaris has no statement that lists schemastore containers, so the view container this
// project creates (sql/01_feeds.sql) is named here.
const VIEW_CONTAINERS = ["recallfeeds"];

const ROLE: [Role, RegExp][] = [["barcode", /^(upc|gtin|ean|barcode)$/i], ["sku", /^sku$/i], ["lot", /^lot(_code)?$/i]];
const roleOf = (col: string) => ROLE.find(([, re]) => re.test(col))?.[0];

/** The join predicate for two tables' barcode columns, as verified by the Cartographer. */
export function barcodeJoin(map: SourceMap | undefined, left: string, right: string, a: string, b: string): string {
  const j = map?.joins.find((x) => (x.left === left && x.right === right) || (x.left === right && x.right === left));
  return j?.chosen === "normalized"
    ? `regexp_replace(${a}.upc, '^0+', '') = regexp_replace(${b}.upc, '^0+', '')`
    : `${a}.upc = ${b}.upc`;
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
    say(ctx, "Cartographer", "Auditor", gap > 0
      ? `${j.left} x ${j.right}: ${j.asWritten}/${j.leftRows} barcoded rows join as written, ${j.normalized}/${j.leftRows} after stripping leading zeros (${gap} rows are GTIN-14/EAN-13 padded). Use the normalized key.`
      : `${j.left} x ${j.right}: ${j.asWritten}/${j.leftRows} barcoded rows join as written; no padding found.`,
      { join: j });
  }
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
