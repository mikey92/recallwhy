# RecallWhy

**Demo video:** https://youtu.be/_c3crNZhIUc · **Slides:** [deck/RecallWhy-deck.pdf](deck/RecallWhy-deck.pdf)

**Open Agent Hackathon 2026 · Track 1: Solving Fragmented Intelligence**

A retailer's safety team gets dozens of federal recall notices a week. For each one they need to know: *do we sell this, which lots, which stores still have it, how many customers bought it — and why do we believe that?* Today that means hand-checking the recall feed against the ERP and the supplier portal.

The answer is spread over four systems that were never meant to meet: two federal feeds (REST), the ERP and the supplier portal (two Postgres databases), each with its own way of writing a product. RecallWhy is a team of five agents that first maps those fragments through **Zetaris** (what tables exist, which identifier columns are really the same key, and where they disagree) and then investigates every new CPSC and FDA recall across them with federated SQL. For each recall it returns an evidence-backed action brief, a "not ours" with the reason, or an escalation to a human when the evidence isn't strong enough. Every number in a brief traces back to the SQL query that produced it. Every claim about the notice traces back to words that are literally in the notice.

```
 live CPSC feed ─┐  (Zetaris Lightning REST tables)
 live FDA feed  ─┤
                 ├── Zetaris ── federated SQL ──┐
 ERP (Postgres) ─┤  (JDBC datasources)          │
 supplier portal ┘                              ▼
  Cartographer ──► Scout ──► Investigator ◄──critique── Auditor ──► Briefer ──► brief.md
  (catalog, join tests) ◄──── barcode rows its key can't reach ──┘
       └── corrected map (per-supplier rule) ──────────────────►
                   │   ▲  (≤2 revisions, then human queue)  ▲
                   ▼   │                                    │
           H-MEM (decisions, trust)      World Model (facts + provenance) ─┘
                   ▲
             human `decide`
```

## Agents

