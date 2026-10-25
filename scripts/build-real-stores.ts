// Builds data/real/stores.json: where the synthetic retailer's 24 stores stand, taken from real
// SNAP-authorized supermarkets (USDA FNS SNAP Retailer Locator, historical data 2005–2025, a US
// federal dataset in the public domain). Two active supermarkets per state, chosen by a seeded hash
// of the record id so the pick is reproducible. Only the location (address, city, state, ZIP,
// county, coordinates) is used for the store; the business's own name is kept here for provenance
// and never put on a store row, because the inventory, sales and ship notices around it are synthetic.
//   node --experimental-strip-types scripts/build-real-stores.ts --snap "<path to the SNAP CSV>" [--seed 7]
import { createReadStream, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

export const STORE_STATES = ["CA", "OR", "WA", "TX", "IL", "MN", "WI", "NY", "NJ", "PA", "FL", "GA"] as const;

export interface RealStore {
  store_id: string; city: string; state: string; zip: string; county: string; address: string;
  latitude: number; longitude: number; snapRecordId: string; snapStoreName: string; snapStoreType: string; authorized: string;
}

/** One CSV line into fields (the SNAP file quotes fields that contain commas). */
export function csvLine(line: string): string[] {
  const out: string[] = [];
  let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(f); f = ""; } else f += c;
  }
  out.push(f);
  return out;
}

const title = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ").replace(/(^|[\s\-'.])([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** Picks two active supermarkets per state, in different cities, ordered by a seeded hash of the record id. */
export function pickStores(rows: Record<string, string>[], seed: number): RealStore[] {
  const rank = (id: string) => createHash("sha256").update(`${seed}:${id}`).digest("hex");
  const out: RealStore[] = [];
  for (const state of STORE_STATES) {
    const pool = rows.filter((r) => r["State"] === state && r["Store Type"] === "Supermarket" && !r["End Date"]?.trim() && r["City"]?.trim() && Number(r["Latitude"]))
      .sort((a, b) => rank(a["Record ID"]).localeCompare(rank(b["Record ID"])));
    const cities = new Set<string>();
    for (const r of pool) {
      const city = title(r["City"]);
      if (cities.has(city)) continue;
      cities.add(city);
      out.push({
        store_id: `S${String(out.length + 1).padStart(3, "0")}`, city, state, zip: r["Zip Code"].trim().padStart(5, "0"), county: title(r["County"] ?? ""),
        address: title([r["Street Number"], r["Street Name"]].map((x) => x?.trim()).filter(Boolean).join(" ")),
        latitude: Number(r["Latitude"]), longitude: Number(r["Longitude"]),
        snapRecordId: r["Record ID"], snapStoreName: r["Store Name"].trim(), snapStoreType: r["Store Type"], authorized: r["Authorization Date"],
      });
      if (cities.size === 2) break;
    }
    if (cities.size < 2) throw new Error(`only ${cities.size} active supermarket(s) found in ${state}`);
  }
  return out;
}

async function main() {
  const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const file = arg("snap", `${process.env.HOME}/Downloads/snap/Historical SNAP Retailer Locator Data 2005-2025.csv`)!;
  const seed = Number(arg("seed", "7"));
  const keep = new Set<string>(STORE_STATES);
  let headers: string[] | undefined;
  const rows: Record<string, string>[] = [];
  let read = 0;
  for await (const raw of createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })) {
    const line = raw.replace(/^﻿/, "");
    if (!headers) { headers = csvLine(line).map((h) => h.trim()); continue; }
    read++;
    const f = csvLine(line);
    const r = Object.fromEntries(headers.map((h, i) => [h, f[i] ?? ""]));
    if (keep.has(r["State"]) && r["Store Type"] === "Supermarket") rows.push(r);
  }
  const stores = pickStores(rows, seed);
  writeFileSync("data/real/stores.json", JSON.stringify({
    builtAt: new Date().toISOString(),
    source: "USDA FNS SNAP Retailer Locator, Historical SNAP Retailer Locator Data 2005-2025 (US federal data, public domain): https://www.fns.usda.gov/snap/retailer-locator/data",
    rule: "active (no end date) stores of type Supermarket, two per state in different cities, ordered by sha256(seed:record id)",
    seed, counts: { rowsRead: read, supermarketsInStates: rows.length, stores: stores.length }, stores,
  }, null, 1) + "\n");
  console.log(JSON.stringify({ rowsRead: read, supermarketsInStates: rows.length, stores: stores.length }));
}

if (process.argv[1]?.endsWith("build-real-stores.ts")) main().catch((e) => { console.error(e); process.exit(1); });
