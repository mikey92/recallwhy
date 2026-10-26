# Claims and how to check them

`npm run verify` (no credentials, no model, about 3 minutes) runs the type check, every test, `check:claims` (recomputes the numbers below from the committed results and traces and fails if a document says otherwise), the Meterless conformance suites, the Scout Intent eval harness and the model-free evaluations re-run pair by pair.

**REPRODUCIBLE** — a command in this repository shows it, with no credentials. **RECORDED** — produced by a live or model run; the artefact is committed and the check recomputes the claim from it. **NOT CLAIMED** — said plainly so nobody reads it in.

| Claim | Kind | Check |
|---|---|---|
| Recalled items missed: 1 (full system), 4 (agents without the Auditor), 5 (Nemotron 3 Ultra alone, one prompt); 134 of 146 caught, 1 false alarm, 30 to a person | RECORDED | `eval/results/ladder.json` (`npx tsx eval/ladder.ts`), `check:claims` |
| Rules alone catch 89; without the Cartographer 53; with model-proposed barcode rules 99 | REPRODUCIBLE | `npm run check:repro` re-runs them pair by pair |
| Supplier barcodes reach our items for 6,810 of 14,244 ship notices as written, 14,244 after the proven per-supplier rules | REPRODUCIBLE | `npx tsx scripts/join-map.ts` → `docs/JOIN-MAP.md` |
| Labels fixed before the Ultra run, by a mechanical rule | REPRODUCIBLE | `git log -- data/synthetic/eval/ground_truth.csv` (last change `17b8d67`, 25 Oct 13:49 UTC) vs `startedAt` in the Ultra result (16:41 UTC); rule in `eval/run.ts` |
| Same final decision in all three runs for 42 of 44 pairs | RECORDED | `eval/results/repro.json` (`npx tsx eval/repro.ts …`) |
| On real products 97 of 97 barcode recalls found by rule, 0 of 152 look-alikes matched | RECORDED | `eval/REAL.md`, `check:claims` |
| Live: 39 notices since 8 Oct → 5 action packets, 1,093 units in 14 stores, in 4 min 22 s, 0 failed SQL | RECORDED | `examples/output/example_4/trace.jsonl`, `check:claims` |
| A proven supplier rule is written back to Zetaris, read back in full, and Zetaris's DQ rule reports 0 invalid rows | RECORDED | every live example trace, `check:claims` |
| The model never writes SQL | REPRODUCIBLE | `test/e2e.test.ts` |
| A high-risk model answer served by another model than requested is not used | REPRODUCIBLE | `test/llm.test.ts` |
| Meterless H-MEM 13/13, Markovian 8/8, World Model 8/8 upstream conformance; engines byte-identical to Meterless@1742dec | REPRODUCIBLE | `npm run check:engines` |
| Scout Intent official eval harness: gate passes at 1.000; held out (each test prompt removed from the registry) top-1 0.882 and the gate fails one slice | REPRODUCIBLE | `npm run check:scout`, `npm run check:scout:heldout` |
| Median 49.2 s from opening a case to its action packet (live runs) | RECORDED | `eval/results/latency.json` (`npx tsx eval/latency.ts`) |
| Largest digest prompt 584 tokens with Markovian, against 8,726 for one prompt holding all 184 cases | REPRODUCIBLE | `npx tsx eval/markovian.ts` |
| A folder of a retailer's CSV exports is checked against the data contract before loading | REPRODUCIBLE | `npm run check:data -- --dir <folder>`, `test/data-contract.test.ts` |

## Not claimed

- That the retailer data is real: stock, sales, lots and ship notices are synthetic, and so are the barcode quirks (planted by `scripts/gen-synthetic.ts`). Food items, store locations and recall notices are real.
- That RecallWhy is more accurate than the model alone on text matches: there it is not (42 / 0 / 0 / 5 against 45 / 1 / 1 / 20). Its gain is on barcode pairs, on asking a person when unsure, and on everything after the verdict.
- Time or money saved for a real safety team: no team has used it.
- That `fda-traceability.csv` is a complete FSMA 204 submission: it holds the receiving records we have, with their limits in its columns.
- That the Scout Intent 1.000 means much: 19 of its 32 test prompts are examples in the harness's own registry.
- That anything is sent: every supplier request and customer notice is a draft a person approves.
