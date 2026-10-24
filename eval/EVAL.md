# Evaluation

`npx tsx eval/run.ts` (defaults: `--provider meterless --model nvidia/nemotron-3-ultra-550b-a55b`) runs the **real Investigator ⇄ Auditor loop**: the same code as a live run, without briefs. It covers every recall from 2026-07-01 in the sample snapshots (517 notices, 225 cases, 440 SKU pairs). It runs on the DuckDB stand-in, so it needs no Zetaris instance.

**Labels.** A pair counts as *covered* when either:
- the synthetic SKU was generated from that recall (`data/synthetic/eval/ground_truth.csv`, never read by the agents), or
- the SKU's UPC is printed in the notice.

Everything else counts as *not covered*. Labels are strict, so a few "false alarms" are really the same product appearing in a second notice: of the 7 for Nemotron 3 Nano 30B in the 21 Oct run, CPSC 26601 is an expansion of the same grill-brush recall; of Ultra's 6 today, the same grill brush (CPSC 26601) counts again, and the Clover Hill cheese snack pack is labelled with H-1205-2026 but is also named in H-1207-2026.

## Current code (24 Oct 2026)

| Judge model | Covered caught (of 194) | Wrongly dismissed | False alarms (of 246) | Sent to human | Model calls failed after retries | Time |
|---|---|---|---|---|---|---|
| none (rules only, `--provider none`) | 103 | 0 | 0 | 337 | — | 14 s |
| NVIDIA Nemotron 3.5 Lightning 30B-A3B, through Meterless Nightshift | 141 | 10 | 2 | 63 | 0 of 648 | 1,269 s |
| **NVIDIA Nemotron 3 Ultra 550B-A55B, through Meterless Nightshift** | **186** | **4** | **6** | 23 | 0 of 537 | 7,649 s |

Text matches only (336 pairs, 90 covered), judge's first answer vs the final decision (`python3 eval/first-vs-final.py meterless-nvidia_nemotron-3-ultra-550b-a55b`; the first answers are committed in `eval/results/*-first-answers.json`, so this runs from a clean clone):

| | Caught | Wrongly dismissed | False alarms | Sent to human |
|---|---|---|---|---|
| Ultra, judge's first answer | 78 | 12 | 9 | 0 |
| Ultra, after the Auditor loop | 84 | 4 | 6 | 21 |
| Lightning, judge's first answer | 15 | 75 | 0 | 0 |
| Lightning, after the Auditor loop | 39 | 10 | 2 | 61 |

Lightning is six times faster but conservative: it answers DIFFERENT for 75 of the 90 covered text matches. The dismissal check sends 65 of those back, where they end up caught or with a human. Ultra is the default because it misses the fewest recalls.

**What changed to get here, and why.** The first Ultra run dismissed 16 covered pairs. Reading them showed two causes, both ours:
- The judge prompt introduced the item master's `brand` column as the brand. It holds the vendor we buy from (taken from the recalling firm), e.g. "Conair Of Stamford" for a Cuisinart grill brush, so a strict model answered "different brand". The prompt now calls it the vendor and says titles are abbreviated.
- The Auditor only checked matches. It now also rejects a dismissal whose own quote names every product word of our item; if the judge holds to it, the pair goes to a human.

The hosted model rate-limits per minute. With three retries, 60 of 522 calls failed in one run and fell back to UNSURE, which inflated "sent to human". The client now waits up to five times (3–90 s); the run above had no failed calls. Every run's JSON reports `modelCalls.failedAfterRetries`.

The 4 remaining wrongly dismissed pairs are generator artefacts more than model errors: one SKU's barcode was derived wrongly from the notice's GTIN (`WINFIELD'S CWB 8OZ`, 008100798339 vs the notice's 00810079833030), and three generated titles name no product at all (`16 OZ PACKAGED IN FOAM`, `LIGHT-UP CHILDREN'S TOYS`, `CORDLESS VACUUM CLEANERS WITH LITHIUM-ION` against a notice listing model numbers). We left the data as it is rather than fix it to suit the model.

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
