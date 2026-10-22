# Example runs (real outputs, copied unedited from `out/` and `logs/`)

| Folder | What | Engine |
|---|---|---|
| `01-live-zetaris-run1/` | Recalls since 2026-10-01, first 8 cases. The Auditor blocks "frozen cheese pizza" against a pepperoni-pizza notice three times and escalates it. | Zetaris (live REST feeds + JDBC) |
| `02-human-review.txt` | `npm run queue` shows the escalated case; `npm run decide` stores the reviewer's decision in H-MEM | — |
| `03-live-zetaris-run2-after-human-decision/` | Same input again. The Investigator follows the human decision (`following human decision mem-…`), reuses audited decisions from run 1, and needs 18 model calls instead of 25. | Zetaris |
| `04-sample-mode/` | `SAMPLE_MODE=true`, recalls since 2026-09-20, first 6 cases | DuckDB stand-in (no Zetaris) |

Each folder has `report.md`/`report.html` (open in a browser), `briefs/`, `result.json`, and the full `trace.jsonl`. Traces are not hand-edited.
