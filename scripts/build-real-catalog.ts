// Builds data/real/catalog.json: a real product catalog for the text-match evaluation (eval/real-items.ts).
//   Positives: products whose barcode an FDA food-enforcement notice prints, found in USDA FoodData
//              Central Branded Foods (CC0; preferred) or, when FDC lacks the barcode, Open Food Facts
//              (ODbL; data/real/off_items.json from scripts/off-fetch.ts).
//   Same-brand negatives: for every FDC positive, up to two other FDC products of the SAME brand
//              owner (or brand name) with a different description, not printed in any notice,
//              preferring a different food category. These are the "we buy from this firm but a
//              different product" lines a real item master is full of.
// Only the rows used are written. Re-runnable from the FDC csv folder plus the OFF file:
//   npx tsx scripts/build-real-catalog.ts --fdc ~/Downloads/fdc/FoodData_Central_branded_food_csv_2026-04-30 [--off data/real/off_items.json] [--out data/real/catalog.json]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { tokens } from "../src/match.ts";
import { codeVariants, printedUpcs, type OffItem } from "./off-fetch.ts";

export interface RealItem {
  id: string; source: "fdc" | "off"; upc: string; title: string; brand: string;
  brandName?: string; category?: string; packageWeight?: string; fdcId?: string; offCode?: string; url?: string;
  printedUpc: string; recall_numbers: string[];
}
export interface RealNegative { id: string; upc: string; title: string; brand: string; brandName?: string; category?: string; fdcId: string; forItem: string }
export interface RealCatalog { builtAt: string; sources: string[]; fdcDir: string; offFile: string; counts: Record<string, number>; items: RealItem[]; negatives: RealNegative[] }

/** Barcode as a catalog key: digits only, no leading zeros, padded to 12 (a GTIN-13 that does not start with 0 keeps 13). */
export function gtinKey(code: string): string {
  const bare = (code ?? "").replace(/[^0-9]/g, "").replace(/^0+/, "");
  return bare.length <= 12 ? bare.padStart(12, "0") : bare;
}

/** Every key a printed number can stand for (a 14-digit case code also as its unit GTIN). */
export const printedKeys = (digits: string) => [...new Set([gtinKey(digits), ...codeVariants(digits).map(gtinKey)])];

