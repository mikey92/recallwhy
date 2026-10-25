// Normalises rows from the two recall feed views into one Recall shape.
// Parsing here is deterministic; the Investigator may ask the model to read
// messy code_info text, and the Auditor checks every model-read lot against
// the raw text again.
import { isValidUpc, isValidEan13, gtin12CheckDigit } from "../scripts/upc.ts";

export type Feed = "cpsc" | "fda_food";

export interface Recall {
  id: string;            // "cpsc:27024" | "fda:H-1339-2026"
  feed: Feed;
  number: string;
  date: string;          // ISO yyyy-mm-dd (CPSC recall date, FDA recall initiation date)
  reported: string;      // ISO yyyy-mm-dd (FDA report date / CPSC last publish)
  firm: string;
  title: string;
  text: string;          // everything the notice says about the product, verbatim
  reason: string;
  codeInfo: string;      // FDA code_info + more_code_info, CPSC model list
  upcs: string[];        // barcodes found in the notice: 12-digit UPCs, and 13-digit EANs that are not UPCs
  models: string[];      // model numbers (CPSC)
  states: string[] | "nationwide" | "unknown";
  url?: string;
  classification?: string;
}

export const US: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA",
  hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA",
  michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
  oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
  virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "puerto rico": "PR",
};
const ABBR = new Set(Object.values(US));

/** Parse an FDA distribution_pattern into state codes. */
export function parseStates(pattern: string): Recall["states"] {
  const p = (pattern ?? "").trim();
  if (!p) return "unknown";
  if (/nation ?wide|all (50 )?states|throughout the (u\.?s|united states)/i.test(p)) return "nationwide";
  const found = new Set<string>();
  // Full names first (longest first so "west virginia" wins over "virginia").
  let rest = " " + p.toLowerCase() + " ";
  for (const name of Object.keys(US).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`[^a-z]${name}[^a-z]`, "g");
    if (re.test(rest)) { found.add(US[name]); rest = rest.replace(re, " "); }
  }
  for (const m of p.matchAll(/\b([A-Z]{2})\b/g)) if (ABBR.has(m[1])) found.add(m[1]);
  return found.size ? [...found].sort() : "unknown";
}

/** Find UPCs in free text. Accepts "UPC 0 87906-01018 7", "850073852125", 11-digit forms. */
export function findUpcs(text: string): string[] {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(/\d[\d \-]{9,17}\d/g)) {
    const digits = m[0].replace(/[ \-]/g, "");
    if (digits.length === 12 && isValidUpc(digits)) out.add(digits);
    else if (digits.length === 13 && digits.startsWith("0") && isValidUpc(digits.slice(1))) out.add(digits.slice(1));
    else if (digits.length === 13 && isValidEan13(digits)) out.add(digits); // EAN-13 from outside the US/Canada (Lidl, imports)
    else if (digits.length === 14 && digits.startsWith("00") && isValidUpc(digits.slice(2))) out.add(digits.slice(2)); // GTIN-14 of a unit UPC
    else if (digits.length === 11) {
      // Either the UPC without its check digit, or the full UPC without its leading zero; try both.
      out.add(digits + gtin12CheckDigit(digits));
      if (isValidUpc("0" + digits)) out.add("0" + digits);
    }
  }
  return [...out];
}

const iso = (s: string) => {
  if (!s) return "";
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s.slice(0, 10);
};

export interface FdaRow {
  recall_number: string; recalling_firm: string; product_description: string;
  reason_for_recall: string; code_info: string; more_code_info?: string;
  distribution_pattern: string; classification?: string; report_date: string;
  recall_initiation_date?: string; status?: string;
}

export function fromFda(r: FdaRow): Recall {
  const codeInfo = [r.code_info, r.more_code_info].filter(Boolean).join(" ");
  return {
    id: `fda:${r.recall_number}`, feed: "fda_food", number: r.recall_number,
    date: iso(r.recall_initiation_date || r.report_date), reported: iso(r.report_date),
    firm: r.recalling_firm, title: clip(r.product_description, 120),
    text: r.product_description, reason: r.reason_for_recall, codeInfo,
    upcs: findUpcs(`${r.product_description} ${codeInfo}`), models: [],
    states: parseStates(r.distribution_pattern), classification: r.classification,
  };
}

export interface CpscRow {
  recall_number: string; recall_date: string; last_publish: string; title: string;
  description: string; product_names: string; models: string; upcs: string;
  firms: string; hazard: string; url: string;
}

export function fromCpsc(r: CpscRow): Recall {
  const models = (r.models ?? "").split("|").map((m) => m.trim()).filter((m) => m && !/^(n\/?a|none|various)$/i.test(m));
  return {
    id: `cpsc:${r.recall_number}`, feed: "cpsc", number: r.recall_number,
    date: iso(r.recall_date), reported: iso(r.last_publish || r.recall_date),
    firm: (r.firms ?? "").split("|")[0] ?? "", title: r.title,
    text: [r.title, r.product_names, r.description].filter(Boolean).join(" — "),
    reason: r.hazard, codeInfo: models.join(", "),
    upcs: findUpcs(r.upcs ?? ""), models, states: "nationwide", url: r.url,
  };
}

/** Deterministic lot-code reader used as the baseline and as the Auditor's check. */
export function lotsFromCodeInfo(codeInfo: string): string[] {
  const t = codeInfo ?? "";
  if (/no lot codes?|all lots|all codes|all (best|use)[- ]by/i.test(t)) return [];
  const out = new Set<string>();
  const cleaned = t
    .replace(/(best|use|sell)[ -]?(if used )?by[:\s]*[a-z]{3,9}\.? \d{1,2},? \d{4}/gi, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ")
    .replace(/\b(upc|gtin)[:#\s]*[\d \-]{11,16}/gi, " ");
  for (const m of cleaned.matchAll(/\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{3,19}\b/g)) out.add(m[0]);
  for (const m of cleaned.matchAll(/\blot(?: code| number| no\.?| #|#|s)?[:\s]*([0-9]{3,12})\b/gi)) out.add(m[1]);
  for (const m of cleaned.matchAll(/(?:^|[,;]\s*)(\d{3,12})(?=\s*(?:[,;]|$))/g)) out.add(m[1]);
  return [...out];
}

/** A lot is "in" the recall only if it appears verbatim (case-insensitive, token-bounded). */
export function lotAppears(lot: string, codeInfo: string): boolean {
  const esc = lot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${esc}($|[^A-Za-z0-9])`, "i").test(codeInfo ?? "");
}

/** Cut at a word boundary so titles never end mid-word. */
export function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), n * 0.6)).replace(/[\s,;:.-]+$/, "") + "…";
}
