import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { Trace } from "../trace.ts";
import { sqlId, type SqlResult, type SqlRunner } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Minimal Spark → DuckDB dialect shim.
 * - 3-arg regexp_replace → add 'g' (Spark replaces all; DuckDB defaults to first)
 * - `a rlike b` → regexp_matches(a, b)
 */
export function toDuckDialect(sql: string): string {
  let out = sql.replace(/\brlike\b/gi, "RLIKE_MARK");
  // Infix a RLIKE_MARK b → regexp_matches(a, b). Operands are identifiers or quoted strings.
  out = out.replace(
    /([^\s,()]+)\s+RLIKE_MARK\s+([^\s,()]+)/g,
    "regexp_matches($1, $2)",
  );
  out = out.replace(/RLIKE_MARK/g, "rlike");
  return rewriteRegexpReplace(out);
}

function rewriteRegexpReplace(sql: string): string {
  const lower = sql.toLowerCase();
  let i = 0;
  let result = "";
  while (i < sql.length) {
    const idx = lower.indexOf("regexp_replace", i);
    if (idx < 0) {
      result += sql.slice(i);
      break;
    }
    result += sql.slice(i, idx);
    const open = sql.indexOf("(", idx);
    if (open < 0) {
      result += sql.slice(idx);
      break;
    }
    const { end, args } = splitCallArgs(sql, open);
    if (args.length === 3) {
      result += `regexp_replace(${args[0]}, ${args[1]}, ${args[2]}, 'g')`;
    } else {
      result += sql.slice(idx, end + 1);
    }
    i = end + 1;
  }
  return result;
}

