# Zetaris in RecallWhy: every object, how it is checked, what it costs

Zetaris Lightning 2.4.3.1 (local Docker). Every agent reads data only through it; the agents also write
back to it. Each row below names the object, the statement that creates or uses it, the independent check,
and what that check returned on a live run (timings from the run's own trace; run
`2026-10-26T01-03-25-fbc453`, request `examples/input/example_2.json` from empty agent state, 58 Zetaris
statements, 0 errors, 2 min 19 s end to end including Nemotron calls).

## Sources

| Object | Created by | Checked by | Live result |
|---|---|---|---|
| `CPSC_REST.recalls_2026h2` (Lightning REST table, saferproducts.gov, a top-level JSON array) → view `recallfeeds.cpsc_recalls` | `sql/01_feeds.sql` | `DESCRIBE`, the Cartographer's feed profile | 189 notices; re-fetched on every query |
| `OPENFDA_REST.food_enforcement` (REST table) → view `recallfeeds.fda_food` (`LATERAL VIEW explode(results)`) | `sql/01_feeds.sql` | same | 333 notices; 92 print a 12–14-digit barcode, 50 more once spaces and dashes are removed |
| `erp` (JDBC → Postgres): `skus`, `stores`, `inventory`, `sales` | `sql/02_retail_sources.sql` | `SHOW DATASOURCE TABLES`, `DESCRIBE DATASOURCE TABLE` (Cartographer, 52–79 ms each) | 900 items, 24 stores, 14,982 lots |
| `supplier_portal` (JDBC → Postgres): `suppliers`, `ship_notices` | same | same | 40 suppliers, 14,705 ship notices (14,244 with a barcode) |

Federated queries the agents run on them: REST × JDBC (the Scout's UPC sweep of the live FDA feed against the
ERP item master, 8.2 s; the Auditor's UPC re-check against the live notice) and JDBC × JDBC (ship notices ⋈
suppliers ⋈ item master; exposure by store and lot; units sold since the recall).

## What the agents write back

| Object | Written by | When | Checked by | Live result |
|---|---|---|---|---|
| `reconciled.ship_notice_item_keys` (schemastore view): ship notices joined to our items under the barcode rules proven so far | Cartographer, `publish()` in `src/agents/cartographer.ts` | after it proves a supplier's rule on every one of that supplier's ship notices | read back per supplier (`SELECT COUNT(*) … WHERE supplier_id = …`); Zetaris lineage `INFER SQLTABLE SOURCES SPEC` (87 ms: `supplier_portal`, `erp`) | SUP010 193/193 read back |
| USL `recall_keys.notice_item` + DQ rule `barcode_names_the_notice_sku` (`item_sku = notice_sku`) | `sql/03_writeback.sql`; re-bound by `ACTIVATE USL TABLE` in `publish()` | same | `RUN DQ` (24.5 s) | every row valid, 0 invalid |
| `reconciled.case_verdicts` (schemastore view over `VALUES`): every verdict of the run | Orchestrator, `publishVerdicts()` in `src/zetaris-usl.ts` | end of every live run | read back from the USL table `decision`; 3 DQ rules (below) | 4/4 read back |

Both writes run under a signed, single-use execution contract (Meterless Scout Intent, `src/contract.ts`):
the contract names the exact views and USL tables it may change, is verified before each statement, and
expires after 5 minutes. The trace carries `contract.issued` / `contract.verified` events (2 issued, 5
verified in the run above).

## The governed model: USL `recall_exposure`

`sql/04_usl.sql` (one `COMPILE USL` statement, then descriptions, activations and rules; checks in
`sql/04_usl_check.sql`). Seven tables, every one described; the keys are the joins the agents rely on.

