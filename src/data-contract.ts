// The data contract a retailer's own exports must meet for RecallWhy to run on them in place of
// data/synthetic/: six tables, their columns, keys and the same rules the Zetaris USL recall_exposure
// checks (sql/04_usl.sql). `npm run check:data -- --dir <folder of CSVs>` reports every violation;
// `npm run load -- --dir <folder>` refuses to load a folder that breaks it. See docs/DATA-CONTRACT.md.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type ColType = "text" | "int" | "date";
interface Col { name: string; type: ColType; required?: boolean }
export interface TableContract { file: string; table: string; columns: Col[]; key: string[]; refs?: { columns: string[]; table: string }[]; rules?: { name: string; test: (r: Record<string, string>) => boolean }[] }

export const CONTRACT: TableContract[] = [
  { file: "suppliers.csv", table: "supplier_portal.suppliers", key: ["supplier_id"],
    columns: [{ name: "supplier_id", type: "text", required: true }, { name: "name", type: "text" }, { name: "contact_role", type: "text" }] },
  { file: "skus.csv", table: "erp.skus", key: ["sku"], refs: [{ columns: ["supplier_id"], table: "suppliers.csv" }],
    columns: [{ name: "sku", type: "text", required: true }, { name: "upc", type: "text" }, { name: "title", type: "text", required: true }, { name: "brand", type: "text" }, { name: "department", type: "text" }, { name: "supplier_id", type: "text", required: true }],
    rules: [{ name: "upc is empty or 8–14 digits", test: (r) => r.upc === "" || /^\d{8,14}$/.test(r.upc) }] },
  { file: "stores.csv", table: "erp.stores", key: ["store_id"],
    columns: [{ name: "store_id", type: "text", required: true }, { name: "name", type: "text" }, { name: "city", type: "text" }, { name: "state", type: "text", required: true }],
    rules: [{ name: "state is a two-letter code", test: (r) => /^[A-Z]{2}$/.test(r.state) }] },
  { file: "inventory.csv", table: "erp.inventory", key: ["store_id", "sku", "lot_code"], refs: [{ columns: ["store_id"], table: "stores.csv" }, { columns: ["sku"], table: "skus.csv" }],
    columns: [{ name: "store_id", type: "text", required: true }, { name: "sku", type: "text", required: true }, { name: "lot_code", type: "text", required: true }, { name: "on_hand", type: "int", required: true }, { name: "received_on", type: "date" }],
    rules: [{ name: "on_hand_not_negative", test: (r) => Number(r.on_hand) >= 0 }] },
  { file: "sales.csv", table: "erp.sales", key: ["store_id", "sku", "lot_code", "sold_on"], refs: [{ columns: ["store_id"], table: "stores.csv" }, { columns: ["sku"], table: "skus.csv" }],
    columns: [{ name: "store_id", type: "text", required: true }, { name: "sku", type: "text", required: true }, { name: "lot_code", type: "text", required: true }, { name: "sold_on", type: "date", required: true }, { name: "units", type: "int", required: true }, { name: "loyalty_customers", type: "int" }],
    rules: [{ name: "loyalty customers at most the units sold", test: (r) => r.loyalty_customers === "" || Number(r.loyalty_customers) <= Number(r.units) }] },
  { file: "ship_notices.csv", table: "supplier_portal.ship_notices", key: ["asn_id"], refs: [{ columns: ["supplier_id"], table: "suppliers.csv" }, { columns: ["sku"], table: "skus.csv" }],
    columns: [{ name: "asn_id", type: "text", required: true }, { name: "supplier_id", type: "text", required: true }, { name: "sku", type: "text", required: true }, { name: "upc", type: "text" }, { name: "lot_code", type: "text", required: true }, { name: "shipped_on", type: "date", required: true }, { name: "units", type: "int", required: true }, { name: "dc_state", type: "text" }],
    rules: [{ name: "ships_units", test: (r) => Number(r.units) > 0 }, { name: "barcode as the supplier writes it: empty or digits, spaces and dashes", test: (r) => r.upc === "" || /^[\d -]{6,20}$/.test(r.upc) }] },
];

/** RFC 4180 CSV (quoted fields, doubled quotes). */
export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = []; let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); field = ""; if (row.length > 1 || row[0] !== "") rows.push(row); row = []; }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return { headers: rows[0] ?? [], rows: rows.slice(1) };
}

export interface Violation { file: string; rule: string; count: number; examples: string[] }

/** Every way the folder's CSVs break the contract (an empty list means it can be loaded). */
export function checkFolder(dir: string): { violations: Violation[]; rows: Record<string, number> } {
  const out: Violation[] = [], rows: Record<string, number> = {};
  const add = (file: string, rule: string, example: string) => {
    const v = out.find((x) => x.file === file && x.rule === rule) ?? (out.push({ file, rule, count: 0, examples: [] }), out[out.length - 1]);
    v.count++; if (v.examples.length < 3) v.examples.push(example);
  };
  const data = new Map<string, Record<string, string>[]>();
  for (const t of CONTRACT) {
    const f = join(dir, t.file);
    if (!existsSync(f)) { add(t.file, "file is missing", f); continue; }
    const { headers, rows: raw } = parseCsv(readFileSync(f, "utf8"));
    for (const c of t.columns) if (!headers.includes(c.name)) add(t.file, `column ${c.name} is missing`, headers.join(","));
    const recs = raw.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? "").trim()])));
    data.set(t.file, recs); rows[t.file] = recs.length;
    const seen = new Set<string>();
    recs.forEach((r, n) => {
      const at = `row ${n + 2}`;
      for (const c of t.columns) {
        const v = r[c.name] ?? "";
        if (c.required && v === "") add(t.file, `${c.name} is required`, at);
        else if (v !== "" && c.type === "int" && !/^-?\d+$/.test(v)) add(t.file, `${c.name} is a whole number`, `${at}: ${v}`);
        else if (v !== "" && c.type === "date" && !/^\d{4}-\d{2}-\d{2}/.test(v)) add(t.file, `${c.name} is a date (yyyy-mm-dd)`, `${at}: ${v}`);
      }
      const key = t.key.map((k) => r[k]).join("|");
      if (seen.has(key)) add(t.file, `key (${t.key.join(", ")}) is unique`, `${at}: ${key}`); seen.add(key);
      for (const rule of t.rules ?? []) if (!rule.test(r)) add(t.file, rule.name, at);
    });
  }
  for (const t of CONTRACT) for (const ref of t.refs ?? []) {
    const target = CONTRACT.find((x) => x.file === ref.table)!;
    const keys = new Set((data.get(ref.table) ?? []).map((r) => target.key.map((k) => r[k]).join("|")));
    for (const [n, r] of (data.get(t.file) ?? []).entries()) {
      const v = ref.columns.map((c) => r[c]).join("|");
      if (v && !keys.has(v)) add(t.file, `${ref.columns.join(", ")} must exist in ${ref.table}`, `row ${n + 2}: ${v}`);
    }
  }
  return { violations: out, rows };
}
