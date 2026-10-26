# The same case by hand

What a safety analyst would do for one recall without RecallWhy, step by step, against the same data, next to
what the agents did in the live run `example_2` (Zetaris + Nemotron, trace `examples/output/example_2/trace.jsonl`).
The case: **FDA H-1362-2026**, Taylor Fresh Foods' Salsa Verde Mild, possible Salmonella, five lot codes in the
notice's free text. No person was timed doing it; the steps and their results below are checked against the
committed data (`data/synthetic/`).

| # | By hand | What it takes | What the agents did (same run) |
|---|---|---|---|
| 1 | Find our items for the notice | search the item master by the firm, brand and words in the notice; 4 candidates (Salsa Verde Mild and three other salsas); open each and decide | Scout's UPC sweep finds our UPC 030223075639 printed in the notice (rule, no model); the 3 other salsas judged not-this by Nemotron 3 Ultra, each with a quote from the notice; the Auditor re-checks the UPC in the live notice |
| 2 | Read the lot codes | read the `code_info` free text and copy out TFIC209, TFIC211, TFTX209U11, TFTX211, TFTX213U11 | Nemotron 3.5 Lightning reads them; code keeps each only if it appears word for word |
| 3 | Stock by store and lot | one ERP query: **424 units in 9 stores** | the same query, re-derived by the Auditor with different SQL |
| 4 | Did our supplier ship those lots? | join the supplier portal's ship notices to our item by barcode: **0 rows**. SUP010 writes `3022307563` for our `030223075639` (no leading 0, no check digit). By hand this reads as "never shipped to us", or costs an analyst the time to spot the format and write a substring join | the Auditor sees lots reached by SKU but not by barcode and sends the rows back; the Cartographer samples 6 pairs, Nemotron proposes `drop_first:1 → drop_last:1`, SQL proves it on all 193 SUP010 ship notices, and the corrected map is written back to Zetaris, so the next run and any Zetaris user start from it |
| 5 | Units sold and customers | one query on sales since the recall date: 270 units, at most 131 loyalty customers | the same, re-derived by the Auditor |
| 6 | Where it is outside the notice's states | compare store states with the notice's distribution list by eye | flagged in the brief: stores in WA, CA and OR |
| 7 | Write it up | a pull list per store and lot, a supplier request citing their own ship notices, a customer notice | drafted with every number linked to its query; a person approves |

**Count.** By hand: at least 6 queries across three systems written by the analyst, 4 product decisions, one
barcode-format puzzle, and three documents. The agents: 28 SQL statements and 7 model calls, 98 seconds from
opening the case to its action packet (20:34:18 → 20:35:56 UTC), most of it the paced model and Zetaris's
data-quality runs.

**What this does not show.** How long an analyst takes; the hand path depends on the person and the tools. The
point of step 4 is the failure mode, not the time: a plain barcode join answers 0 rows for this supplier, which
looks like a clean "not shipped" instead of a mismatch.
