# Evaluation

`npx tsx eval/run.ts --model <ollama model>` runs the **real Investigator ⇄ Auditor loop**: the same code as a live run, without briefs. It covers every recall from 2026-07-01 in the sample snapshots (517 notices, 225 cases, 440 SKU pairs). It runs on the DuckDB stand-in, so it needs no Zetaris instance.

**Labels.** A pair counts as *covered* when either:
- the synthetic SKU was generated from that recall (`data/synthetic/eval/ground_truth.csv`, never read by the agents), or
- the SKU's UPC is printed in the notice.

Everything else counts as *not covered*. Labels are strict, so a few "false alarms" are really the same product appearing in a second notice: of the 7 for Nemotron 30B, CPSC 26601 is an expansion of the same grill-brush recall.

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
- **The Auditor's checks guard against false matches, not false dismissals.** Those checks are grounded quotes, every product word present in the notice, package size, the ingredient-only rule and model-number conflicts.
- A dismissed recall is the dangerous error: recalled stock stays on the shelf. So the judge should lean toward SAME and let the Auditor prune.
- Nemotron 30B does exactly that. It catches every text match on its first answer, and the Auditor removes 200 of its 207 false alarms. Ambiguous pairs go to a human instead of being guessed.
- The two small models are conservative and dismiss 14–18 real matches, which no later check can recover.

Results per pair are in `eval/results/*.json`. `python3 eval/first-vs-final.py <tag>` recomputes the second table from the eval trace.