| Table | Activated from | Keys | Rows |
|---|---|---|---|
| `supplier` | `supplier_portal.suppliers` | PK `supplier_id` | 40 |
| `item` | `erp.skus` | PK `sku`, FK `supplier_id → supplier` | 900 |
| `store` | `erp.stores` | PK `store_id` | 24 |
| `inventory_lot` | `erp.inventory` | PK `(store_id, sku, lot_code)`, FK `store_id → store`, FK `sku → item` | 14,982 |
| `ship_notice` | `supplier_portal.ship_notices` ⟕ `reconciled.ship_notice_item_keys` | PK `asn_id`, FK `supplier_id → supplier`, FK `notice_sku → item`, **FK `matched_sku → item`** | 14,244 |
| `recall_notice` | `recallfeeds.fda_food` ∪ `recallfeeds.cpsc_recalls` (live) | PK `recall_id` | 333 + 189 |
| `decision` | `reconciled.case_verdicts` | PK `(run_id, recall_id, sku)`, FK `recall_id → recall_notice`, FK `sku → item` | one row per verdict of the latest run |

18 data-quality rules (`LIST DQ USL`): the keys above plus three custom rules — `on_hand_not_negative`,
`ships_units` (`units > 0`), `known_verdict` (`verdict IN ('same', 'not-this', 'unsure')`).

**The barcode key is where the fragments show.** `ship_notice.matched_sku` is the item a ship notice's barcode
reaches under the rules the Cartographer has proven; a notice no proven rule reaches carries `unreached`, so
`RUN DQ matched_sku` counts it invalid and `SHOW DQ INVALID RECORD matched_sku` lists it, with its supplier and
its barcode. After every map correction the Cartographer re-binds the table and reports Zetaris's count:

| State of the map | `RUN DQ matched_sku` (valid / total) | Unreached, by supplier (from `SHOW DQ INVALID RECORD`) |
|---|---|---|
| Fresh run, after SUP010's rule (proposed by Nemotron, proven 193/193) | 11,705 / 14,244 (24.2 s) | 2,539: SUP007 458, SUP028 391, SUP001 390, SUP037 373, SUP019 339, SUP014 307, … |
| After the live runs of 26 Oct (SUP007 and SUP028 proven too) | 12,361 / 14,244 (16.7 s) | 1,883: SUP001 390, SUP037 373, SUP019 339, SUP014 307, SUP035 281, SUP010 193 |

Every other key holds: `item.supplier_id` 900/900, `inventory_lot.store_id` and `.sku` 14,982/14,982,
`ship_notice.notice_sku` 14,244/14,244, `on_hand_not_negative` 14,982/14,982, `ships_units` 14,244/14,244
(`sql/04_usl_check.sql`, 26 Oct). On the decision table after the run above: `recall_id` 4/4, `sku` 4/4,
`known_verdict` 4/4 — every verdict points at a notice in the live feeds and an item we carry.

**Closing the loop.** The next run reads `reconciled.case_verdicts` before it decides (302 ms) and says so
when a verdict on the same recall and item changed since then (`src/orchestrator.ts`).

## What we learned on 2.4.3.1

- A Lightning REST table accepts a top-level JSON array (CPSC), which the getting-started notes listed as untested.
- `COMPILE USL … DDL` must be sent as one statement with all its `CREATE TABLE` parts; `src/sql/split.ts` joins them back.
- `ACTIVATE USL TABLE` checks nullability against the declaration and suggests the fix (`COALESCE(recall_id, '')`); activation from a schemastore view works, and re-activating with a changed query keeps the rules.
- A key rule is named after its column(s); `RUN DQ <column>` returns one row per constraint type (a column in a primary and a foreign key gives two rows).
- `RUN DQ` on a table activated from a view that joins 14k rows takes about 17–25 s; on tables over plain JDBC sources 0.3–3 s.
- `CREATE SCHEMASTORE VIEW … AS SELECT * FROM VALUES (…) AS t(…)` works, so the agents can publish small result sets as views.
- We found no statement to drop a USL; a probe model (`rw_probe`) stays in the catalog.

## Reproduce

```bash
npm run setup:zetaris                              # sql/01–04, idempotent
npx tsx scripts/zetaris-sql.ts sql/04_usl_check.sql   # the model, counts, every DQ rule, the unreached ship notices
npm run api   # then POST examples/input/*.json to /run; the trace shows every statement above
```
