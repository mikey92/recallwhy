# Evaluation

`npx tsx eval/run.ts` (defaults: `--provider meterless --model nvidia/nemotron-3-ultra-550b-a55b`) runs the **real Investigator ⇄ Auditor loop**: the same code as a live run, without briefs. It covers every recall from 2026-07-01 in the sample snapshots (515 notices, 184 cases, 322 SKU pairs). It runs on the DuckDB stand-in, so it needs no Zetaris instance.

**Item master.** Food lines are real products (`data/real/`): the 95 products whose barcodes FDA notices print, 86 other products of the same brand owners, and 260 FoodData Central products no notice prints. Non-food lines are synthetic, about 50 built from CPSC notice text. Stock, lots, sales and ship notices are synthetic for all.

**Labels.** A pair counts as *covered* when either:
- the item is the one the notice recalls (`data/synthetic/eval/ground_truth.csv`, never read by the agents): for food, the real product whose barcode the notice prints; for non-food, the SKU built from that CPSC notice; or
- the SKU's barcode is printed in the notice.

Everything else counts as *not covered*. 146 pairs are covered (97 food, 49 non-food) and 176 are not: 175 of those are food items of the recalling firm's brand owner that are not the recalled product (another flavour, size or line). The CPSC titles are built from the notice text (upper-cased, clipped, model appended), so the non-food text matches are easier than with a real item master.

## Current code (25 Oct 2026)

| Judge model | Covered caught (of 146) | Wrongly dismissed | False alarms (of 176) | Sent to human | Model calls failed after retries | Time |
|---|---|---|---|---|---|---|
| none (rules only, `--provider none`) | 89 | 0 | 0 | 233 | — | 14 s |
| none for the judge, Ultra for the Cartographer only (`--provider none --map-model …`) | 99 | 0 | 0 | 223 | — | 1 min |
| NVIDIA Nemotron 3.5 Lightning 30B-A3B, through Meterless Nightshift | 98 | 10 | 0 | 57 | 0 of 452 | 6,747 s |
| **NVIDIA Nemotron 3 Ultra 550B-A55B, through Meterless Nightshift** | **134** | **1** | **1** | 30 | 0 of 392 | 6,153 s |

Text matches only (223 pairs, 47 covered), judge's first answer vs the final decision (`python3 eval/first-vs-final.py meterless-nvidia_nemotron-3-ultra-550b-a55b`; the first answers are committed in `eval/results/*-first-answers.json`, so this runs from a clean clone):

| | Caught | Wrongly dismissed | False alarms | Sent to human |
|---|---|---|---|---|
| Ultra, judge's first answer | 43 | 4 | 2 | 0 |
| Ultra, after the Auditor loop | 45 | 1 | 1 | 20 |
| Lightning, judge's first answer | 6 | 41 | 0 | 0 |
| Lightning, after the Auditor loop | 9 | 10 | 0 | 47 |
The remaining miss is a generated CPSC title that names no product (`CORDLESS VACUUM CLEANERS WITH LITHIUM-ION` against a notice listing model numbers). The false alarm is a real George J. Howe sunflower-seed SKU (the salted 11 oz recalled by H-1118-2026) matched to H-1119-2026, the same firm's unsalted 6/11 oz seeds. Of the 30 pairs sent to a person, 10 are barcode matches inside a case the Auditor escalated for another SKU (an escalated case goes to the reviewer whole), 19 are same-brand items whose dismissal the Auditor objected to because the judge's own quote names our item's words (Spring & Mulberry's plain "Date-sweetened chocolate" against each flavour's notice, "Salsa Fresca Medium" against "Tomato Salsa Fresca"), and 1 is a CPSC grill brush.

**What changed to get here.** On 25 Oct the item master's food lines became real products. The first Ultra run on it (same code but a broader dismissal rule: send a dismissal to a person when the quote names *half* of our product words) caught the same 134 but sent 112 pairs to a person: 100 of them correct dismissals of another flavour of the same brand ("Mango Pico De Gallo" against "Hot Pico De Gallo"). The rule now needs *every* product word of ours in the quote (vendor words, units and descriptors aside), which keeps size and count differences with a person and lets other flavours stay dismissed: 112 → 30 to a person, with the same catches.

## Real public products (25 Oct 2026)

[`REAL.md`](REAL.md) asks the text question on the same 95 real products with their barcodes hidden (97 positives, 152 real hard negatives; `npx tsx eval/real-items.ts`). Barcode path: 97/97 settled by the UPC rule without a model, 97 re-checked, 0/152 negatives matched. Barcode hidden, Ultra judge plus Auditor: 55/97 caught, 23 dismissed, 2/152 false alarms, 31 to a person.

## Earlier item master (24 Oct: food titles generated from the notice text; not comparable with the tables above)

### 24 Oct run