/** Parse args of a function call starting at the opening '('. Returns index of closing ')'. */
function splitCallArgs(sql: string, openParen: number): { end: number; args: string[] } {
  const args: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = openParen + 1;
  for (let i = openParen; i < sql.length; i++) {
    const ch = sql[i]!;
    const prev = sql[i - 1];
    if (inSingle) {
      if (ch === "'" && prev !== "\\") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === '"' && prev !== "\\") inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      if (depth === 0) {
        const last = sql.slice(start, i).trim();
        if (last.length > 0 || args.length > 0) args.push(last);
        return { end: i, args };
      }
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(sql.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error("unclosed regexp_replace call");
}

function jsonCell(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  return v;
}

function rowsFromResult(
  columns: string[],
  objects: Record<string, unknown>[],
): Record<string, unknown>[] {
  return objects.map((row) => {
    const out: Record<string, unknown> = {};
    for (const col of columns) {
      out[col] = jsonCell(row[col]);
    }
    return out;
  });
}

export class DuckSampleRunner implements SqlRunner {
  readonly engine = "duckdb-sample" as const;
  private trace: Trace;
  private root: string;
  private conn: DuckDBConnection | null = null;
  readonly ready: Promise<void>;

  constructor(opts: { trace: Trace; root?: string }) {
    this.trace = opts.trace;
    this.root = opts.root ?? ROOT;
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const instance = await DuckDBInstance.create(":memory:");
    this.conn = await instance.connect();
    const c = this.conn;
    await c.run("CREATE SCHEMA erp");
    await c.run("CREATE SCHEMA supplier_portal");
    await c.run("CREATE SCHEMA recallfeeds");

    const syn = join(this.root, "data/synthetic");
    await c.run(`
      CREATE TABLE erp.stores AS
      SELECT * FROM read_csv_auto('${join(syn, "stores.csv")}', header=true,
        types={'store_id': 'VARCHAR'})
    `);
    await c.run(`
      CREATE TABLE erp.skus AS
      SELECT * FROM read_csv_auto('${join(syn, "skus.csv")}', header=true,
        types={'sku': 'VARCHAR', 'upc': 'VARCHAR', 'supplier_id': 'VARCHAR'})
    `);
    await c.run(`
      CREATE TABLE erp.inventory AS
      SELECT * FROM read_csv_auto('${join(syn, "inventory.csv")}', header=true,
        types={'store_id': 'VARCHAR', 'sku': 'VARCHAR', 'lot_code': 'VARCHAR'})
    `);
    await c.run(`
      CREATE TABLE erp.sales AS
      SELECT * FROM read_csv_auto('${join(syn, "sales.csv")}', header=true,
        types={'store_id': 'VARCHAR', 'sku': 'VARCHAR', 'lot_code': 'VARCHAR'})
    `);
    await c.run(`
      CREATE TABLE supplier_portal.suppliers AS
      SELECT * FROM read_csv_auto('${join(syn, "suppliers.csv")}', header=true,
        types={'supplier_id': 'VARCHAR'})
    `);
    await c.run(`
      CREATE TABLE supplier_portal.ship_notices AS
      SELECT * FROM read_csv_auto('${join(syn, "ship_notices.csv")}', header=true,
        types={'asn_id': 'VARCHAR', 'supplier_id': 'VARCHAR', 'sku': 'VARCHAR',
               'upc': 'VARCHAR', 'lot_code': 'VARCHAR'})
    `);

    const fdaPath = join(this.root, "sample/fda_food_enforcement.json");
    await c.run(`
      CREATE TABLE recallfeeds.fda_food AS
      SELECT
        r.recall_number,
        r.recalling_firm,
        r.product_description,
        r.reason_for_recall,
        r.code_info,
        r.more_code_info,
        r.distribution_pattern,
        r.classification,
        r.report_date,
        r.recall_initiation_date,
        r.status,
        r.product_type
      FROM (
        SELECT unnest(results) AS r
        FROM read_json_auto('${fdaPath}')
      )
    `);

    const cpscPath = join(this.root, "sample/cpsc_recalls.json");
    await c.run(`
      CREATE TABLE recallfeeds.cpsc_recalls AS
      SELECT
        RecallNumber AS recall_number,
        substr(CAST(RecallDate AS VARCHAR), 1, 10) AS recall_date,
        substr(CAST(LastPublishDate AS VARCHAR), 1, 10) AS last_publish,
        Title AS title,
        Description AS description,
        array_to_string(list_transform(Products, p -> p.Name), '|') AS product_names,
        array_to_string(list_transform(Products, p -> p.Model), '|') AS models,
        array_to_string(list_transform(ProductUPCs, u -> u.UPC), '|') AS upcs,
        array_to_string(
          list_concat(
            list_concat(
              list_transform(Manufacturers, m -> m.Name),
              list_transform(Importers, m -> m.Name)
            ),
            list_transform(Distributors, m -> m.Name)
          ),
          '|'
        ) AS firms,
        array_to_string(list_transform(Hazards, h -> h.Name), '|') AS hazard,
        URL AS url
      FROM read_json_auto('${cpscPath}')
    `);
  }

  async run(sql: string, meta: { agent: string; purpose: string }): Promise<SqlResult> {
    await this.ready;
    const id = sqlId(sql);
    const duckSql = toDuckDialect(sql);
    const t0 = Date.now();
    try {
      if (!this.conn) throw new Error("DuckSampleRunner not initialised");
      const result = await this.conn.run(duckSql);
      const columns = [...result.columnNames()];
      const objects = (await result.getRowObjects()) as Record<string, unknown>[];
      const rows = rowsFromResult(columns, objects);
      const ms = Date.now() - t0;
      this.trace.emit("sql", meta.agent, {
        engine: this.engine,
        sqlId: id,
        purpose: meta.purpose,
        sql,
        rows: rows.length,
        ms,
      });
      return { sqlId: id, engine: this.engine, columns, rows, ms };
    } catch (err) {
      const ms = Date.now() - t0;
      const error = err instanceof Error ? err.message : String(err);
      this.trace.emit("sql.error", meta.agent, {
        engine: this.engine,
        sqlId: id,
        purpose: meta.purpose,
        sql,
        rows: 0,
        ms,
        error,
      });
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.ready.catch(() => undefined);
    this.conn?.closeSync();
    this.conn = null;
  }
}

export function sampleCapturedAt(root = ROOT): string {
  try {
    return readFileSync(join(root, "sample/CAPTURED_AT"), "utf8").trim();
  } catch {
    return "unknown";
  }
}