| Agent | Does | Can |
|---|---|---|
| **Cartographer** | Before any case: lists every Zetaris datasource, Lightning database and schemastore view, describes their columns and tags barcode, SKU and lot columns. Profiles barcode lengths and tests each cross-source barcode join as written and without leading zeros. Finds that a third of the suppliers send GTIN-14 (UPC-12 padded with `00`): 7,856 of 14,180 barcoded ship notices join as written, 12,785 after stripping leading zeros. The other 1,395 join neither way; it says so and leaves them open. When the Auditor sends back rows its key cannot reach, it diagnoses that supplier's barcodes, tests the fix on **every** ship notice from that supplier, and only then corrects the map (for example: SUP007 sends the 11-digit UPC without its check digit, 484 of 484 rows). Skips the Zetaris sample databases with the reason logged. | Tell the Auditor which join to trust; correct the map mid-run |
| **Scout** | Pulls recalls since a date from the two live feed views. Loads the item master. Runs one federated query that joins the live FDA feed (REST) with ERP SKUs (JDBC) on UPC digits. Opens a case for each recall that touches our catalog. | Delegate cases to the Investigator |
| **Investigator** | Reads prior decisions from H-MEM. Decides each candidate: UPC or model number → rule; text match → **NVIDIA Nemotron** judge, which must quote the notice. Reads lot codes (regex plus Nemotron). Computes exposure with federated SQL: on-hand units by store and lot, units sold since the recall date, loyalty customers to notify, and the supplier from ship notices. | Revise when the Auditor blocks it |
| **Auditor** | Re-checks each UPC match against the *live notice in Zetaris*. Checks that judge quotes and lot codes are verbatim in the notice, and that every product word of our item appears in the notice (catches "cheese pizza" ≠ "pepperoni pizza"). **Re-derives every exposure number with its own SQL**, aggregated in the database rather than in code. Confirms affected lots against supplier ship notices, reached by barcode (a different key than the Investigator's SKU join). If the barcode reaches fewer lots than the SKU, it sends those rows to the Cartographer rather than blocking the Investigator, which could not fix a key format. Rejects briefs that cite missing evidence or state numbers not in the evidence. | **Block** (max 2 revision rounds, then escalate to the human queue) |
| **Briefer** | Writes the brief only from the World Model context builder (numbered evidence with provenance). Nemotron writes the "why" paragraph; the Auditor checks it. Actions and caveats are computed. | Fall back to a template if the model's draft keeps failing the check |

Every message, SQL call, model call, memory read/write and world write goes to `logs/trace-<run>.jsonl` and stdout. Traces come only from the code path; nothing is hand-written.

## How the sponsor technology is used

**Zetaris (load-bearing: every agent reads data only through it)**
- `sql/01_feeds.sql` registers two live **Lightning REST tables**:
  - saferproducts.gov CPSC recalls. Its response is a top-level JSON array, which Zetaris accepted; the getting-started notes listed that shape as untested.
  - api.fda.gov food enforcement.

  Both are flattened into schemastore views (`recallfeeds.cpsc_recalls`, `recallfeeds.fda_food`). REST tables re-fetch on query, so each run reads the feeds as they are at that moment.
- `sql/02_retail_sources.sql` registers the synthetic ERP and supplier-portal Postgres databases as two **JDBC datasources**.
- Agents run federated queries across REST × JDBC (the Scout's UPC sweep, the Auditor's UPC re-check against the live notice) and JDBC × JDBC (ship notices ⋈ ERP item master).
- The Auditor verifies the Investigator by **querying Zetaris again with differently written SQL**.
- `scripts/setup-zetaris.ts` sets all of this up through the Zetaris REST API (`/api/proxy/sql-editor/sqls/run-query`, with `X-Org-ID` and a fresh `X-Request-ID` per call).

**Meterless agent engines** (mounted from [github.com/Meterless/Meterless](https://github.com/Meterless/Meterless), Apache-2.0, see `src/engines/*/NOTICE`)
- **H-MEM** (`src/engines/hmem`, wrapper `src/memory.ts`): every adjudication is stored, agents' at confidence 0.6 and humans' (`npm run decide`) at 0.95 in long-term memory. Before judging, the Investigator reads the exact prior decisions for that recall/SKU pair plus similar past cases. A human decision is followed and cited in the brief. The trust ledger records every read and write.
- **World Model** (`src/engines/world-model`, wrapper `src/world.ts`): recalls, cases and findings are entities and facts. Every write carries provenance: source kind, agent, and the SQL id or model call. `buildContext()` is the ContextBuilder, and it is the **only** input the Briefer sees, so a brief can only cite what the team actually established.

**Meterless Nightshift (primary AI provider)**: every model call goes through one injected generator (`src/llm.ts`) to Nightshift's OpenAI-compatible Runtime API on the same machine (`http://127.0.0.1:8088/v1`, with `meterless-app` and `meterless-scope` headers; the runtime token is read from Nightshift's own token file or `METERLESS_RUNTIME_TOKEN`). The NVIDIA key lives in Nightshift's provider store, not in this repository. Each `llm.call` / `llm.result` trace event records the requested model, the model Nightshift actually routed to (`served_model`) and its receipt id; the live viewer and the report show `requested ⇒ served` per call. Transient errors (429, 502–504, first-token timeouts) are retried with backoff and logged as `llm.retry`.

**NVIDIA Nemotron**: `nvidia/nemotron-3-ultra-550b-a55b`, called through Nightshift, is the default model. It judges text matches (and must quote the notice), reads lot codes out of messy `code_info` text, and writes the why-paragraph that the Auditor checks. `nvidia/nemotron-3.5-lightning-30b-a3b` was also evaluated through Nightshift. Ollama (`LLM_PROVIDER=ollama`) and any other OpenAI-compatible endpoint (`LLM_PROVIDER=openai`) remain available as alternatives.

**Cursor**: the repository was developed in Cursor. The Cursor agent scaffolded it and wrote these parts, each reviewed and corrected before committing (commits marked "Cursor agent"):
- the synthetic retailer generator and Postgres loader
- the Zetaris REST runner, plus its retry and type handling (I fixed its UPC-to-number coercion bug)
- the DuckDB sample-mode runner with its Spark→DuckDB dialect shim
- their tests

Other AI coding assistants were also used; every change was reviewed by me.

## Run it

Requirements: Node 22+, Docker, Meterless Nightshift with an NVIDIA provider key (or Ollama / any OpenAI-compatible endpoint), and a Zetaris instance for live mode.

```bash
npm install
cp .env.example .env          # fill in Zetaris and Postgres settings
docker compose up -d && npm run load     # synthetic ERP + supplier portal
npm run setup:zetaris                    # register feeds + datasources in Zetaris
# Nightshift running, NVIDIA key added under Setup ▸ Providers (LLM_PROVIDER=meterless is the default)
npm run agents -- --since 2026-09-15     # → out/<run>/report.html + report.md, briefs/, logs/trace-<run>.jsonl
npm run view                             # http://127.0.0.1:8899 — watch the five agents live, open reports
```

Real outputs from these commands, with their traces, are in [`examples/`](examples/): a live Zetaris run, the human review step, the re-run that follows the human decision, and a sample-mode run.

**API and Docker** (what a judge or another program calls):

```bash
docker build -t recallwhy . && docker run --rm -p 8000:8000 -e SAMPLE_MODE=true recallwhy
curl -X POST localhost:8000/run -H 'Content-Type: application/json' -d @examples/input/example_1.json
curl localhost:8000/runs/<runId>/trace     # the run's JSONL trace
curl localhost:8000/runs/<runId>/report    # its HTML report
```

With live Zetaris and Nightshift, pass the same `.env` and point the container at the host. Inside a container `localhost` is the container itself, and the Nightshift token file is not mounted, so the token goes in `METERLESS_RUNTIME_TOKEN`:

```bash
docker run --rm -p 8000:8000 --env-file .env \
  -e METERLESS_BASE_URL=http://host.docker.internal:8088/v1 \
  -e ZETARIS_BASE_URL=http://host.docker.internal:3000 \
  recallwhy
# If another app holds port 3000 on the host, join Zetaris's network instead:
#   --network zetaris_default -e ZETARIS_BASE_URL=http://zetaris-ui-1:3000
```

`POST /run {since, only?, limit?}` returns the verdict per case, the briefs, the engine (`zetaris` or `duckdb-sample`) and the model. Inputs are validated (bad dates, limits outside 1–50 and non-list `only` get a 400), and one run happens at a time (409 while busy). Without Nightshift or Zetaris the container still answers, in sample mode with rules only. If Zetaris is configured but does not answer, the run falls back to sample mode and the trace says why (`ZETARIS_FALLBACK=false` makes it fail instead). `examples/input/` has three request bodies. `npm run api` starts the same server without Docker.

**No credentials? Sample mode:**

```bash
SAMPLE_MODE=true npm run agents -- --since 2026-09-15 --limit 10
```

The same agents and the same SQL run against an in-process DuckDB stand-in, over feed snapshots in `sample/` (captured at the time in `sample/CAPTURED_AT`) and the synthetic CSVs. Output is labelled `duckdb-sample`; Zetaris is not used in this mode. With `LLM_PROVIDER=none` the agents still run: text matches go to the human queue, and briefs use the template.

**Human in the loop and memory across runs:**

```bash
npm run queue                                           # escalated cases
npm run decide -- H-1378-2026 NW-100010 not-this --note "ours is MILD, recall is MEDIUM only"
npm run agents -- --only H-1378-2026                    # Investigator follows the stored decision
```

## Failure handling

| Failure | What happens | Where |
|---|---|---|
| Zetaris configured but not answering | The run falls back to the sample stand-in; the trace has the `sql.error` and a note saying why (`ZETARIS_FALLBACK=false` to fail instead) | `src/sql/index.ts` |
| No Zetaris credentials, or `SAMPLE_MODE=true` | Same agents and SQL on the DuckDB stand-in, labelled `duckdb-sample` | `src/sql/duck.ts` |
| Nightshift 429, 502–504, first-token timeout | Retried after 3 s, 8 s and 20 s, each retry logged as `llm.retry` | `src/llm.ts` |
| Model call still failing, or no token | The judge answers UNSURE and the pair goes to the human queue; lot reading falls back to the regex; the Briefer uses its template | `src/agents/investigator.ts`, `briefer.ts` |
| Model claim not supported by the notice or the data | The Auditor blocks it and sends a critique; after 2 revisions the case is escalated to a human | `src/agents/auditor.ts` |
| Bad request to `POST /run` | `400` with the reason; `409` if a run is already going | `src/api.ts` |

## Evaluation

**Cartographer ablation** (rules only, so the model plays no part; same 440 pairs):

| Setup | Covered caught (of 194) | Sent to human | Cartographer corrections |
|---|---|---|---|
| No Cartographer: barcodes join as written, no loop | 12 | 428 | — |
| Map only on demand: no upfront map, the Auditor sends every mismatch back | 103 | 337 | 11 supplier rules learned from cases (7 padding, 4 check digit) |
| **Upfront map + loop** (default) | **103** | 337 | padding found upfront; all 4 check-digit suppliers learned from cases |

Without the Cartographer, every GTIN-14 or check-digit supplier looks like a lot that was never shipped, so the Auditor blocks real matches. Files: `eval/results/none-none*.json`.


`eval/run.ts` runs the real Investigator ⇄ Auditor loop (sample mode) on every candidate pair since 2026-07-01: 517 recalls scanned, 225 cases, 440 SKU pairs. A pair counts as covered if the SKU was generated from that recall or its UPC is printed in the notice.

| Judge model (earlier run, through Ollama) | Covered caught (of 194) | Wrongly dismissed | False alarms (of 246) | Sent to human |
|---|---|---|---|---|
| none (rules only) | 103 | 0 | 0 | 337 |
| **NVIDIA Nemotron 3 Nano 30B** | **189** | **0** | **7** | 35 |
| NVIDIA Nemotron 3 Nano 4B | 175 | 18 | 5 | 7 |
| Gemma 4 E4B | 178 | 14 | 5 | 5 |

On text matches, the Nemotron 30B judge's first answers would have raised **207 false alarms**. After the Auditor's checks and the revision loop, **7** remain, with nothing wrongly dismissed. The smaller models dismiss 14–18 real matches, and no Auditor check can win those back. Details and caveats (strict labels, one false alarm is the same product in an expanded recall): [`eval/EVAL.md`](eval/EVAL.md).

## Data

- **Live**:
  - CPSC SaferProducts Recall API (U.S. government work)
  - openFDA food enforcement API (open.fda.gov terms; CC0). openFDA's disclaimer applies: do not rely on it for medical decisions.
- **Synthetic**: Northwind Mercantile (24 fictional stores, 900 SKUs, inventory lots, weekly sales, supplier ship notices), generated by `scripts/gen-synthetic.ts` (seeded).
  - About 120 SKUs are deliberately built from real recall notices so the catalog overlaps the feeds. About half of those carry a lot code taken from the notice.
  - Evaluation ground truth lives in `data/synthetic/eval/` and is never read by the agents.
  - There is no personal data. Loyalty customers are counts, not identities.

## Limitations

- The retailer data is synthetic. Real item masters abbreviate harder, and real lot codes come from receiving scans.
- A text match rests on a 30B model reading English, and the Auditor's checks are lexical: grounding, item words, lot tokens. Ambiguous cases go to a human instead of being guessed.
- The loyalty-customer count sums weekly distinct counts, so it is an upper bound.
- CPSC notices rarely print UPCs (4 of 184 in the snapshot), so CPSC matching leans on model numbers and the judge.
- The feed windows are fixed in `sql/01_feeds.sql` (2026-07-01 onward). Recalls before that date aren't read.
- Nightshift and Zetaris run locally on one Mac for this build. Hosted NVIDIA endpoints are rate-limited, so long evaluations can see 429s; those calls are retried and logged.

## Prior work and adapted code

- The matching ideas (brand gate, product-kind overlap, model-number conflict, quotes grounded in the notice) come from my own **Recall Sloth** ([github.com/mikey92/recall-sloth](https://github.com/mikey92/recall-sloth), committed 21 Oct 2026, before the build window; declared in the submission form). `src/match.ts` is new code written for this project.
- `src/engines/hmem` and `src/engines/world-model` are the Meterless reference implementations (Apache-2.0), mounted unchanged except where `CHANGES.md` notes otherwise.
- Libraries: `pg`, `@duckdb/node-api`, `tsx`, `typescript`.
