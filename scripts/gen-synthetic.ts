/**
 * Deterministic synthetic retailer catalog for Northwind Mercantile (synthetic).
 * Reads sample CPSC/FDA recall snapshots and writes CSVs under data/synthetic/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gtin12CheckDigit, isValidUpc } from "./upc.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "synthetic");

const STATES = ["CA", "OR", "WA", "TX", "IL", "MN", "WI", "NY", "NJ", "PA", "FL", "GA"] as const;

const FICTIONAL_CITIES: Record<(typeof STATES)[number], [string, string]> = {
  CA: ["Amber Ridge", "Cedar Hollow"],
  OR: ["Pinecrest Vale", "Riverbend Mills"],
  WA: ["Fog Harbor", "Summit Creek"],
  TX: ["Mesquite Flats", "Bluebonnet Crossing"],
  IL: ["Prairie View", "Lakewood Bend"],
  MN: ["Northpine", "Crystal Falls"],
  WI: ["Maple Grove Mills", "Bayfront Knoll"],
  NY: ["Hudson Reach", "Stonebridge"],
  NJ: ["Cedar Falls", "Meadowbrook"],
  PA: ["Ironwood", "Valley Forge Hill"],
  FL: ["Palm Dunes", "Coral Springs Bay"],
  GA: ["Peachtree Ridge", "Magnolia Bend"],
};

const CONTACT_ROLES = [
  "Quality manager",
  "Compliance lead",
  "Logistics coordinator",
  "Recall desk",
  "Account manager",
  "Warehouse supervisor",
];

const DECOY_KINDS = [
  "paper towels",
  "garden hose",
  "salsa",
  "flashlight",
  "notebook",
  "dish soap",
  "extension cord",
  "yoga mat",
  "coffee filters",
  "trash bags",
  "batteries",
  "screwdrivers",
];

const DEPARTMENTS: Record<string, string[]> = {
  Grocery: ["pasta", "rice", "cereal", "beans", "soup", "crackers", "jam", "oil", "vinegar", "sauce"],
  Produce: ["apples", "lettuce", "carrots", "berries", "spinach", "tomatoes", "pears", "kale"],
  Baby: ["diapers", "wipes", "formula", "bottles", "pacifiers", "bibs"],
  Toys: ["blocks", "puzzles", "dolls", "action figures", "board games", "plush"],
  Home: ["candles", "towels", "pillows", "frames", "baskets", "rugs"],
  Hardware: ["hammers", "nails", "tape", "glue", "pliers", "screws"],
  Sporting: ["balls", "weights", "helmets", "gloves", "nets", "rackets"],
  Electronics: ["cables", "chargers", "earbuds", "speakers", "adapters", "keyboards"],
};

const SYLLABLES_A = ["Nor", "Bel", "Cal", "Dor", "Fen", "Glen", "Har", "Jun", "Kel", "Lum", "Mer", "Oak", "Pax", "Quin", "Riv", "Sol", "Tor", "Vex", "Wil", "Zen"];
const SYLLABLES_B = ["wood", "field", "stone", "brook", "vale", "crest", "ridge", "haven", "dale", "ford"];
const BRAND_SUFFIXES = ["Co", "Farms", "Home"];

type CpscRecall = {
  RecallNumber: string;
  RecallDate: string;
  Title: string;
  Description: string;
  Products?: { Name?: string; Model?: string; Description?: string }[];
  ProductUPCs?: { UPC?: string }[];
  Manufacturers?: { Name?: string }[];
  Retailers?: { Name?: string }[];
  Distributors?: { Name?: string }[];
};

type FdaRecall = {
  recall_number: string;
  recalling_firm: string;
  product_description: string;
  code_info: string;
  distribution_pattern: string;
  recall_initiation_date: string;
  report_date: string;
};

type SkuRow = {
  sku: string;
  upc: string;
  title: string;
  brand: string;
  department: string;
  supplier_id: string;
  origin: "from_recall" | "decoy" | "background";
  recallLots?: string[];
};

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseArgs(argv: string[]): { seed: number } {
  let seed = 7;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed" && argv[i + 1]) {
      seed = Number(argv[++i]);
      if (!Number.isFinite(seed)) throw new Error("invalid --seed");
    }
  }
  return { seed };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function shuffle<T>(rng: () => number, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function sampleN<T>(rng: () => number, arr: readonly T[], n: number): T[] {
  return shuffle(rng, [...arr]).slice(0, Math.min(n, arr.length));
}

function csvEscape(value: string | number): string {
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(filePath: string, headers: string[], rows: (string | number)[][]): Promise<void> {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return writeFile(filePath, lines.join("\n") + "\n", "utf8");
}

function randomDigits(rng: () => number, n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String(Math.floor(rng() * 10));
  return s;
}

function randomValidUpc(rng: () => number): string {
  const first11 = randomDigits(rng, 11);
  return first11 + gtin12CheckDigit(first11);
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function randomDateBetween(rng: () => number, start: Date, end: Date): string {
  const t = start.getTime() + rng() * (end.getTime() - start.getTime());
  const d = new Date(t);
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const ms = Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!);
  return Math.floor(ms / 86_400_000);
}

/** Extract UPC digits from free text; return 12-digit UPC or null. */
function extractUpcFromText(text: string, rng: () => number): string | null {
  const cleaned = text.replace(/[\s\-]/g, "");
  const m = cleaned.match(/\b(\d{11,12})\b/) ?? cleaned.match(/(\d{11,12})/);
  if (!m) return null;
  const digits = m[1]!;
  if (digits.length === 12 && isValidUpc(digits)) return digits;
  if (digits.length === 12) return digits.slice(0, 11) + gtin12CheckDigit(digits.slice(0, 11));
  if (digits.length === 11) return digits + gtin12CheckDigit(digits);
  return null;
}

