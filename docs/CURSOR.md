# How Cursor was used

The repository was started in Cursor on 21 Oct 2026 (Pacific time; the build window opened 22 Oct 00:00 UTC =
21 Oct 17:00 Pacific). The Cursor agent wrote the scaffolding in two commits, both marked "Cursor agent":

| Commit | What the Cursor agent wrote | Reviewed and changed after |
|---|---|---|
| `b6d8851` 17:19 | project skeleton, the seeded synthetic retailer generator (`scripts/gen-synthetic.ts`), the Postgres loader (`scripts/load-postgres.ts`), the docker setup | generator extended later with real products, real store locations and the barcode quirks; loader now checks the data contract (`docs/DATA-CONTRACT.md`) |
| `152c040` 17:30 | the SQL layer: the Zetaris REST runner (`src/sql/zetaris.ts`), the DuckDB sample-mode runner with its Spark→DuckDB dialect shim (`src/sql/duck.ts`), their tests | the runner coerced barcode strings to numbers (a 12-digit UPC lost its leading zero); fixed and covered in `05594b0`; re-login on 401, request ids and traced failures added |

The same commit also carries the first matcher, case memory and World Model wrapper; its title lists them apart from the Cursor agent's part.

Everything after these two commits (the five agents, the orchestrator, the Auditor's checks, the Cartographer's
barcode rule proofs and write-back, Scout Intent routing, the review screen, the evaluation) was written without
the Cursor agent (other AI coding assistants were used), and every change was reviewed before committing. To see the Cursor agent's commits:

```bash
git log --grep='Cursor agent' --stat
```
