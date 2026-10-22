// Candidate SKUs for one recall, and the evidence each one rests on.
// Ideas adapted from the author's earlier Recall Sloth project (declared as
// pre-existing work in the README): a brand gate, a product-kind overlap, and
// "designator" (model-number) conflicts that rule a candidate out without a model.
import type { Recall } from "./feeds.ts";

export interface Sku { sku: string; upc: string; title: string; brand: string; department: string; supplier_id: string }

export type MatchBasis = "upc" | "model" | "text";
export interface Candidate {
  sku: Sku;
  basis: MatchBasis;
  evidence: string;      // the literal string that ties the SKU to the notice
  brandWords: string[];
  kindWords: string[];
}

const STOP = new Set(("a an and the of for with in on to by from or at as is are be this that these those its it " +
  "inc llc co corp company ltd brand brands foods food products product recall recalls recalled due risk hazard " +
  "serious injury death oz lb lbs g kg ct pk pack net wt each new sold").split(" "));

export const tokens = (s: string) =>
  (s ?? "").toLowerCase().replace(/[™®©]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

/** Model-ish words: anything with a digit and a letter, or 4+ digits; sizes excluded. */
export function designators(text: string): Set<string> {
  return new Set(tokens(text).filter((t) =>
    /\d/.test(t) && !/^\d{1,3}$/.test(t) &&
    !/^\d+(in|ft|oz|lb|lbs|qt|pc|pk|ct|mm|cm|ml|l|g|kg|v|w|mah|gal|pound|count)$/.test(t) &&
    !/^(19|20)\d\d$/.test(t)));
}

export function modelsInText(r: Recall): string[] {
  const out = new Set(r.models.map((m) => m.toUpperCase()));
  for (const m of r.text.matchAll(/model (?:numbers?|no\.?|#)?\s*:?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/gi)) out.add(m[1].toUpperCase().replace(/[.,;]$/, ""));
  return [...out].filter((m) => /\d/.test(m));
}

const WEAK = new Set("fresh spicy medium mild hot sweet organic original classic natural large small mini whole frozen premium style homestyle gourmet assorted mixed plain light dark red green white black blue yellow".split(" "));

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

export interface CatalogIndex { skus: Sku[]; df: Map<string, number> }

export function indexCatalog(skus: Sku[]): CatalogIndex {
  const df = new Map<string, number>();
  for (const s of skus) for (const w of new Set(tokens(`${s.brand} ${s.title}`))) df.set(w, (df.get(w) ?? 0) + 1);
  return { skus, df };
}

/**
 * Candidates for one recall:
 *  - upc:   a SKU UPC appears in the notice (strongest),
 *  - model: a model number from the notice appears in the SKU title,
 *  - text:  the SKU brand words appear in the notice's firm/brand text AND they share a
 *           rare product word. Text candidates always go to the judge model.
 */
export function candidates(r: Recall, ix: CatalogIndex, max = 6): Candidate[] {
  const out: Candidate[] = [];
  const upcs = new Set(r.upcs);
  const models = modelsInText(r).map(norm);
  const noticeWords = new Set(tokens(`${r.firm} ${r.title} ${r.text}`));
  const head = new Set(tokens(`${r.firm} ${r.title} ${r.text.slice(0, 160)}`));
  for (const s of ix.skus) {
    if (s.upc && upcs.has(s.upc)) { out.push({ sku: s, basis: "upc", evidence: s.upc, brandWords: [], kindWords: [] }); continue; }
    const t = norm(s.title);
    const mh = models.find((m) => m.length >= 4 && t.includes(m));
    if (mh) { out.push({ sku: s, basis: "model", evidence: mh, brandWords: [], kindWords: [] }); continue; }
    const brandWords = tokens(s.brand).filter((w) => (ix.df.get(w) ?? 0) <= 12);
    if (!brandWords.length || !brandWords.every((w) => head.has(w))) continue;
    const kindWords = tokens(s.title).filter((w) => !brandWords.includes(w) && noticeWords.has(w) && (ix.df.get(w) ?? 0) <= 25 && !/\d/.test(w) && !WEAK.has(w));
    if (!kindWords.length) continue;
    out.push({ sku: s, basis: "text", evidence: [...brandWords, ...kindWords].join(" "), brandWords, kindWords });
  }
  const rank = { upc: 0, model: 1, text: 2 } as const;
  return out.sort((a, b) => rank[a.basis] - rank[b.basis] || b.kindWords.length - a.kindWords.length).slice(0, max);
}

/** Both sides name a model and they don't meet: the notice is about something else. */
export function designatorConflict(c: Candidate, r: Recall): string | undefined {
  const mine = designators(c.sku.title);
  const theirs = designators([r.text, r.codeInfo, ...r.models].join(" "));
  if (!mine.size || !theirs.size) return undefined;
  if ([...mine].some((d) => theirs.has(d))) return undefined;
  return `SKU names ${[...mine].join(", ")}; the notice names ${[...theirs].slice(0, 5).join(", ")}`;
}

/** Every content word of a quote must occur in the notice: a reason the model made up doesn't count. */
export function grounded(quote: string, r: Recall): boolean {
  const src = new Set(tokens(`${r.firm} ${r.title} ${r.text} ${r.codeInfo}`));
  // Sizes and bare numbers ("12OZ", "4") are formatting, not claims about the product.
  const words = tokens(quote).filter((w) => !/^\d+[a-z]{0,5}$/.test(w));
  return words.length > 0 && words.every((w) => src.has(w));
}
