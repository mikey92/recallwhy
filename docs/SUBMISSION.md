# RecallWhy — submission text

**Project name:** RecallWhy

**Track:** Solving Fragmented Intelligence (Track 1)

**One sentence:** Five agents that tell a retailer's product-safety manager which newly recalled products are on its shelves — which lots, which stores, how many customers to notify — working across four sources that disagree, with the evidence for every claim.

**Short description:**
Every week U.S. regulators publish dozens of recall notices (517 CPSC and FDA notices since July). For a retailer, each one means cross-checking the recall feeds against the ERP and the supplier portal by hand, and those systems do not even write a barcode the same way. RecallWhy does the investigation with five agents.
- The **Cartographer** maps the sources through Zetaris's catalog, profiles the identifier columns and tests how they join. Its map is a hypothesis: when the Auditor finds ship notices the map's key cannot reach, it sends them back, and the Cartographer diagnoses that supplier's barcodes, proves the fix on all of its ship notices and corrects the map for the rest of the run.
- The **Scout** reads the live CPSC and FDA feeds through Zetaris, joins them with the item master, and opens a case for every recall that touches the catalog.
- The **Investigator** decides which SKUs the notice covers (UPC and model-number rules, NVIDIA Nemotron for text matches, quoting the notice), reads lot codes and computes exposure with federated SQL.
- The **Auditor** can block it: it re-checks the live notice in Zetaris, requires quotes, lot codes, product words and package sizes to be in the notice, rejects a dismissal whose own quote names our product, re-derives every number with its own SQL, and confirms lots through the supplier's ship notices by barcode. After two failed revisions a case goes to a human.
- The **Briefer** writes the action brief only from the World Model context, where every fact carries its source query.

Human decisions go into Meterless H-MEM with high trust, and the next run follows them. The retailer is synthetic; its barcode quirks (GTIN-14 padding, a dropped check digit, a 10-digit core) are planted by the generator, modelled on real EDI feeds.

**Repository:** https://github.com/mikey92/recallwhy

## Sponsor technology

**Zetaris — the only data path.** Two live public APIs are registered as Lightning REST tables (the CPSC Recall API returns a top-level JSON array, and Zetaris accepted it; openFDA food enforcement) and flattened into schemastore views. Two synthetic Postgres databases (ERP, supplier portal) are registered as JDBC datasources. Every agent query goes through the Zetaris REST API:
- the Cartographer's catalog statements (`SHOW DATASOURCES`, `SHOW DATASOURCE TABLES`, `DESCRIBE DATASOURCE TABLE`, `SHOW LIGHTNING DATABASES`, `SHOW TABLES IN`, `DESCRIBE`), barcode profiles and join tests
- the Scout's REST × JDBC join of live FDA notice text against ERP UPCs
- the Investigator's and Auditor's joins across the two databases
- the Auditor's independent re-query of the live notice and of every exposure number

Setup is code (`npm run setup:zetaris`). If Zetaris does not answer, a run falls back to the sample stand-in and the trace says so.

**Meterless.**
- **Nightshift is the primary AI provider.** Every model call goes to its OpenAI-compatible Runtime API (`127.0.0.1:8088/v1`, `meterless-app`/`meterless-scope` headers). The trace records the requested model, the model Nightshift routed to, and the receipt id for each call; transient errors are retried and logged as `llm.retry`.
- **H-MEM** (reference engine, Apache-2.0, `src/engines/hmem`) stores decisions: the agents' in working memory at 0.6 trust, humans' in long-term memory at 0.95. The Investigator reads it before judging; a human decision is followed and cited.
- **World Model** (reference engine, `src/engines/world-model`) holds the source map, recalls, cases and findings as facts with provenance (agent, SQL id, model call). Our context builder over its fact view is the Briefer's only input.
- Tests: `test/engines.test.ts`, `test/llm.test.ts`.

**NVIDIA.** `nvidia/nemotron-3-ultra-550b-a55b`, reached through Nightshift, is the default model: the match judge, the lot-code reader and the why-paragraph. Over 440 recall/SKU pairs it catches 186 of 194 covered pairs (rules alone: 103), with 4 wrongly dismissed, 6 false alarms and 23 sent to a human; 0 of 537 calls failed after retries. On text matches the Auditor cuts the judge's first-answer dismissals from 12 to 4 (`eval/EVAL.md`).

**Cursor (with Space XAI).** The Cursor agent did the scaffolding, the synthetic data generator and Postgres loader, the Zetaris REST runner, the DuckDB sample-mode runner and their tests (commits marked "Cursor agent"). Each change was reviewed and corrected before commit.

**What was unique.** The source map is not trusted either: the agent that verifies the answers is also the one that finds where the map is wrong, and the Cartographer fixes it with evidence from the whole supplier, not one case. When the supplier's format matches no rule in the code, the model proposes a transform from sampled barcode pairs, in a fixed set of string ops (no free SQL), and SQL adopts it only if it holds on every ship notice of that supplier. With the judge off, the Cartographer catches 22 of 194 covered pairs with its known rules and 103 with model proposals; without it, 11.

## Pre-existing components
- Matching ideas (brand gate, product-kind overlap, model-number conflict, quotes grounded in the notice) come from my Recall Sloth project (github.com/mikey92/recall-sloth, committed 21 Oct 2026). RecallWhy's matcher (`src/match.ts`) is new code.
- Meterless engine reference implementations (Apache-2.0), mounted with the changes listed in each `CHANGES.md`.
- The local Zetaris instance was installed from Zetaris's getting-started repository before the build window. That is tooling, not project code.
