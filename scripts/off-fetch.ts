// Real product titles for the text-match evaluation (eval/real-items.ts).
// Reads the FDA food-enforcement snapshot in sample/, takes every barcode a notice
// prints, and looks it up in Open Food Facts. The titles that come back were written
// by OFF contributors from the package, not derived from the notice text.
//   npx tsx scripts/off-fetch.ts [--limit N] [--out data/real/off_items.json]
// Open Food Facts data: Open Database License (ODbL), see data/real/README.md.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gtin12CheckDigit } from "./upc.ts";

const OFF = "https://world.openfoodfacts.org/api/v2/product";
const FIELDS = "code,product_name,brands,quantity,categories_tags";
const UA = "RecallWhy-hackathon-eval/1.0 (github.com/mikey92/recallwhy)";
const MIN_GAP_MS = 1500; // well under 1 request per second (OFF answers 429 when its per-minute bucket fills)

export interface PrintedUpc { recall_number: string; printed: string; digits: string; field: "product_description" | "code_info" }
export interface OffItem {
  code: string; printedUpc: string; recall_number: string; product_name: string; brands: string; quantity: string;
  categories: string[]; source: string; fetched_at: string;
}

/** Barcodes printed in a notice: 11–14 digits, possibly with spaces or dashes ("0 87906-01018 7"). */
export function printedUpcs(row: { recall_number: string; product_description: string; code_info?: string; more_code_info?: string }): PrintedUpc[] {
  const out: PrintedUpc[] = [];
  const seen = new Set<string>();
  const scan = (text: string, field: PrintedUpc["field"]) => {
    for (const m of (text ?? "").matchAll(/\d[\d \-]{9,17}\d/g)) {
      const digits = m[0].replace(/[ \-]/g, "");
      if (digits.length < 11 || digits.length > 14 || seen.has(digits)) continue;
      // Dates and phone numbers also reach 11+ digits; a barcode printed with spaces or dashes always keeps GS1 groupings.
      if (/^(19|20)\d{6}/.test(digits) && digits.length === 11) continue;
      seen.add(digits);
      out.push({ recall_number: row.recall_number, printed: m[0], digits, field });
    }
  };
  scan(row.product_description, "product_description");
  scan(`${row.code_info ?? ""} ${row.more_code_info ?? ""}`, "code_info");
  return out;
}

/**
 * Codes to try for one printed number. OFF stores a UPC-A as the 13-digit EAN with a leading
 * zero and normalises a 12-digit request to it, so one 13-digit request covers 12/13; a
 * 14-digit print (GTIN-14 case code) is tried as printed, then without the packaging digit.
 */
export function codeVariants(digits: string): string[] {
  const v = new Set<string>();
  if (digits.length === 11) digits = digits + gtin12CheckDigit(digits);
  if (digits.length === 14) { v.add(digits); digits = ean13(digits.slice(1, 13)); } // drop the indicator digit, recompute the check digit
  const bare = digits.replace(/^0+/, "");
  if (bare.length <= 13) v.add(bare.padStart(13, "0"));
  return [...v];
}

/** EAN-13 from its first 12 digits (weights 1,3 from the left). */
function ean13(first12: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += (first12.charCodeAt(i) - 48) * (i % 2 ? 3 : 1);
  return first12 + String((10 - (sum % 10)) % 10);
}

interface OffResponse { status?: number; product?: { code?: string; product_name?: string; brands?: string; quantity?: string; categories_tags?: string[] } }

async function lookup(code: string): Promise<OffResponse | undefined> {
  const url = `${OFF}/${code}.json?fields=${FIELDS}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
    if (res?.status === 404) return { status: 0 };
    if (res?.ok) return (await res.json()) as OffResponse;
    // 429: the per-minute bucket is full; wait it out rather than hammer.
    const wait = res?.status === 429 ? 65_000 : 5_000 * (attempt + 1);
    console.error(`  ${code}: HTTP ${res?.status ?? "no response"}, waiting ${wait / 1000}s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  return undefined;
}

async function main() {
  const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const limit = Number(arg("limit", "0"));
  const outFile = arg("out", "data/real/off_items.json")!;
  const feed = JSON.parse(readFileSync("sample/fda_food_enforcement.json", "utf8")) as { results: Parameters<typeof printedUpcs>[0][] };
  const printed = feed.results.flatMap(printedUpcs);
  const todo = limit ? printed.slice(0, limit) : printed;
  const items: OffItem[] = [];
  const byCode = new Map<string, OffItem | null>(); // null: asked, not in OFF
  let requests = 0, failed = 0, last = 0;
  const started = Date.now();
  for (const [i, p] of todo.entries()) {
    let hit: OffItem | undefined;
    for (const code of codeVariants(p.digits)) {
      const known = byCode.get(code);
      if (known) { hit = { ...known, printedUpc: p.printed, recall_number: p.recall_number }; break; }
      if (known === null) continue;
      const wait = MIN_GAP_MS - (Date.now() - last);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now(); requests++;
      const j = await lookup(code);
      if (!j) { failed++; continue; }
      const prod = j.product;
      if (j.status !== 1 || !prod?.product_name?.trim()) { byCode.set(code, null); continue; }
      hit = { code: prod.code ?? code, printedUpc: p.printed, recall_number: p.recall_number, product_name: prod.product_name.trim(), brands: (prod.brands ?? "").trim(),
        quantity: (prod.quantity ?? "").trim(), categories: prod.categories_tags ?? [], source: `https://world.openfoodfacts.org/product/${prod.code ?? code}`, fetched_at: new Date().toISOString() };
      byCode.set(code, hit);
      break;
    }
    if (hit) items.push(hit);
    if ((i + 1) % 20 === 0) console.error(`${i + 1}/${todo.length} printed UPCs, ${items.length} found, ${requests} requests, ${Math.round((Date.now() - started) / 1000)}s`);
  }
  const uniqueTried = new Set(todo.map((p) => p.digits)).size;
  const summary = { source: "Open Food Facts (ODbL), https://world.openfoodfacts.org", fetched_at: new Date().toISOString(), notices: feed.results.length,
    noticesWithPrintedUpc: new Set(printed.map((p) => p.recall_number)).size, printedUpcsTried: todo.length, uniqueUpcsTried: uniqueTried,
    found: items.length, uniqueProductsFound: new Set(items.map((x) => x.code)).size, requests, requestsFailed: failed, seconds: Math.round((Date.now() - started) / 1000) };
  mkdirSync("data/real", { recursive: true });
  writeFileSync(outFile, JSON.stringify({ ...summary, items }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