/** Lot tokens from FDA code_info. Excludes Best By / Use By dates. */
export function parseLotCodes(codeInfo: string): string[] {
  if (!codeInfo) return [];
  const lots: string[] = [];
  const re =
    /(?:Lot\s*(?:#|Code|Codes|No\.?|Number)?\s*[:\-]?\s*)([A-Za-z0-9][A-Za-z0-9\/\-\s,]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(codeInfo)) !== null) {
    const chunk = match[1]!;
    for (const part of chunk.split(/[,;]/)) {
      const token = part.trim().replace(/\s+/g, " ");
      if (!token) continue;
      if (/^(best\s*by|use\s*by|exp(?:iration)?|sell\s*by)\b/i.test(token)) continue;
      if (/^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/.test(token)) continue;
      const cleaned = token.replace(/\.$/, "").trim();
      if (cleaned.length >= 1 && cleaned.length <= 32) lots.push(cleaned);
    }
  }
  // Also catch patterns like "lot: 25/08001"
  const simple = codeInfo.match(/\blot[:\s#]+([A-Za-z0-9][A-Za-z0-9\/\-]*)/gi);
  if (simple) {
    for (const s of simple) {
      const t = s.replace(/^lot[:\s#]+/i, "").trim();
      if (t && !lots.includes(t)) lots.push(t);
    }
  }
  return [...new Set(lots)];
}

function brandFromFdaDescription(desc: string): string {
  const words = desc.replace(/[;,].*$/, "").trim().split(/\s+/).filter(Boolean);
  const stop = new Set(["organic", "the", "a", "an", "net", "wt", "containing"]);
  const kept: string[] = [];
  for (const w of words) {
    if (stop.has(w.toLowerCase()) && kept.length === 0) continue;
    kept.push(w.replace(/[^A-Za-z0-9&'-]/g, ""));
    if (kept.length >= 3) break;
    // stop before common product nouns if we already have a brand-ish token
    if (kept.length >= 2 && /^(powder|mix|milk|juice|sauce|bar|chips|cookies|cereal)$/i.test(w)) break;
  }
  return (kept.join(" ") || "Generic Brand").slice(0, 40);
}

function retailerTitleFromFda(desc: string): string {
  let t = desc
    .replace(/\bUPC\b.*$/i, "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bnet\s*wt\.?\s*/gi, "")
    .replace(/\bcontaining\b.*?(?=,|\(|$)/gi, "")
    .replace(/\b(delicious|premium|all[- ]natural|farm[- ]fresh|handcrafted)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  // Keep size tokens like 5OZ / 5.0 oz → 5OZ
  t = t.replace(/(\d+(?:\.\d+)?)\s*(oz|lb|g|kg|ml|ct)\b/gi, (_, n, u) => `${String(n).replace(/\./g, "")}${u.toUpperCase()}`);
  // Uppercase short abbreviations
  t = t
    .split(" ")
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w))
    .join(" ");
  if (t.length > 80) t = t.slice(0, 77) + "...";
  return t || "FOOD ITEM";
}

function brandFromCpsc(r: CpscRecall): string {
  const mfr = r.Manufacturers?.[0]?.Name;
  if (mfr) {
    const first = mfr.split(/[,\-]/)[0]!.trim().split(/\s+/).slice(0, 2).join(" ");
    if (first) return first.slice(0, 40);
  }
  const titleWords = r.Title.replace(/™|®/g, "").split(/\s+/);
  const stop = new Set(["company", "recalls", "inc", "llc", "due", "to", "of", "the", "a"]);
  const kept: string[] = [];
  for (const w of titleWords) {
    const clean = w.replace(/[^A-Za-z0-9&]/g, "");
    if (!clean || stop.has(clean.toLowerCase())) {
      if (kept.length) break;
      continue;
    }
    kept.push(clean);
    if (kept.length >= 2) break;
  }
  return (kept.join(" ") || "Consumer Brand").slice(0, 40);
}

function cpscTitle(r: CpscRecall, includeModel: boolean): string {
  const name = (r.Products?.[0]?.Name || r.Title.split(/Due to|Recalls/)[0] || "Product")
    .replace(/™|®/g, "")
    .trim();
  const model =
    r.Products?.[0]?.Model ||
    (r.Description.match(/model\s*(?:number\s*)?([A-Z0-9][A-Z0-9\-]+)/i)?.[1] ?? "");
  if (includeModel && model) return `${name} ${model}`.slice(0, 100);
  return name.slice(0, 100);
}

function departmentForOrigin(origin: SkuRow["origin"], title: string, rng: () => number): string {
  if (origin === "from_recall") {
    const t = title.toLowerCase();
    if (/toy|doll|puzzle|block/.test(t)) return "Toys";
    if (/diaper|formula|baby|pacifier/.test(t)) return "Baby";
    if (/hose|hammer|screw|nail|tape|drill/.test(t)) return "Hardware";
    if (/ball|helmet|racket|weight/.test(t)) return "Sporting";
    if (/cable|charger|speaker|laminator|electronic/.test(t)) return "Electronics";
    if (/apple|lettuce|berry|produce|sprout/.test(t)) return "Produce";
    if (/towel|pillow|candle|rug/.test(t)) return "Home";
    return pick(rng, ["Grocery", "Home", "Hardware", "Toys"]);
  }
  return pick(rng, Object.keys(DEPARTMENTS));
}

function generatedBrand(rng: () => number): string {
  return `${pick(rng, SYLLABLES_A)}${pick(rng, SYLLABLES_B)} ${pick(rng, BRAND_SUFFIXES)}`;
}

async function main(): Promise<void> {
  const { seed } = parseArgs(process.argv.slice(2));
  const rng = mulberry32(seed);

  const cpsc = JSON.parse(
    await readFile(path.join(ROOT, "sample", "cpsc_recalls.json"), "utf8"),
  ) as CpscRecall[];
  const fdaRaw = JSON.parse(
    await readFile(path.join(ROOT, "sample", "fda_food_enforcement.json"), "utf8"),
  ) as { results: FdaRecall[] };
  const fda = fdaRaw.results;

  await mkdir(OUT, { recursive: true });

  // --- stores (24) ---
  const stores: { store_id: string; name: string; city: string; state: string }[] = [];
  let storeNum = 1;
  for (const state of STATES) {
    for (const city of FICTIONAL_CITIES[state]) {
      const id = `S${String(storeNum).padStart(3, "0")}`;
      stores.push({
        store_id: id,
        name: `Northwind #${String(storeNum).padStart(3, "0")} ${city}`,
        city,
        state,
      });
      storeNum++;
    }
  }

  // --- suppliers (40) ---
  const suppliers = Array.from({ length: 40 }, (_, i) => ({
    supplier_id: `SUP${String(i + 1).padStart(3, "0")}`,
    name: `Supplier S${String(i + 1).padStart(3, "0")} (synthetic)`,
    contact_role: pick(rng, CONTACT_ROLES),
  }));

  // --- SKUs ---
  const skus: SkuRow[] = [];
  let skuSeq = 100000;

  const nextSku = () => {
    skuSeq += 1 + Math.floor(rng() * 3);
    return `NW-${skuSeq}`;
  };

  const fdaPicked = sampleN(rng, fda, 70);
  const cpscPicked = sampleN(rng, cpsc, 50);

  for (const r of fdaPicked) {
    const brand = brandFromFdaDescription(r.product_description);
    const title = retailerTitleFromFda(r.product_description);
    let upc = extractUpcFromText(r.product_description, rng) ?? "";
    if (!upc) {
      upc = rng() < 0.5 ? "" : randomValidUpc(rng);
    }
    const lots = parseLotCodes(r.code_info ?? "");
    skus.push({
      sku: nextSku(),
      upc,
      title,
      brand,
      department: "Grocery",
      supplier_id: pick(rng, suppliers).supplier_id,
      origin: "from_recall",
      recallLots: lots,
    });
  }

  for (const r of cpscPicked) {
    const includeModel = rng() < 0.7;
    const title = cpscTitle(r, includeModel);
    const brand = brandFromCpsc(r);
    const upcFromFeed = r.ProductUPCs?.map((u) => (u.UPC ?? "").replace(/\D/g, "")).find(
      (d) => d.length === 11 || d.length === 12,
    );
    let upc = "";
    if (upcFromFeed) {
      upc =
        upcFromFeed.length === 11
          ? upcFromFeed + gtin12CheckDigit(upcFromFeed)
          : upcFromFeed.slice(0, 11) + gtin12CheckDigit(upcFromFeed.slice(0, 11));
    } else {
      upc = rng() < 0.5 ? "" : randomValidUpc(rng);
    }
    skus.push({
      sku: nextSku(),
      upc,
      title,
      brand,
      department: departmentForOrigin("from_recall", title, rng),
      supplier_id: pick(rng, suppliers).supplier_id,
      origin: "from_recall",
    });
  }

  // ~40 decoys: same brand as a recall SKU, unrelated product kind
  const recallSkus = skus.filter((s) => s.origin === "from_recall");
  const decoyCount = 40;
  for (let i = 0; i < decoyCount; i++) {
    const base = pick(rng, recallSkus);
    const kind = pick(rng, DECOY_KINDS);
    const title = `${base.brand} ${kind}`.slice(0, 80);
    skus.push({
      sku: nextSku(),
      upc: randomValidUpc(rng),
      title,
      brand: base.brand,
      department: departmentForOrigin("decoy", title, rng),
      supplier_id: pick(rng, suppliers).supplier_id,
      origin: "decoy",
    });
  }

  // Background SKUs to reach ~900 total
  const targetTotal = 900;
  while (skus.length < targetTotal) {
    const dept = pick(rng, Object.keys(DEPARTMENTS));
    const kind = pick(rng, DEPARTMENTS[dept]!);
    const brand = generatedBrand(rng);
    const size = pick(rng, ["", " 12OZ", " 16OZ", " 2PK", " 4CT"]);
    skus.push({
      sku: nextSku(),
      upc: randomValidUpc(rng),
      title: `${brand} ${kind}${size}`.slice(0, 80),
      brand,
      department: dept,
      supplier_id: pick(rng, suppliers).supplier_id,
      origin: "background",
    });
  }

  // --- inventory ---
  const invStart = new Date(Date.UTC(2026, 5, 1));
  const invEnd = new Date(Date.UTC(2026, 9, 15));
  const inventory: {
    store_id: string;
    sku: string;
    lot_code: string;
    on_hand: number;
    received_on: string;
  }[] = [];

  // Track (sku, lot) → dc_state + units + earliest received for ship notices
  type ShipAgg = {
    supplier_id: string;
    upc: string;
    dc_state: string;
    units: number;
    received_on: string;
  };
  const shipAgg = new Map<string, ShipAgg>();

  for (const store of stores) {
    for (const sku of skus) {
      if (rng() >= 0.35) continue;
      const lotCount = 1 + Math.floor(rng() * 3);
      const usedLots = new Set<string>();
      for (let i = 0; i < lotCount; i++) {
        let lot: string;
        if (
          sku.origin === "from_recall" &&
          sku.recallLots &&
          sku.recallLots.length > 0 &&
          rng() < 0.5
        ) {
          lot = pick(rng, sku.recallLots);
        } else {
          lot = `L${24 + Math.floor(rng() * 2)}-${String(1000 + Math.floor(rng() * 9000))}`;
        }
        if (usedLots.has(lot)) continue;
        usedLots.add(lot);
        const received_on = randomDateBetween(rng, invStart, invEnd);
        const on_hand = Math.floor(rng() * 61);
        inventory.push({
          store_id: store.store_id,
          sku: sku.sku,
          lot_code: lot,
          on_hand,
          received_on,
        });

        const key = `${sku.sku}|${lot}`;
        const receivedUnits = on_hand + Math.floor(rng() * 40); // inbound before sales
        const existing = shipAgg.get(key);
        if (!existing || received_on < existing.received_on) {
          shipAgg.set(key, {
            supplier_id: sku.supplier_id,
            upc: sku.upc,
            dc_state: store.state,
            units: (existing?.units ?? 0) + Math.max(receivedUnits, 1),
            received_on,
          });
        } else {
          existing.units += Math.max(receivedUnits, 1);
        }
      }
    }
  }

  // --- sales (sample to keep under ~60k) ---
  const salesEnd = "2026-10-18";
  const sales: {
    store_id: string;
    sku: string;
    lot_code: string;
    sold_on: string;
    units: number;
    loyalty_customers: number;
  }[] = [];

  const invSample =
    inventory.length > 12_000
      ? sampleN(rng, inventory, 12_000)
      : inventory;

  for (const row of invSample) {
    const span = daysBetween(row.received_on, salesEnd);
    if (span < 7) continue;
    // weekly from received_on
    for (let offset = 7; offset <= span; offset += 7) {
      if (rng() > 0.55) continue; // subsample weeks
      const sold_on = addDays(row.received_on, offset);
      if (sold_on > salesEnd) break;
      const units = Math.floor(rng() * 16);
      const loyalty_customers = units === 0 ? 0 : Math.floor(rng() * (units + 1));
      sales.push({
        store_id: row.store_id,
        sku: row.sku,
        lot_code: row.lot_code,
        sold_on,
        units,
        loyalty_customers,
      });
      if (sales.length >= 58_000) break;
    }
    if (sales.length >= 58_000) break;
  }

  // --- ship_notices ---
  const ship_notices: {
    asn_id: string;
    supplier_id: string;
    sku: string;
    upc: string;
    lot_code: string;
    shipped_on: string;
    units: number;
    dc_state: string;
  }[] = [];
  let asn = 1;
  for (const [key, agg] of shipAgg) {
    const [sku, lot_code] = key.split("|") as [string, string];
    const lag = 2 + Math.floor(rng() * 5);
    const shipped_on = addDays(agg.received_on, -lag);
    ship_notices.push({
      asn_id: `ASN-${String(asn++).padStart(6, "0")}`,
      supplier_id: agg.supplier_id,
      sku,
      upc: agg.upc,
      lot_code,
      shipped_on,
      units: agg.units,
      dc_state: agg.dc_state,
    });
  }

  await writeCsv(
    path.join(OUT, "stores.csv"),
    ["store_id", "name", "city", "state"],
    stores.map((s) => [s.store_id, s.name, s.city, s.state]),
  );
  await writeCsv(
    path.join(OUT, "suppliers.csv"),
    ["supplier_id", "name", "contact_role"],
    suppliers.map((s) => [s.supplier_id, s.name, s.contact_role]),
  );
  await writeCsv(
    path.join(OUT, "skus.csv"),
    ["sku", "upc", "title", "brand", "department", "supplier_id", "origin"],
    skus.map((s) => [s.sku, s.upc, s.title, s.brand, s.department, s.supplier_id, s.origin]),
  );
  await writeCsv(
    path.join(OUT, "inventory.csv"),
    ["store_id", "sku", "lot_code", "on_hand", "received_on"],
    inventory.map((r) => [r.store_id, r.sku, r.lot_code, r.on_hand, r.received_on]),
  );
  await writeCsv(
    path.join(OUT, "sales.csv"),
    ["store_id", "sku", "lot_code", "sold_on", "units", "loyalty_customers"],
    sales.map((r) => [r.store_id, r.sku, r.lot_code, r.sold_on, r.units, r.loyalty_customers]),
  );
  await writeCsv(
    path.join(OUT, "ship_notices.csv"),
    ["asn_id", "supplier_id", "sku", "upc", "lot_code", "shipped_on", "units", "dc_state"],
    ship_notices.map((r) => [
      r.asn_id,
      r.supplier_id,
      r.sku,
      r.upc,
      r.lot_code,
      r.shipped_on,
      r.units,
      r.dc_state,
    ]),
  );

  const originCounts = {
    from_recall: skus.filter((s) => s.origin === "from_recall").length,
    decoy: skus.filter((s) => s.origin === "decoy").length,
    background: skus.filter((s) => s.origin === "background").length,
  };

  const readme = `# Synthetic retailer data — Northwind Mercantile (synthetic)

**Every row in these CSVs is synthetic.** No real store addresses, no person names, no emails,
no loyalty identities. Store cities are invented place names. \`loyalty_customers\` is a count
only.

## How it was made

Generated by \`npm run gen\` (\`scripts/gen-synthetic.ts\`) with mulberry32 PRNG seed **${seed}**.

Inputs (public recall snapshots under \`sample/\`, captured per \`sample/CAPTURED_AT\`):
- \`sample/cpsc_recalls.json\` — CPSC saferproducts.gov recalls
- \`sample/fda_food_enforcement.json\` — openFDA food enforcement results

### Files

| File | Rows (approx) | Notes |
|------|---------------|-------|
| stores.csv | ${stores.length} | Fictional Northwind stores across ${STATES.length} US states |
| suppliers.csv | ${suppliers.length} | Fictional suppliers; contact_role only |
| skus.csv | ${skus.length} | origin=${JSON.stringify(originCounts)} |
| inventory.csv | ${inventory.length} | ~35% of SKUs per store; 1–3 lots |
| sales.csv | ${sales.length} | Weekly sampled sales through 2026-10-18 |
| ship_notices.csv | ${ship_notices.length} | One ASN per (sku, lot) to a DC state |

### SKU origins

- **from_recall** — built from ~70 FDA + ~50 CPSC notices so the catalog overlaps the feeds
  (UPCs/lots where parseable; CPSC titles omit the model ~30% of the time).
- **decoy** — same brand as a recall SKU, unrelated product kind (hard negative for text match).
- **background** — invented brand × department product kinds with random valid UPCs.

Lot codes on FDA from_recall inventory rows use a parsed \`code_info\` lot with probability 0.5;
otherwise a random \`L24-####\` style code. Best By / Use By dates are never treated as lots.

Regenerate with: \`npm run gen -- --seed ${seed}\`
`;

  await writeFile(path.join(OUT, "README.md"), readme, "utf8");

  console.log(
    JSON.stringify(
      {
        mode: "SAMPLE",
        seed,
        stores: stores.length,
        suppliers: suppliers.length,
        skus: skus.length,
        originCounts,
        inventory: inventory.length,
        sales: sales.length,
        ship_notices: ship_notices.length,
        out: OUT,
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
