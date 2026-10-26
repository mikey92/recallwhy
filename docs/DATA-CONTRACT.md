# Data contract: running RecallWhy on your own exports

RecallWhy reads six tables. The demo ships synthetic ones in `data/synthetic/`; a retailer swaps in its own
exports as CSV files with the same names and columns. The contract is code (`src/data-contract.ts`) and is
checked before anything loads:

```bash
npm run check:data -- --dir ~/exports        # lists every broken rule, exit 1 if any
npm run load -- --dir ~/exports              # loads into Postgres only if the folder passes
```

The same keys and rules are declared in the Zetaris USL `recall_exposure` (`sql/04_usl.sql`), where Zetaris's
data-quality engine checks them again on the live tables (`RUN DQ`, `docs/ZETARIS.md`).

| File | Loaded as | Key | Columns (required in **bold**) | Rules |
|---|---|---|---|---|
| suppliers.csv | supplier_portal.suppliers | supplier_id | **supplier_id**, name, contact_role | |
| skus.csv | erp.skus | sku | **sku**, upc, **title**, brand, department, **supplier_id** | upc empty or 8–14 digits; supplier_id in suppliers |
| stores.csv | erp.stores | store_id | **store_id**, name, city, **state** | state is a two-letter code |
| inventory.csv | erp.inventory | store_id, sku, lot_code | **store_id**, **sku**, **lot_code**, **on_hand** (int), received_on (date) | `on_hand_not_negative`; store and sku exist |
| sales.csv | erp.sales | store_id, sku, lot_code, sold_on | **store_id**, **sku**, **lot_code**, **sold_on** (date), **units** (int), loyalty_customers (int) | loyalty customers ≤ units; store and sku exist |
| ship_notices.csv | supplier_portal.ship_notices | asn_id | **asn_id**, **supplier_id**, **sku**, upc, **lot_code**, **shipped_on** (date), **units** (int), dc_state | `ships_units` (units > 0); barcode empty or digits, spaces, dashes; supplier and sku exist |

Dates are `yyyy-mm-dd`. Names in `code` are the Zetaris DQ rules of the same name.

## What is deliberately not in the contract

- **The barcode format on ship notices.** Suppliers write barcodes their own way (spaces, dashes, dropped
  check digits, leading zeros, a different column name or no barcode name at all). That mismatch is the
  problem RecallWhy solves, so the contract accepts it; the Cartographer finds the rule per supplier and proves
  it on every ship notice before anything uses it.
- **Lot code formats.** Lots are compared as the notice and the ERP write them; the Investigator reads them
  from the notice and keeps only codes that appear word for word.
- **Recall notices.** These come from the public CPSC and openFDA feeds, not from the retailer.

## What changes for a real deployment

Only the source. In live mode Zetaris federates the retailer's own Postgres (or any JDBC source it reaches) and
the agents query it through Zetaris; the loader here exists so the demo and a first trial can start from CSV
exports. Barcode rules, lot reads and matches are found at run time, not configured per supplier.
