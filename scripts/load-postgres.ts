/**
 * Load data/synthetic/*.csv into local Postgres (erp + supplier_portal).
 * Reads .env with a tiny parser (no dotenv dependency).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data", "synthetic");

async function loadEnv(filePath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Minimal RFC4180 CSV parse (handles quoted fields). */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0]!;
  return { headers, rows: rows.slice(1) };
}

async function readCsv(name: string): Promise<{ headers: string[]; rows: string[][] }> {
  const text = await readFile(path.join(DATA, name), "utf8");
  return parseCsv(text);
}

async function batchInsert(
  client: pg.Client,
  table: string,
  columns: string[],
  rows: string[][],
  cast?: (col: string, val: string) => unknown,
): Promise<number> {
  const batchSize = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const row of chunk) {
      const ph: string[] = [];
      for (let c = 0; c < columns.length; c++) {
        const raw = row[c] ?? "";
        values.push(cast ? cast(columns[c]!, raw) : raw);
        ph.push(`$${p++}`);
      }
      placeholders.push(`(${ph.join(",")})`);
    }
    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders.join(",")}`;
    await client.query(sql, values);
    inserted += chunk.length;
  }
  return inserted;
}

async function setupErp(user: string, password: string): Promise<Record<string, number>> {
  const client = new pg.Client({
    host: "127.0.0.1",
    port: 55432,
    user,
    password,
    database: "erp",
  });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS stores (
        store_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        city TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skus (
        sku TEXT PRIMARY KEY,
        upc TEXT,
        title TEXT NOT NULL,
        brand TEXT NOT NULL,
        department TEXT NOT NULL,
        supplier_id TEXT NOT NULL,
        origin TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inventory (
        store_id TEXT NOT NULL REFERENCES stores(store_id),
        sku TEXT NOT NULL REFERENCES skus(sku),
        lot_code TEXT NOT NULL,
        on_hand INTEGER NOT NULL,
        received_on DATE NOT NULL,
        PRIMARY KEY (store_id, sku, lot_code)
      );
      CREATE TABLE IF NOT EXISTS sales (
        store_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        lot_code TEXT NOT NULL,
        sold_on DATE NOT NULL,
        units INTEGER NOT NULL,
        loyalty_customers INTEGER NOT NULL,
        PRIMARY KEY (store_id, sku, lot_code, sold_on)
      );
    `);

    await client.query("TRUNCATE sales, inventory, skus, stores CASCADE");

    const stores = await readCsv("stores.csv");
    const skus = await readCsv("skus.csv");
    const inventory = await readCsv("inventory.csv");
    const sales = await readCsv("sales.csv");

    const counts = {
      stores: await batchInsert(client, "stores", stores.headers, stores.rows),
      skus: await batchInsert(client, "skus", skus.headers, skus.rows),
      inventory: await batchInsert(client, "inventory", inventory.headers, inventory.rows, (col, v) =>
        col === "on_hand" ? Number(v) : v,
      ),
      sales: await batchInsert(client, "sales", sales.headers, sales.rows, (col, v) =>
        col === "units" || col === "loyalty_customers" ? Number(v) : v,
      ),
    };
    return counts;
  } finally {
    await client.end();
  }
}

async function setupSupplier(
  user: string,
  password: string,
): Promise<Record<string, number>> {
  const client = new pg.Client({
    host: "127.0.0.1",
    port: 55432,
    user,
    password,
    database: "supplier_portal",
  });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        supplier_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        contact_role TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ship_notices (
        asn_id TEXT PRIMARY KEY,
        supplier_id TEXT NOT NULL REFERENCES suppliers(supplier_id),
        sku TEXT NOT NULL,
        upc TEXT,
        lot_code TEXT NOT NULL,
        shipped_on DATE NOT NULL,
        units INTEGER NOT NULL,
        dc_state TEXT NOT NULL
      );
    `);

    await client.query("TRUNCATE ship_notices, suppliers CASCADE");

    const suppliers = await readCsv("suppliers.csv");
    const ships = await readCsv("ship_notices.csv");

    return {
      suppliers: await batchInsert(client, "suppliers", suppliers.headers, suppliers.rows),
      ship_notices: await batchInsert(
        client,
        "ship_notices",
        ships.headers,
        ships.rows,
        (col, v) => (col === "units" ? Number(v) : v),
      ),
    };
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  const fileEnv = await loadEnv(path.join(ROOT, ".env"));
  const user = process.env.RW_PG_USER || fileEnv.RW_PG_USER || "recallwhy";
  const password = process.env.RW_PG_PASSWORD || fileEnv.RW_PG_PASSWORD || "";
  if (!password) {
    throw new Error("RW_PG_PASSWORD missing; copy .env.example to .env and set it");
  }

  const erp = await setupErp(user, password);
  const supplier = await setupSupplier(user, password);

  console.log(
    JSON.stringify(
      {
        host: "127.0.0.1:55432",
        erp,
        supplier_portal: supplier,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
