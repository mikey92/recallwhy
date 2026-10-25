# Text matching on real product titles

The main evaluation (`eval/EVAL.md`) runs on a synthetic item master whose covered titles were
generated from the notice text, so a judge could match them partly by construction. This check
asks the same question with titles nobody derived from a notice, and reports separately how far
the product's barcode path gets on the same items.

## Method

1. **Catalog** (`scripts/build-real-catalog.ts` → `data/real/catalog.json`, licences in `data/real/README.md`).
   Every barcode printed in the FDA food-enforcement snapshot (`sample/fda_food_enforcement.json`;
   365 distinct barcode keys, digits only, leading zeros dropped, padded to GTIN-12) is looked up in
   two public catalogs:
   - **USDA FoodData Central Branded Foods** (April 2026 release, CC0): 30 barcodes found; the item
     is the label description from `food.csv` (plus the package weight when the description has no
     size), the vendor is `brand_owner`.
   - **Open Food Facts** (ODbL, `data/real/off_items.json` from `scripts/off-fetch.ts`): 65 more
     barcodes that FDC does not have; the item is the OFF product name plus quantity, the vendor the
     OFF brand.
   That gives **95 real products, 97 positive pairs** (two barcodes are printed by two notices).
2. **Hard negatives**, two kinds, both real:
   - *other-notice* (92): the same product against the most similar other notice (best word overlap
     of title+brand with firm+product text, ties to the same firm; notices from the same FDA event
     or printing the same barcode are excluded);
   - *same-brand* (60): for each FDC positive, up to two other FoodData Central products of the same
     `brand_owner` (or brand name), a different description, never printed in any notice, a
     different food category first, against the notice that recalls their sibling. These are the
     "same vendor, different product" lines a real item master is full of.
3. **Barcode hidden.** Every 11–14-digit number is removed from the notice text and code_info, the
   notice's UPC list is emptied, and our item carries no UPC (its SKU id is a catalog id).
4. Each pair goes through the production code path, unchanged: `decide` (Investigator's judge
   prompt, `src/agents/investigator.ts`), `audit` (Auditor's text checks, `src/agents/auditor.ts`),
   `revise` up to two rounds, then a reviewer. SQL is a stub that returns no rows (no inventory
   here). Model: `nvidia/nemotron-3-ultra-550b-a55b` through Meterless Nightshift, same generator
   and pacing as `eval/run.ts` (about 4 calls a minute, so a run takes about 75 min).
5. **Barcode path, reported separately** (`barcodePath` in the result): the same pairs with the
   barcode visible. A SKU whose UPC the Scout finds in the notice is a `upc` candidate, which the
   Investigator settles by rule (no model call); the Auditor then re-checks the digits against the
   notice. No model is called on this path.

Run: `npx tsx scripts/build-real-catalog.ts --fdc <FDC csv folder>`, then `npx tsx eval/real-items.ts`.

## Result (`eval/results/real-items-nvidia_nemotron-3-ultra-550b-a55b.json`, 2026-10-25)

249 pairs (97 positive, 92 other-notice, 60 same-brand), 298 model calls, 0 failed after retries, 77 min.
Prompts and checks are the ones in `src` at this commit; nothing was tuned on these pairs.

**Barcode path** (how the product actually finds these items): 93 of 97 positives are settled by the
UPC rule without a model; the Auditor's digit re-check agrees on 88 (the other 5 are 11-digit prints
whose check digit the Scout adds, so the 12-digit UPC is not literally in the notice and the pair
goes to a reviewer). 4 positives are not barcode candidates at all and fall to text: one GTIN-14
with two leading zeros (`feeds.findUpcs` accepts 11–13 digits), two EAN-13 (Lidl), one GTIN-8. No
negative is matched by barcode (0 of 152).

**Text path, barcode hidden** (the fallback when a feed or item master has no usable barcode):

| | caught | wrongly dismissed | false alarms | sent to human |
|---|---|---|---|---|
| judge, first answer | 61 / 97 | 36 | 1 / 152 | 0 |
| after the Auditor (final) | 53 / 97 | 29 | 2 / 152 | 20 (15 positives) |

Final, counting only pairs the agents decided: recall 65% (53/82), precision 96% (53/55). By source:
FDC titles 14/31 caught, OFF titles 39/66. The Auditor revised 29 pairs; its checks fired as
`item-word-missing` 35, `dismissal-names-our-item` 31, `size-not-in-notice` 3.

What the text path misses: FDC descriptions that are long ingredient-style labels ("CLASSIC ICEBERG
LETTUCE, CARROTS, RED CABBAGE SALAD" vs "MARKETSIDE ICEBERG SALAD"), FDC records whose description is
an older name for the barcode, OFF names that are empty or wrong ("Chocolate", "Pico"), other pack
sizes of the same line (the judge prompt treats a different package size as a different product),
and per-egg quantities ("Large Eggs 50 g"). On real titles, a barcode is what makes the match; the
text judge is a safety net that errs toward dismissing and hands doubtful pairs to a person.

## Limits (read before quoting any number above)

- **Small n.** 97 positives from 95 products, many from a few recalls (13 egg items from two
  recalls, 8 Spring & Mulberry chocolates, 7 Outshine bars, 6 Marketside salads). One recall's
  wording moves the rate by several points. One run each, temperature 0; not repeated.
- **Catalog coverage is a filter.** 95 of 365 printed barcodes are in either catalog, skewed to
  supermarket brands and away from foodservice and import products.
- **Titles are noisy labels in both directions.** FDC descriptions are GDSN/label strings (long,
  comma-joined, sometimes an older product name for the barcode); OFF names are contributor-typed.
  We did not clean them, because picking which titles count is the hand-tuning this check exists to
  avoid. Likewise some same-brand negatives are close to the recalled product (an older FDC record
  of the same sausage patty under the maker's name), so a few "false alarms" are defensible.
- **A printed barcode is not always the unit product.** Case codes and multi-size families mean the
  catalog product with that code can be an 18-pack where the notice lists a 12-pack.
- **FDA food only, text only.** No CPSC, no lots, no stores, no exposure numbers, no supplier ship
  notices, no memory of earlier decisions. The hard negatives are chosen by word overlap and brand
  owner, which is one definition of "hard"; another would give different counts.
