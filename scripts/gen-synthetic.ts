/**
 * Deterministic synthetic retailer catalog for Northwind Mercantile (synthetic).
 * Reads sample CPSC/FDA recall snapshots and writes CSVs under data/synthetic/.
 */
import { lotsFromCodeInfo } from "../src/feeds.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gtin12CheckDigit, isValidUpc } from "./upc.ts";
import type { RealCatalog } from "./build-real-catalog.ts";
import type { Shelf } from "./build-real-shelf.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "synthetic");

/**
 * How a supplier writes the barcode on its ship notices. Like many real EDI feeds, every third
 * supplier sends GTIN-14 (the 12-digit UPC left-padded with "00") instead of UPC-12, every
 * seventh of the rest sends the 11-digit UPC without its check digit, as legacy systems do, and
 * a few others (number ≡ 1 mod 9) send only the 10-digit core (no number-system digit, no check digit).
 * A plain UPC = UPC join misses all three; the Cartographer has to discover them.
 * Deterministic (no PRNG draw), so every other generated value is unchanged.
 */
export function asnBarcode(supplierId: string, upc: string): string {
  const n = Number(supplierId.replace(/\D/g, ""));
  if (!upc) return upc;
  // An EAN-13 has no shorter legacy form; GTIN-14 suppliers pad it with one zero.
  if (upc.length === 13) return n % 3 === 0 ? `0${upc}` : upc;
  if (n % 3 === 0) return `00${upc}`;
  if (n % 7 === 0) return upc.slice(0, 11);
  return n % 9 === 1 ? upc.slice(1, 11) : upc;
}

const STATES = ["CA", "OR", "WA", "TX", "IL", "MN", "WI", "NY", "NJ", "PA", "FL", "GA"] as const;

