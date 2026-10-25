# data/real — real products

These are the food lines of the retailer's item master (`scripts/gen-synthetic.ts` reads them; the
retailer's stores, stock, sales and ship notices stay synthetic in `data/synthetic/`), and the pairs
of the real-product check (`eval/real-items.ts`, see `eval/REAL.md`).

- `catalog.json` (`scripts/build-real-catalog.ts`): recalled products and their same-brand siblings, below.
- `shelf.json` (`scripts/build-real-shelf.ts`): the rest of the food aisles, a seeded sample of 260
  FoodData Central Branded Foods products (April 2026 release) that no FDA notice in `sample/` prints
  and whose brand owner is not a recalling firm in the snapshot, at most three per brand owner.

- **items** (positives): products whose barcode an FDA food-enforcement notice in
  `sample/fda_food_enforcement.json` prints. Each comes from one of two public catalogs, matched
  on the barcode only (digits, leading zeros dropped, padded to GTIN-12):
  - `source: "fdc"` — USDA **FoodData Central, Branded Foods** (April 2026 CSV release:
    `branded_food.csv` for brand owner, brand name, GTIN, category and package weight;
    `food.csv` for the label description). Preferred when the barcode is there. Public domain (CC0).
  - `source: "off"` — **Open Food Facts** (`off_items.json`, fetched by `scripts/off-fetch.ts`),
    used only for barcodes FoodData Central does not have.
- **negatives**: for each FDC positive, up to two other FoodData Central products of the same brand
  owner (or brand name) with a different description, never printed in any notice, a different food
  category first. These are the "same vendor, different product" lines a real item master is full of.

Only the rows the evaluation uses are kept. To rebuild from the full release:

```
npx tsx scripts/build-real-catalog.ts --fdc <folder with branded_food.csv and food.csv> [--off data/real/off_items.json]
```

## Attribution and licences

- USDA FoodData Central: U.S. Department of Agriculture, Agricultural Research Service. FoodData
  Central, 2026. fdc.nal.usda.gov. Public domain (CC0 1.0).
- Open Food Facts (`off_items.json` and the `source: "off"` items): product data © Open Food Facts
  contributors, made available under the [Open Database License (ODbL) v1.0](https://opendatacommons.org/licenses/odbl/1.0/);
  individual contents under the [Database Contents License](https://opendatacommons.org/licenses/dbcl/1.0/).
  These files are an extract of that database; any reuse of them must keep this attribution and the same licence.
- The recall notices come from openFDA (https://open.fda.gov/terms/), captured on the date in `sample/CAPTURED_AT`.
