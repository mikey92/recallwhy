# ACT NOW — VAN RYSEL GRVL AF BICYCLES

recalled stock is on our shelves · **cpsc:27017** · Decathlon America LLC, of San Francisco, California · 2026-10-08 · [notice](https://www.cpsc.gov/Recalls/2027/Decathlon-America-Recalls-Van-Rysel-GRVL-AF-Bicycles-Due-to-Risk-of-Serious-Injury-or-Death-from-Crash-Hazard)

> Decathlon America Recalls Van Rysel GRVL AF Bicycles Due to Risk of Serious Injury or Death from Crash Hazard

## Why
The recall notice from Decathlon America LLC identifies Van Rysel GRVL AF Bicycles because the front lock nut can loosen during use, causing the front wheel to dislodge and posing a crash hazard [E1][E2][E3]. Our inventory matches the recalled product and, because the notice names no lot codes, every lot we hold is treated as affected [E6][E7][E8]. We currently have 639 units on hand across 8 stores and have sold 83 units to 47 loyalty customers since the recall date of 2026-10-08 [E9][E10][E11][E12].

## What we matched
- `NW-100855` VAN RYSEL GRVL AF BICYCLES — **same** (judge, text): notice names "Van Rysel GRVL AF Bicycles"

## Actions
- Pull lots L24-1266, L24-1422, L24-2682, L24-4540, L24-6344, L24-6778, L24-7184, L24-8579… from 8 store(s): S002 (125), S006 (103), S017 (97), S011 (90), S014 (82), S001 (74) [E10]
- Send recall notice to loyalty customers who bought affected lots since 2026-10-08: at most 47 [E12]
- Contact Supplier S002 (synthetic) for credit and replacement [E13]

## Caveats
- Retailer stock, sales, lots and ship notices are synthetic (Northwind Mercantile, generated for this demo); food items are real products with real barcodes (USDA FoodData Central, Open Food Facts).
- The notice lists no lot codes we could verify, so every lot of the SKU is treated as affected.
- Customer count sums weekly distinct counts, so it is an upper bound.

## Evidence
- [E1] notice_firm: "Decathlon America LLC, of San Francisco, California" — *zetaris q-5dbe7a18dc by Scout*
- [E2] notice_product_text: "Decathlon America Recalls Van Rysel GRVL AF Bicycles Due to Risk of Serious Injury or Death from Crash Hazard — Van Rysel GRVL AF Bicycles — This recall involv — *zetaris q-5dbe7a18dc by Scout*
- [E3] notice_reason: "The recalled bicycles' front lock nut can loosen during use, causing the front wheel to dislodge or loosen over time, posing a crash hazard." — *zetaris q-5dbe7a18dc by Scout*
- [E4] notice_recall_date: "2026-10-08" — *zetaris q-5dbe7a18dc by Scout*
- [E5] notice_distribution_states: "nationwide" — *zetaris q-5dbe7a18dc by Scout*
- [E6] match_decision: "NW-100855 VAN RYSEL GRVL AF BICYCLES: same — notice names \"Van Rysel GRVL AF Bicycles\"" — *model by Investigator*
- [E7] our_affected_lots: "the notice names no lot codes, so every lot we hold is treated as affected: L24-1266, L24-1422, L24-2682, L24-4540, L24-6344, L24-6778, L24-7184, L24-8579, L24 — *zetaris q-23b3efa928 by Investigator*
- [E8] lot_rule: "all-lots" — *agent by Investigator*
- [E9] our_stores_holding_affected_lots: 8 — *zetaris q-23b3efa928 by Investigator*
- [E10] our_units_on_hand_in_affected_lots: 639 — *zetaris q-23b3efa928 by Investigator*
- [E11] our_units_sold_since_recall_date: 83 — *zetaris q-a622f36f37 by Investigator*
- [E12] our_loyalty_customers_who_bought_affected_lots: 47 — *zetaris q-a622f36f37 by Investigator*
- [E13] our_supplier_for_this_sku: "Supplier S002 (synthetic)" — *zetaris q-8ee9fdaf41 by Investigator*
- [E14] our_stores_with_units_on_hand: ["S002 CA: 125","S006 WA: 103","S017 NJ: 97","S011 MN: 90","S014 WI: 82","S001 CA: 74","S016 NY: 46","S010 IL: 22"] — *zetaris q-23b3efa928 by Investigator*
- [E15] verdict: "act-now" — *agent by Auditor*

_why-paragraph written by meterless:nvidia/nemotron-3-ultra-550b-a55b and checked by the Auditor; run 2026-10-26T18-45-17-abf16c_
## Action packet (drafts, not sent)
- [pull-list.csv](../actions/case-cpsc-27017/pull-list.csv)
- [supplier-request.md](../actions/case-cpsc-27017/supplier-request.md)
- [customer-notice.md](../actions/case-cpsc-27017/customer-notice.md)
- Pull 639 unit(s) in 8 store(s); the total equals the Auditor's re-derived on-hand. Approve it in the review screen (review.html, or `npm run approve -- 2026-10-26T18-45-17-abf16c case-cpsc-27017`).