const CONTACT_ROLES = [
  "Quality manager",
  "Compliance lead",
  "Logistics coordinator",
  "Recall desk",
  "Account manager",
  "Warehouse supervisor",
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

/** Food aisles hold real products (data/real/); invented lines are only for the other departments. */
const FOOD = new Set(["Grocery", "Produce"]);
const NON_FOOD = Object.keys(DEPARTMENTS).filter((d) => !FOOD.has(d));

/** Department for a real food product from its FoodData Central category (or its title). */
export function realDepartment(category: string | undefined, title: string): string {
  const t = `${category ?? ""} ${title}`;
  if (/\b(baby|infant|toddler)\b/i.test(t)) return "Baby";
  if (/\b(pre-packaged fruit|vegetables?|salads?|lettuce|sprouts?|produce|berries|fresh fruit)\b/i.test(t) && !/\b(chips?|dressing|juice|bars?|sauce|soup)\b/i.test(t)) return "Produce";
  return "Grocery";
}

const SYLLABLES_A = ["Nor", "Bel", "Cal", "Dor", "Fen", "Glen", "Har", "Jun", "Kel", "Lum", "Mer", "Oak", "Pax", "Quin", "Riv", "Sol", "Tor", "Vex", "Wil", "Zen"];
const SYLLABLES_B = ["wood", "field", "stone", "brook", "vale", "crest", "ridge", "haven", "dale", "ford"];
const BRAND_SUFFIXES = ["Co", "Farms", "Home"];

type CpscProduct = {
  Name?: string;
  Model?: string;
  Description?: string;
  Type?: string;
  CategoryID?: string;
};

type CpscRecall = {
  RecallNumber: string;
  RecallDate: string;
  Title: string;
  Description: string;
  Products?: CpscProduct[];
  ProductUPCs?: { UPC?: string }[];
  Manufacturers?: { Name?: string }[];
  Importers?: { Name?: string }[];
  Retailers?: { Name?: string }[];
  Distributors?: { Name?: string }[];
};

/** Minimal shape accepted by CPSC brand/title helpers (tests + generator). */
export type CpscNameSource = {
  Title: string;
  Products?: CpscProduct[];
  Manufacturers?: { Name?: string }[];
  Importers?: { Name?: string }[];
  Distributors?: { Name?: string }[];
};

type FdaRecall = {
  recall_number: string;
  recalling_firm: string;
  product_description: string;
  code_info: string;
  more_code_info?: string;
  distribution_pattern: string;
  recall_initiation_date: string;
  report_date: string;
};

type SkuOrigin = "from_recall" | "decoy" | "background";

type SkuRow = {
  sku: string;
  upc: string;
  title: string;
  brand: string;
  department: string;
  supplier_id: string;
  origin: SkuOrigin;
  sourceRecall: string;
  recallLots?: string[];
};

const LEGAL_SUFFIX_RE =
  /,?\s*\b(?:Incorporated|Corporation|Company|L\.L\.C\.?|LLC|Inc\.?|Corp\.?|Ltd\.?|Co\.)\.?/gi;

const PRODUCE_RE =
  /\b(sprouts?|lettuce|spinach|fruit|vegetables?|cilantro|onions?|peppers?)\b/i;

const PLASTIC_BAG_IN_RE =
  /\bin\s+(?:a\s+|an\s+|the\s+)?(?:clear\s+|yellow\s+|plastic\s+|sealed\s+|poly\s+)*(?:plastic|bag|bags|pouch|pouches|tray|trays|container|containers)\b/i;

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

/** Title-case words; keep short all-caps / digit-bearing tokens as-is. */
export function titleCaseBrand(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => {
      if (/\d/.test(w) || (w.length <= 3 && w === w.toUpperCase())) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

/** Strip Inc/LLC/Co/Corp/Company/Ltd (and L.L.C.) and tidy commas. */
export function stripLegalSuffixes(name: string): string {
  let s = name.replace(/™|®/g, "").trim();
  // Prefer the company token before ", of City" location clauses.
  const ofLoc = s.match(/^(.+?),\s*of\s+/i);
  if (ofLoc) s = ofLoc[1]!.trim();
  s = s.replace(LEGAL_SUFFIX_RE, " ");
  s = s.replace(/[,\s]+$/g, "").replace(/\s{2,}/g, " ").trim();
  // If a bare trailing comma-clause remains, keep first clause.
  if (s.includes(",")) s = s.split(",")[0]!.trim();
  return s;
}

function clipBrand(name: string, max = 40): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > 12 ? cut.slice(0, sp) : cut).trim();
}

export function brandFromFdaFirm(firm: string): string {
  const cleaned = stripLegalSuffixes(firm);
  return clipBrand(titleCaseBrand(cleaned) || "Generic Brand");
}

/** Extract first size token: 5.0 oz→5OZ, 16 oz→16OZ, 5 lb/pound→5LB, 142 g→142G, 12 ct→12CT. */
export function extractSizeToken(text: string): string | null {
  const m = text.match(
    /(\d+(?:\.\d+)?)\s*(ounces?|oz\.?|pounds?|lbs?\.?|grams?|g\.?|kg\.?|ml\.?|cts?\.?|count)\b/i,
  );
  if (!m) return null;
  const num = Number(m[1]!);
  if (!Number.isFinite(num)) return null;
  // Keep meaningful decimals (3.17→3.17); drop trailing .0 (5.0→5).
  const n = Number.isInteger(num) || /\.0+$/.test(m[1]!) ? String(Math.trunc(num)) : String(num);
  const unitRaw = m[2]!.toLowerCase().replace(/\./g, "");
  let unit: string;
  if (/^(oz|ounce|ounces)$/.test(unitRaw)) unit = "OZ";
  else if (/^(lb|lbs|pound|pounds)$/.test(unitRaw)) unit = "LB";
  else if (/^(g|gram|grams)$/.test(unitRaw)) unit = "G";
  else if (/^kg$/.test(unitRaw)) unit = "KG";
  else if (/^ml$/.test(unitRaw)) unit = "ML";
  else unit = "CT";
  return `${n}${unit}`;
}

function cutFdaDescriptionStem(desc: string): string {
  const markers: number[] = [];
  const pushIf = (idx: number) => {
    if (idx >= 0) markers.push(idx);
  };
  pushIf(desc.indexOf(","));
  pushIf(desc.search(/\.\s/));
  for (const re of [/\bUPC\b/, /\bNet\s*Wt\b/i, /\bIngredients\b/i, /\bpacked\b/i]) {
    const m = re.exec(desc);
    if (m) pushIf(m.index);
  }
  const plastic = PLASTIC_BAG_IN_RE.exec(desc);
  if (plastic) pushIf(plastic.index);
  if (markers.length === 0) return desc.trim();
  return desc.slice(0, Math.min(...markers)).trim();
}

function removeBrandWords(text: string, brand: string): string {
  const brandWords = new Set(
    brand
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9&']/gi, ""))
      .filter(Boolean),
  );
  return text
    .split(/\s+/)
    .filter((w) => {
      const clean = w.replace(/[^A-Za-z0-9&']/g, "").toLowerCase();
      return clean && !brandWords.has(clean);
    })
    .join(" ");
}

export function fdaRetailerTitle(desc: string, brand: string): string {
  // Notices often open with the firm ("Clover Hill Dairy LLP, Sharp Cheese …"): take the first
  // comma segment that still names a product once firm/brand words are removed.
  const segments = desc.replace(/™|®/g, "").replace(/\b(Inc|Co|Corp|Ltd)\.\s/g, "$1 ").split(",");
  let stem = "";
  for (let i = 0; i < segments.length && i < 4; i++) {
    const cand = removeBrandWords(stripLegalSuffixes(cutFdaDescriptionStem(segments.slice(i).join(",")))
      .replace(/\b(LLP|LLC|Inc|Co|Corp|Ltd|Specialists?)\b\.?/gi, " "), brand).trim();
    const words = (cand.match(/[A-Za-z]{3,}/g) ?? []).filter((w) => !/^(and|packaged|package|the|with|net|oz|lbs?|pounds?|ounces?)$/i.test(w));
    if (words.length >= 2) { stem = cand; break; }
  }
  if (!stem) stem = removeBrandWords(stripLegalSuffixes(cutFdaDescriptionStem(desc)), brand);
  const words = stem.split(/\s+/).filter(Boolean).slice(0, 5);
  let title = words.join(" ").toUpperCase().replace(/\s+/g, " ").trim();
  const size = extractSizeToken(desc);
  const alreadySized = /\b\d+(?:\.\d+)?(?:OZ|LB|G|KG|ML|CT)\b/i.test(title);
  if (size && !alreadySized) {
    const withSize = `${title} ${size}`.trim();
    if (withSize.length <= 48) title = withSize;
  }
  title = title.replace(/\.{3}/g, "").trim();
  if (title.length > 48) title = clipWords(title, 48);
  return title || "FOOD ITEM";
}

export function brandFromCpscName(r: CpscNameSource): string {
  const company =
    r.Manufacturers?.[0]?.Name ||
    r.Importers?.[0]?.Name ||
    r.Distributors?.[0]?.Name ||
    "";
  if (company) {
    const cleaned = stripLegalSuffixes(company);
    return clipBrand(titleCaseBrand(cleaned) || "Consumer Brand");
  }
  const first = r.Title.replace(/™|®/g, "").trim().split(/\s+/)[0] ?? "";
  const clean = first.replace(/[^A-Za-z0-9&']/g, "");
  return clipBrand(titleCaseBrand(clean) || "Consumer Brand");
}

function usableCpscModel(model: string | undefined): string | null {
  if (!model) return null;
  const m = model.replace(/™|®/g, "").trim();
  if (!m || /^n\/?a$/i.test(m) || /^none$/i.test(m)) return null;
  if (m.length > 16) return null;
  return m;
}

export function cpscRetailerTitle(
  r: CpscNameSource,
  brand: string,
  includeModel: boolean,
): string {
  const rawName = (r.Products?.[0]?.Name || r.Title.split(/Due to|Recalls/i)[0] || "Product")
    .replace(/™|®/g, "")
    .trim();
  const stem = removeBrandWords(rawName, brand);
  const words = stem.split(/\s+/).filter(Boolean).slice(0, 6);
  let title = words.join(" ").toUpperCase().replace(/\s+/g, " ").trim();
  const model = includeModel ? usableCpscModel(r.Products?.[0]?.Model) : null;
  if (model) {
    const withModel = `${title} ${model}`.trim();
    if (withModel.length <= 48) title = withModel;
  }
  title = title.replace(/\.{3}/g, "").trim();
  if (title.length > 48) title = clipWords(title, 48);
  return title || "PRODUCT";
}

export function fdaDepartment(desc: string): string {
  return PRODUCE_RE.test(desc) ? "Produce" : "Grocery";
}

export function cpscDepartment(r: CpscNameSource): string {
  const type = (r.Products?.[0]?.Type || "").toLowerCase();
  const name = (r.Products?.[0]?.Name || r.Title || "").toLowerCase();
  const blob = `${type} ${name}`;
  if (/\b(toy|toys|doll|puzzle|plush|playpen|swing)\b/.test(blob) || /\btoys?\b/.test(type)) {
    return "Toys";
  }
  if (/\b(baby|infant|diaper|teething|pacifier|crib|bassinet|stroller)\b/.test(blob)) return "Baby";
  if (/\b(helmet|bicycle|bike|sport|weight|racket|ball|air rifle|bb gun)\b/.test(blob)) {
    return "Sporting";
  }
  if (
    /\b(hammer|nail|screw|drill|lock|pressure washer|lawn mower|fuel container|hardware)\b/.test(
      blob,
    )
  ) {
    return "Hardware";
  }
  if (
    /\b(electronic|charger|battery|adapter|lamp|light|laminator|air conditioner|speaker)\b/.test(
      blob,
    ) ||
    /office machines|adapter\/power|night-lights|electric/.test(type)
  ) {
    return "Electronics";
  }
  if (/\b(home|mattress|blanket|furniture|dresser|desk|candle|towel|pillow|rug)\b/.test(blob)) {
    return "Home";
  }
  return "Home";
}

function decoyDepartmentAndKind(
  rng: () => number,
  avoidDept: string,
): { department: string; kind: string } {
  const depts = NON_FOOD.filter((d) => d !== avoidDept);
  const department = pick(rng, depts.length ? depts : NON_FOOD);
  const kind = pick(rng, DEPARTMENTS[department]!);
  return { department, kind };
}

function retailerStyleTitle(kind: string, rng: () => number): string {
  const size = pick(rng, ["", " 12OZ", " 16OZ", " 2PK", " 4CT"]);
  return `${kind.toUpperCase()}${size}`.slice(0, 48).trim();
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
  // Locations are real SNAP-authorized supermarkets (data/real/stores.json, USDA FNS, public domain).
  // The chain name stays fictional: the stock, sales and ship notices around each store are synthetic,
  // so no row attributes them to the real business at that address.
  const realStores = JSON.parse(await readFile(path.join(ROOT, "data", "real", "stores.json"), "utf8")) as {
    stores: { store_id: string; city: string; state: string }[];
  };
  const stores = realStores.stores.map((s) => ({
    store_id: s.store_id,
    name: `Northwind #${s.store_id.slice(1)} ${s.city}`,
    city: s.city,
    state: s.state,
  }));
  if (stores.length !== 24 || stores.some((s) => !(STATES as readonly string[]).includes(s.state)))
    throw new Error("data/real/stores.json must hold 24 stores in the generator's states");

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

  const cpscPicked = sampleN(rng, cpsc, 50);

  // Food aisles are real products (data/real/): every product whose barcode an FDA notice in
  // sample/ prints (USDA FoodData Central or Open Food Facts), other products of the same brand
  // owners, and a seeded FoodData Central sample for the rest of the shelf. Title, barcode and
  // vendor (brand owner) are the catalog's; only stock, sales and ship notices are synthetic.
  const catalog = JSON.parse(await readFile(path.join(ROOT, "data", "real", "catalog.json"), "utf8")) as RealCatalog;
  const shelf = JSON.parse(await readFile(path.join(ROOT, "data", "real", "shelf.json"), "utf8")) as Shelf;
  const fdaByNumber = new Map(fda.map((r) => [r.recall_number, r] as const));
  // One item-master line per barcode. An EAN-13 comes from a supplier that sends barcodes as written.
  const usedUpc = new Set<string>();
  const plainSuppliers = suppliers.filter((x) => asnBarcode(x.supplier_id, "012345678905") === "012345678905");
  const supplierFor = (upc: string) => pick(rng, upc.length === 13 ? plainSuppliers : suppliers).supplier_id;
  for (const item of catalog.items) {
    const notices = item.recall_numbers.map((n) => fdaByNumber.get(n)).filter((r): r is FdaRecall => !!r);
    // Same deterministic reader the agents use as their baseline (src/feeds.ts).
    const lots = [...new Set(notices.flatMap((r) => lotsFromCodeInfo([r.code_info, r.more_code_info].filter(Boolean).join(" "))))];
    skus.push({
      sku: nextSku(), upc: item.upc, title: item.title, brand: item.brand,
      department: realDepartment(item.category, item.title),
      supplier_id: supplierFor(item.upc),
      origin: "from_recall", sourceRecall: item.recall_numbers.join("|"), recallLots: lots,
    });
  }
  for (const item of catalog.items) usedUpc.add(item.upc);
  for (const n of catalog.negatives) {
    if (usedUpc.has(n.upc)) continue;
    usedUpc.add(n.upc);
    skus.push({ sku: nextSku(), upc: n.upc, title: n.title, brand: n.brand, department: realDepartment(n.category, n.title),
      supplier_id: supplierFor(n.upc), origin: "decoy", sourceRecall: "" });
  }
  for (const b of shelf.items) {
    if (usedUpc.has(b.upc)) continue;
    usedUpc.add(b.upc);
    skus.push({ sku: nextSku(), upc: b.upc, title: b.title, brand: b.brand, department: realDepartment(b.category, b.title),
      supplier_id: supplierFor(b.upc), origin: "background", sourceRecall: "" });
  }

  for (const r of cpscPicked) {
    const includeModel = rng() < 0.7;
    const brand = brandFromCpscName(r);
    const title = cpscRetailerTitle(r, brand, includeModel);
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
      department: cpscDepartment(r),
      supplier_id: pick(rng, suppliers).supplier_id,
      origin: "from_recall",
      sourceRecall: r.RecallNumber,
    });
  }

  // ~40 decoys: same brand as a recall SKU, kind from a different department
  const recallSkus = skus.filter((s) => s.origin === "from_recall" && !FOOD.has(s.department));
  const decoyCount = 40;
  for (let i = 0; i < decoyCount; i++) {
    const base = pick(rng, recallSkus);
    const { department, kind } = decoyDepartmentAndKind(rng, base.department);
    skus.push({
      sku: nextSku(),
      upc: randomValidUpc(rng),
      title: retailerStyleTitle(kind, rng),
      brand: base.brand,
      department,
      supplier_id: pick(rng, suppliers).supplier_id,
      origin: "decoy",
      sourceRecall: "",
    });
  }

  // Background SKUs to reach ~900 total
  const targetTotal = 900;
  while (skus.length < targetTotal) {
    const dept = pick(rng, NON_FOOD);
    const kind = pick(rng, DEPARTMENTS[dept]!);
    const brand = generatedBrand(rng);
    skus.push({
      sku: nextSku(),
      upc: randomValidUpc(rng),
      title: retailerStyleTitle(kind, rng),
      brand,
      department: dept,
      supplier_id: pick(rng, suppliers).supplier_id,
      origin: "background",
      sourceRecall: "",
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
    ["sku", "upc", "title", "brand", "department", "supplier_id"],
    skus.map((s) => [s.sku, s.upc, s.title, s.brand, s.department, s.supplier_id]),
  );
  const evalDir = path.join(OUT, "eval");
  await mkdir(evalDir, { recursive: true });
  await writeCsv(
    path.join(evalDir, "ground_truth.csv"),
    ["sku", "source_recall", "origin"],
    skus.map((s) => [s.sku, s.sourceRecall, s.origin]),
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
      asnBarcode(r.supplier_id, r.upc),
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

**Inventory, sales, ship notices and suppliers are synthetic.** Store locations are real
SNAP-authorized supermarkets (address, city, state, ZIP from the USDA FNS SNAP Retailer Locator,
public domain; see \`data/real/stores.json\`), but the chain is the fictional Northwind and no row
names the real business at that address. No person names, no emails, no loyalty identities;
\`loyalty_customers\` is a count only.

## How it was made

Generated by \`npm run gen\` (\`scripts/gen-synthetic.ts\`) with mulberry32 PRNG seed **${seed}**.

Inputs (public recall snapshots under \`sample/\`, captured per \`sample/CAPTURED_AT\`):
- \`sample/cpsc_recalls.json\` — CPSC saferproducts.gov recalls
- \`sample/fda_food_enforcement.json\` — openFDA food enforcement results

### Files

| File | Rows (approx) | Notes |
|------|---------------|-------|
| stores.csv | ${stores.length} | Northwind stores at real SNAP-authorized supermarket addresses, ${STATES.length} US states |
| suppliers.csv | ${suppliers.length} | Fictional suppliers; contact_role only |
| skus.csv | ${skus.length} | Item master only (no origin / source_recall) |
| inventory.csv | ${inventory.length} | ~35% of SKUs per store; 1–3 lots |
| sales.csv | ${sales.length} | Weekly sampled sales through 2026-10-18 |
| ship_notices.csv | ${ship_notices.length} | One ASN per (sku, lot) to a DC state |
| eval/ground_truth.csv | ${skus.length} | Evaluation labels only — agents must never read this |

### SKU origins (in eval/ground_truth.csv only)

Ground-truth columns \`origin\` and \`source_recall\` are **not** loaded into the ERP the agents query.
They exist solely for offline evaluation of match quality.

**Food lines are real products** (titles, barcodes and brand owners from \`data/real/\`; licences in
\`data/real/README.md\`). Stock, sales, lots and ship notices for them are synthetic.

- **from_recall** — food: every real product (USDA FoodData Central or Open Food Facts) whose
  barcode an FDA notice in the snapshot prints, \`source_recall\` = those recall numbers
  (\`|\`-separated). Non-food: built from ~50 CPSC notices (no public product catalog with
  barcodes exists for consumer products), titles from the notice, Products[0].Model ~70%.
- **decoy** — food: other real FoodData Central products of the same brand owners. Non-food:
  same brand string as a CPSC SKU, an invented product kind from a *different* department.
- **background** — food: a seeded FoodData Central sample (\`data/real/shelf.json\`) that no notice
  prints and no recalling firm makes. Non-food: invented brand × kind with random valid UPCs.

Lot codes on recalled food inventory rows use a parsed \`code_info\` lot with probability 0.5;
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

const isDirectRun =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

/** Cut a title at a word boundary so no word is left half-written. */
export function clipWords(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n + 1);
  const at = cut.lastIndexOf(" ");
  return (at > n * 0.5 ? cut.slice(0, at) : s.slice(0, n)).replace(/[\s,(/-]+$/, "").trim();
}