const hasSize = (s: string) => /\d\s*-?\s*(oz|ounces?|lbs?|pounds?|#|g|grams?|kg|ml|l|ct|count|pk|pack|gal|fl)\b/i.test(s);

interface FdcRow { fdc_id: string; brand_owner: string; brand_name: string; gtin_upc: string; branded_food_category: string; package_weight: string; description: string; key: string }

/** Our item-master title for an FDC row: the label description, plus the package weight when the description carries no size. */
export function fdcTitle(r: Pick<FdcRow, "description" | "package_weight">): string {
  const d = (r.description ?? "").trim();
  const w = (r.package_weight ?? "").split("/")[0].trim();
  return d && w && !hasSize(d) ? `${d} ${w}` : d;
}

/** Up to `max` same-brand products that are a different product: other key, other description, never printed, different category first, then most similar wording. */
export function pickNegatives(item: { key: string; description: string; category: string }, pool: FdcRow[], printed: Set<string>, max = 2): FdcRow[] {
  const mine = new Set(tokens(item.description));
  const seen = new Set<string>([item.key]);
  const seenDesc = new Set<string>([item.description.toLowerCase()]);
  const scored = pool
    .filter((r) => r.key !== item.key && !printed.has(r.key) && r.description && r.description.toLowerCase() !== item.description.toLowerCase())
    .map((r) => ({ r, cat: r.branded_food_category === item.category ? 1 : 0, overlap: tokens(r.description).filter((w) => mine.has(w)).length }))
    .sort((a, b) => a.cat - b.cat || b.overlap - a.overlap || Number(a.r.fdc_id) - Number(b.r.fdc_id));
  const out: FdcRow[] = [];
  for (const { r } of scored) {
    if (seen.has(r.key) || seenDesc.has(r.description.toLowerCase())) continue;
    seen.add(r.key); seenDesc.add(r.description.toLowerCase());
    out.push(r);
    if (out.length >= max) break;
  }
  return out;
}

const sql = (s: string) => s.replace(/'/g, "''");

async function main() {
  const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const fdcDir = arg("fdc", `${process.env.HOME}/Downloads/fdc/FoodData_Central_branded_food_csv_2026-04-30`)!.replace(/\/$/, "");
  const offFile = arg("off", "data/real/off_items.json")!;
  const outFile = arg("out", "data/real/catalog.json")!;
  const feed = JSON.parse(readFileSync(arg("feed", "sample/fda_food_enforcement.json")!, "utf8")) as { results: Parameters<typeof printedUpcs>[0][] };
  const off = existsSync(offFile) ? (JSON.parse(readFileSync(offFile, "utf8")) as { items: OffItem[] }) : { items: [] };

  // Every barcode a notice prints, by catalog key.
  const printed = new Map<string, { printed: string; recalls: Set<string> }>();
  for (const p of feed.results.flatMap(printedUpcs)) for (const k of printedKeys(p.digits)) {
    const e = printed.get(k) ?? { printed: p.printed, recalls: new Set<string>() };
    e.recalls.add(p.recall_number); printed.set(k, e);
  }

  const { DuckDBInstance } = await import("@duckdb/node-api");
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  const keyExpr = `CASE WHEN length(ltrim(regexp_replace(gtin_upc, '[^0-9]', '', 'g'), '0')) <= 12 THEN lpad(ltrim(regexp_replace(gtin_upc, '[^0-9]', '', 'g'), '0'), 12, '0') ELSE ltrim(regexp_replace(gtin_upc, '[^0-9]', '', 'g'), '0') END`;
  await c.run(`CREATE TABLE bf AS SELECT fdc_id, coalesce(brand_owner, '') AS brand_owner, coalesce(brand_name, '') AS brand_name, gtin_upc, coalesce(branded_food_category, '') AS branded_food_category, coalesce(package_weight, '') AS package_weight, modified_date, ${keyExpr} AS key FROM read_csv('${sql(fdcDir)}/branded_food.csv', header=true, all_varchar=true)`);
  await c.run(`CREATE TABLE keys(key VARCHAR)`);
  await c.run(`INSERT INTO keys VALUES ${[...printed.keys()].map((k) => `('${sql(k)}')`).join(",")}`);
  // One row per printed key: the most recently modified FDC record.
  await c.run(`CREATE TABLE hits AS SELECT * FROM (SELECT b.*, row_number() OVER (PARTITION BY b.key ORDER BY b.modified_date DESC, b.fdc_id DESC) rn FROM bf b JOIN keys k ON k.key = b.key) WHERE rn = 1`);
  // The pool for negatives: every FDC product of a brand owner (or brand name) that owns a hit.
  await c.run(`CREATE TABLE pool AS SELECT DISTINCT b.* FROM bf b WHERE (b.brand_owner <> '' AND b.brand_owner IN (SELECT brand_owner FROM hits)) OR (b.brand_name <> '' AND lower(b.brand_name) IN (SELECT lower(brand_name) FROM hits WHERE brand_name <> ''))`);
  await c.run(`CREATE TABLE need AS SELECT fdc_id FROM hits UNION SELECT fdc_id FROM pool`);
  await c.run(`CREATE TABLE food AS SELECT f.fdc_id, f.description FROM read_csv('${sql(fdcDir)}/food.csv', header=true, all_varchar=true) f JOIN need n ON n.fdc_id = f.fdc_id`);
  const read = async (table: string) => (await c.runAndReadAll(`SELECT t.fdc_id, t.brand_owner, t.brand_name, t.gtin_upc, t.branded_food_category, t.package_weight, t.key, coalesce(f.description, '') AS description FROM ${table} t LEFT JOIN food f ON f.fdc_id = t.fdc_id ORDER BY t.fdc_id`)).getRowObjects() as unknown as FdcRow[];
  const hits = await read("hits");
  const pool = await read("pool");
  c.closeSync();

  const items: RealItem[] = [];
  const negatives: RealNegative[] = [];
  const printedKeySet = new Set(printed.keys());
  for (const h of hits) {
    const p = printed.get(h.key)!;
    const title = fdcTitle(h);
    if (!title) continue;
    const id = `FDC-${h.fdc_id}`;
    items.push({ id, source: "fdc", upc: h.key, title, brand: h.brand_owner || h.brand_name || "(unknown)", brandName: h.brand_name || undefined, category: h.branded_food_category || undefined,
      packageWeight: h.package_weight || undefined, fdcId: h.fdc_id, url: `https://fdc.nal.usda.gov/food-details/${h.fdc_id}/nutrients`, printedUpc: p.printed, recall_numbers: [...p.recalls].sort() });
    const same = pool.filter((r) => (h.brand_owner && r.brand_owner === h.brand_owner) || (h.brand_name && r.brand_name.toLowerCase() === h.brand_name.toLowerCase()));
    for (const n of pickNegatives({ key: h.key, description: h.description, category: h.branded_food_category }, same, printedKeySet))
      negatives.push({ id: `FDC-${n.fdc_id}`, upc: n.key, title: fdcTitle(n), brand: n.brand_owner || n.brand_name || "(unknown)", brandName: n.brand_name || undefined, category: n.branded_food_category || undefined, fdcId: n.fdc_id, forItem: id });
  }
  // OFF products whose barcode FDC does not have (one per barcode; all notices printing it).
  const inFdc = new Set(items.map((i) => i.upc));
  const byCode = new Map<string, RealItem>();
  for (const o of off.items) {
    const key = gtinKey(o.code);
    if (inFdc.has(key) || !o.product_name?.trim()) continue;
    const e = byCode.get(key);
    if (e) { if (!e.recall_numbers.includes(o.recall_number)) e.recall_numbers.push(o.recall_number); continue; }
    const recalls = new Set<string>([o.recall_number, ...(printed.get(key)?.recalls ?? [])]);
    byCode.set(key, { id: `OFF-${createHash("sha1").update(key).digest("hex").slice(0, 8)}`, source: "off", upc: key, title: [o.product_name, o.quantity].filter(Boolean).join(" ").trim(), brand: o.brands || "(unknown)",
      offCode: o.code, url: o.source, printedUpc: o.printedUpc, recall_numbers: [...recalls].sort() });
  }
  items.push(...byCode.values());
  const counts = { printedKeys: printed.size, fdcPositives: hits.length, offOnlyPositives: byCode.size, items: items.length, sameBrandNegatives: negatives.length, itemsWithSameBrandNegative: new Set(negatives.map((n) => n.forItem)).size };
  const out: RealCatalog = { builtAt: new Date().toISOString(), sources: ["USDA FoodData Central Branded Foods (CC0)", "Open Food Facts (ODbL)"], fdcDir: fdcDir.replace(process.env.HOME ?? "~", "~"), offFile, counts, items, negatives };
  mkdirSync("data/real", { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(counts, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