| Judge model | Covered caught (of 194) | Wrongly dismissed | False alarms (of 246) | Sent to human | Model calls failed after retries | Time |
|---|---|---|---|---|---|---|
| none (rules only, `--provider none`) | 22 | 0 | 0 | 418 | — | 14 s |
| none for the judge, Ultra for the Cartographer only (`--provider none --map-model …`) | 103 | 0 | 0 | 337 | — | 20 s |
| NVIDIA Nemotron 3.5 Lightning 30B-A3B, through Meterless Nightshift | 139 | 10 | 2 | 66 | 0 of 652 | 1,181 s |
| **NVIDIA Nemotron 3 Ultra 550B-A55B, through Meterless Nightshift** | **187** | **3** | **6** | 23 | 0 of 538 | 4,329 s |

Text matches only (336 pairs, 90 covered), judge's first answer vs the final decision (`python3 eval/first-vs-final.py meterless-nvidia_nemotron-3-ultra-550b-a55b`; the first answers are committed in `eval/results/*-first-answers.json`, so this runs from a clean clone):

| | Caught | Wrongly dismissed | False alarms | Sent to human |
|---|---|---|---|---|
| Ultra, judge's first answer | 80 | 10 | 10 | 0 |
| Ultra, after the Auditor loop | 85 | 3 | 6 | 21 |
| Lightning, judge's first answer | 14 | 76 | 1 | 0 |
| Lightning, after the Auditor loop | 37 | 10 | 2 | 64 |

Lightning is almost four times faster but conservative: it answers DIFFERENT for 76 of the 90 covered text matches. The dismissal check sends 66 of those back, where they end up caught or with a human. Ultra is the default because it misses the fewest recalls.

**What changed to get here, and why.** The first Ultra run dismissed 16 covered pairs. Reading them showed two causes, both ours:
- The judge prompt introduced the item master's `brand` column as the brand. It holds the vendor we buy from (taken from the recalling firm), e.g. "Conair Of Stamford" for a Cuisinart grill brush, so a strict model answered "different brand". The prompt now calls it the vendor and says titles are abbreviated.
- The Auditor only checked matches. It now also rejects a dismissal whose own quote names every product word of our item; if the judge holds to it, the pair goes to a human.

The hosted model rate-limits per minute. With three retries, 60 of 522 calls failed in one run and fell back to UNSURE, which inflated "sent to human". The client now waits up to five times (3–90 s); the run above had no failed calls. Every run's JSON reports `modelCalls.failedAfterRetries`.

The 3 remaining wrongly dismissed pairs are generator artefacts more than model errors: one SKU's barcode was derived wrongly from the notice's GTIN (`WINFIELD'S CWB 8OZ`, 008100798339 vs the notice's 00810079833030), and two generated titles name no product at all (`LIGHT-UP CHILDREN'S TOYS`, `CORDLESS VACUUM CLEANERS WITH LITHIUM-ION` against a notice listing model numbers). We left the data as it is rather than fix it to suit the model.


## Earlier runs (21 Oct, older prompt, data and Auditor — not comparable with the table above)

| Judge model (via the one injected generator) | Covered caught (of 194) | Wrongly dismissed | False alarms (of 246) | Sent to human | Time |
|---|---|---|---|---|---|
| none (rules only, `LLM_PROVIDER=none`) | 103 | 0 | 0 | 337 | 17 s |
| **NVIDIA Nemotron 3 Nano 30B-A3B** | **189** | **0** | **7** | 35 | 768 s |
| NVIDIA Nemotron 3 Nano 4B | 175 | 18 | 5 | 7 | 463 s |
| Gemma 4 E4B | 178 | 14 | 5 | 5 | 341 s |

**What the Auditor adds.** These are text matches only. "Judge alone" is the model's first answer from the same trace.

| Model | Judge alone: false alarms | After the Auditor loop | Wrongly dismissed (both) |
|---|---|---|---|
| Nemotron 3 Nano 30B | 207 | **7** | 0 |
| Nemotron 3 Nano 4B | 68 | 5 | 18 |
| Gemma 4 E4B | 14 | 5 | 14 |

**Reading it:**
- **(21 Oct) The Auditor's checks then guarded against false matches, not false dismissals; the dismissal check was added on 23 Oct.** Those checks are grounded quotes, every product word present in the notice, package size, the ingredient-only rule and model-number conflicts.
- A dismissed recall is the dangerous error: recalled stock stays on the shelf. So the judge should lean toward SAME and let the Auditor prune.
- Nemotron 30B does exactly that. It catches every text match on its first answer, and the Auditor removes 200 of its 207 false alarms. Ambiguous pairs go to a human instead of being guessed.
- The two small models are conservative and dismiss 14–18 real matches, which no later check can recover.

Results per pair are in `eval/results/*.json`. `python3 eval/first-vs-final.py <tag>` recomputes the first-answer tables. Each result file also lists the supplier rules the Cartographer learned (`cartographerRules`) and the model calls that failed after retries (`modelCalls`).
