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

## Result (`eval/results/real-items-nvidia_nemotron-3-ultra-550b-a55b.json`, 2026-10-25, third run)

249 pairs (97 positive, 92 other-notice, 60 same-brand), 294 model calls, 0 failed after retries, 79 min.

**Barcode path** (how the product actually finds these items): **97 of 97** positives are settled by
the UPC rule without a model, and the Auditor's re-check finds the barcode in the notice for all 97.
No negative is matched by barcode (**0 of 152**).

**Text path, barcode hidden** (the fallback when a feed or item master has no usable barcode):

| | caught | wrongly dismissed | false alarms | sent to human |
|---|---|---|---|---|
| judge, first answer | 69 / 97 | 28 | 2 / 152 | 1 |
| after the Auditor (final) | 55 / 97 | **23** | 2 / 152 | 31 (19 positives) |

Final, counting only pairs the agents decided: recall 71% (55/78), precision 96% (55/57). By source:
FDC titles 14/31 caught (12 dismissed), OFF titles 41/66 (11 dismissed). The Auditor revised 37 pairs;
its checks fired as `item-word-missing` 40, `dismissal-names-our-item` 21, `dismissal-same-line` 11,
`size-not-in-notice` 3. The Auditor never turns a dismissal into a match: it moves doubtful pairs to a
person, so 14 of the judge's 69 first-answer catches and 5 of its 28 misses end with a reviewer.

**How the dismissal check got here, and why this is not an independent test.** Three runs on the
same pairs and model:

| run | barcode path settled / re-checked | text: caught | missed | to a person |
|---|---|---|---|---|
| first | 93 / 88 | 53 | 29 | 20 |
| second (broad `dismissal-same-line`) | 97 / 97 | 55 | 11 | 64 |
| third (narrowed, this result) | 97 / 97 | 55 | 23 | 31 |

- Barcodes (after the first run): `feeds.findUpcs` now reads EAN-13 (Lidl, imports), GTIN-14 with
  two leading zeros, and an 11-digit print that is a UPC missing its leading zero (it keeps both
  readings); the Auditor's live-notice re-check accepts a UPC printed without its check digit or its
  leading zero (`printedForms` in `scripts/upc.ts`).
- Dismissals: most first-run misses were the same brand's line in another size, count or variety
  (18 eggs vs a notice for 12, a pounded-yam flour vs the recalled instant mix). The second run sent
  a dismissal to a person when the quoted recalled product named at least half of our item's
  product words; on the synthetic evaluation that also caught other flavours of a recalled line and
  sent 112 pairs to a person. The rule now fires only when the quote names *every* product word of
  our item (sizes, counts, units and the vendor aside): fewer reviews (64 → 31), more misses (11 → 23).
  We kept the narrow rule because the same code runs on the synthetic set, where the broad one
  buried the reviewer; the numbers above were measured on the pairs that motivated both changes.

**The 23 positives the text path still dismisses** (barcodes hidden; with the barcode visible, all 23 are found by the UPC rule). Most are the recalled product line under a title that names it generically or in another form: eggs listed as "Large Egg" or "Eggs Jumbo", a lettuce kit described by its ingredients, a flour or pack size the notice words differently, a title in Chinese.

| Recall | Our item's catalog title | Title source |
|---|---|---|
| H-1244-2026 | GRAND CENTRAL BAKING COMPANY, RUSTIC BREADS 20 oz | FDC |
| H-1332-2026 | VANILLA BLENDED GREEK NONFAT YOGURT, VANILLA 32 oz | FDC |
| H-1280-2026 | CLASSIC ICEBERG LETTUCE, CARROTS, RED CABBAGE SALAD, CLASSIC ICEBERG 12 oz | FDC |
| H-1280-2026 | CLASSIC ICEBERG LETTUCE, CARROTS, RED CABBAGE SALAD, CLASSIC ICEBERG 24 oz | FDC |
| H-1280-2026 | ICEBERG SHREDDED LETTUCE, ICEBERG 16 oz | FDC |
| H-1280-2026 | ICEBERG SHREDDED LETTUCE, ICEBERG 8 oz | FDC |
| H-1129-2026 | MORNINGSTAR FARMS VEGGITIZERS VEGGIE BUFFALO WINGS, 10.5 OZ | FDC |
| H-1119-2026 | FRESH ROASTED SUNFLOWER SEEDS 11 oz | FDC |
| H-1333-2026 | CHOCOLATE ORGANIC LOWFAT MILK, CHOCOLATE 144 fl oz | FDC |
| H-1193-2026 | BANANA & STRAWBERRY ORGANIC FRUIT PUREE, BANANA & STRAWBERRY 4 oz | FDC |
| H-1130-2026 | Morningstar Farms Breakfast Hot & Spicy Sausage Patties 8oz | FDC |
| H-1230-2026 | FARM FRESH LARGE EGGS | FDC |
| H-1230-2026 | Eggs Jumbo | OFF |
| H-1230-2026 | Large Egg | OFF |
| H-1355-2026 | Pico de gallo salsa 7 oz | OFF |
| H-1329-2026 | Authentic Pounded Yam 32 oz | OFF |
| H-1329-2026 | Ola Ola Authentic Pounded Yam (iyan) Pack of 3 (12 LBS) 64 oz | OFF |
| H-1329-2026 | Pounded yam flour 80 oz | OFF |
| H-1104-2026 | Cacao Beans Dates Cacao Butter Sea Salt | OFF |
| H-1149-2026 | Chicken Filet | OFF |
| H-1260-2026 | 宁波汤圆 | OFF |
| H-1340-2026 | River Valley Sprouts 5 oz | OFF |
| H-1229-2026 | Eggs - Organic, Cage Free, Brown 0 oz | OFF |

What the text path still misses: FDC descriptions that are long ingredient-style labels, FDC records
whose description is an older name for the barcode, and OFF names that are empty or wrong. On real
titles, a barcode is what makes the match; the text judge is a safety net.
