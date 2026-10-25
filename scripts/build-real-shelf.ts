// Builds data/real/shelf.json: the rest of the retailer's food aisles, as real products.
// A seeded sample of USDA FoodData Central Branded Foods (CC0) that no FDA notice in sample/ prints
// and whose brand owner is not a recalling firm in the snapshot, so "not recalled" is a safe label.
// Together with data/real/catalog.json (recalled products and their same-brand siblings) these are
// the food lines of the synthetic retailer's item master (scripts/gen-synthetic.ts).
//   npx tsx scripts/build-real-shelf.ts [--fdc <FDC csv folder>] [--n 260] [--seed 7]
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tokens } from "../src/match.ts";
import { isValidUpc, isValidEan13 } from "./upc.ts";
import { fdcTitle, gtinKey, printedKeys } from "./build-real-catalog.ts";
import { printedUpcs } from "./off-fetch.ts";

export interface ShelfItem { id: string; upc: string; title: string; brand: string; brandName?: string; category: string; fdcId: string }
export interface Shelf { builtAt: string; source: string; seed: number; counts: Record<string, number>; items: ShelfItem[] }

/** Words of a firm or brand owner that identify it (legal suffixes and generic words dropped). */
export const firmWords = (s: string) => tokens(s).filter((w) => w.length > 2 && !/^(usa|corp|corporation|incorporated|limited|group|holdings|international|enterprises|distributors?|distribution|trading|import|imports|export|market|markets|farms?|fresh|bakery|dairy|global|america|american|north|united|national|supply|services?|company|companies|the)$/.test(w));

/** True when a brand owner shares an identifying word with any recalling firm. */
export function ownedByRecallingFirm(owner: string, firms: Set<string>): boolean {
  return firmWords(owner).some((w) => firms.has(w));
}

const validKey = (k: string) => (k.length === 12 && isValidUpc(k)) || (k.length === 13 && isValidEan13(k));

async function main() {
  const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const fdcDir = arg("fdc", `${process.env.HOME}/Downloads/fdc/FoodData_Central_branded_food_csv_2026-04-30`)!.replace(/\/$/, "");
  const n = Number(arg("n", "260"));
  const seed = Number(arg("seed", "7"));
  const feed = JSON.parse(readFileSync("sample/fda_food_enforcement.json", "utf8")) as { results: (Parameters<typeof printedUpcs>[0] & { recalling_firm: string })[] };
  const catalog = JSON.parse(readFileSync("data/real/catalog.json", "utf8")) as { items: { upc: string; brand: string }[]; negatives: { upc: string; brand: string }[] };

  const printed = new Set(feed.results.flatMap(printedUpcs).flatMap((p) => printedKeys(p.digits)));
  const firms = new Set(feed.results.flatMap((r) => firmWords(r.recalling_firm)));
  for (const x of [...catalog.items, ...catalog.negatives]) for (const w of firmWords(x.brand)) firms.add(w);
  const taken = new Set([...catalog.items, ...catalog.negatives].map((x) => x.upc));

  const { DuckDBInstance } = await import("@duckdb/node-api");
  const db = await DuckDBInstance.create(":memory:");
  const c = await db.connect();
  const q = (s: string) => s.replace(/'/g, "''");
  // A fixed reservoir sample of the whole release, then the label description from food.csv.
  await c.run(`CREATE TABLE s AS SELECT fdc_id, coalesce(brand_owner, '') AS brand_owner, coalesce(brand_name, '') AS brand_name, gtin_upc, coalesce(branded_food_category, '') AS branded_food_category, coalesce(package_weight, '') AS package_weight
    FROM read_csv('${q(fdcDir)}/branded_food.csv', header=true, all_varchar=true) USING SAMPLE reservoir(20000 ROWS) REPEATABLE (${seed})`);
  const rows = (await c.runAndReadAll(`SELECT s.*, coalesce(f.description, '') AS description FROM s JOIN read_csv('${q(fdcDir)}/food.csv', header=true, all_varchar=true) f ON f.fdc_id = s.fdc_id ORDER BY s.fdc_id`)).getRowObjects() as unknown as { fdc_id: string; brand_owner: string; brand_name: string; gtin_upc: string; branded_food_category: string; package_weight: string; description: string }[];
  c.closeSync();

  const counts = { sampled: rows.length, printedOrTaken: 0, recallingFirm: 0, badBarcode: 0, noTitle: 0, duplicate: 0 };
  const seenKey = new Set<string>(), seenTitle = new Set<string>(), perOwner = new Map<string, number>();
  const items: ShelfItem[] = [];
  for (const r of rows) {
    if (items.length >= n) break;
    const key = gtinKey(r.gtin_upc);
    const owner = r.brand_owner || r.brand_name;
    const title = fdcTitle(r);
    if (printed.has(key) || taken.has(key)) { counts.printedOrTaken++; continue; }
    if (!validKey(key)) { counts.badBarcode++; continue; }
    if (!title || !owner || !r.branded_food_category) { counts.noTitle++; continue; }
    if (ownedByRecallingFirm(owner, firms) || ownedByRecallingFirm(r.brand_name, firms)) { counts.recallingFirm++; continue; }
    // One line per barcode and title, and at most three products per brand owner, so no single maker dominates.
    if (seenKey.has(key) || seenTitle.has(title.toLowerCase()) || (perOwner.get(owner) ?? 0) >= 3) { counts.duplicate++; continue; }
    seenKey.add(key); seenTitle.add(title.toLowerCase()); perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
    items.push({ id: `FDC-${r.fdc_id}`, upc: key, title, brand: owner, brandName: r.brand_name || undefined, category: r.branded_food_category, fdcId: r.fdc_id });
  }
  const out: Shelf = { builtAt: new Date().toISOString(), source: "USDA FoodData Central Branded Foods, April 2026 release (CC0)", seed, counts: { ...counts, items: items.length }, items };
  writeFileSync("data/real/shelf.json", JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify(out.counts));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
