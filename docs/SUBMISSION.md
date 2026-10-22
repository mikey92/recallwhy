# RecallWhy — submission text

**Project name:** RecallWhy

**One sentence:** Agents that tell a retailer's product-safety manager which newly recalled products are on its shelves — which lots, which stores, how many customers to notify — and show the evidence for every claim.

**Short description:**
Every week U.S. regulators publish dozens of recall notices (517 CPSC and FDA notices since July). For a retailer, each one means cross-checking the recall feed against the ERP and the supplier portal by hand. RecallWhy does that investigation with four agents. The Scout reads the live CPSC and FDA feeds through Zetaris, joins them with the item master, and opens a case for every recall that touches the catalog. The Investigator decides which SKUs the notice covers: UPC and model-number rules, plus NVIDIA Nemotron for text matches with quotes from the notice. It also reads lot codes and computes exposure with federated SQL: units on hand by store and lot, units sold since the recall began, loyalty customers to notify, and the supplier. The Auditor can block it. It re-checks the live notice in Zetaris, requires quotes and lot codes to appear verbatim, and catches a different variety ("cheese" vs "pepperoni") or a product that only contains ours as an ingredient. It also re-derives every number with its own SQL and checks each sentence of the brief against the evidence it cites. After two failed revisions, a case goes to a human. The Briefer writes the action brief only from the Meterless World Model, where every fact carries its source query. Human decisions go into Meterless H-MEM with high trust, and the next run follows them.

**Track:** The Agent That Can Explain Why

**Repository:** https://github.com/mikey92/recallwhy

## Sponsor technology

**Zetaris — the only data path.** Two live public APIs are registered as Lightning REST tables. The CPSC Recall API returns a top-level JSON array, and Zetaris accepted it. The openFDA food enforcement API is the other. Both are flattened into schemastore views. Two synthetic Postgres databases (ERP, supplier portal) are registered as JDBC datasources. Every agent query goes through the Zetaris REST API:
- the Scout's REST × JDBC join of live FDA notice text against ERP UPCs
- the Investigator's ship notices ⋈ suppliers ⋈ item-master joins across the two databases
- the Auditor's independent re-query of the live notice and of every exposure number

Setup is code (`npm run setup:zetaris`).

**Meterless — memory and provenance.** The H-MEM and World Model reference engines are mounted in `src/engines/` (Apache-2.0).
- **H-MEM** stores every decision: the agents' at 0.6 trust, humans' at 0.95. The Investigator reads it before judging. Human decisions are followed and cited, audited agent decisions are reused without a model call, and the trust ledger records each read and write.
- **World Model** holds recalls, cases and findings as facts with provenance: agent, SQL id, model call. Its ContextBuilder is the Briefer's only input, so a brief cannot cite something the team did not establish.

**Cursor (with Space XAI).** The repository was developed in Cursor. The Cursor agent did the scaffolding, the synthetic data generator and Postgres loader, the Zetaris REST runner, the DuckDB sample-mode runner with its dialect shim, and their tests. Each change was reviewed and corrected before commit (commits marked "Cursor agent").

**NVIDIA.** Nemotron 3 Nano (30B-A3B, via Ollama) is the one injected model behind every agent call:
- the match judge
- the lot-code reader
- the why-paragraph
- the Auditor's sentence-support check

The same code reaches NVIDIA's hosted API through an OpenAI-compatible endpoint (`LLM_PROVIDER=openai`). In our evaluation over 440 recall/SKU pairs, Nemotron 3 Nano 30B was the only judge that wrongly dismissed nothing (189/194 caught; the 4B Nemotron and Gemma 4 E4B dismissed 18 and 14).

**What was unique.** The Auditor treats Zetaris as the ground truth for its own checks. Instead of trusting the Investigator or the model, it re-queries the live REST table and the JDBC sources itself. It cut the judge's false alarms from 207 to 7 with nothing wrongly dismissed. Meterless memory makes a human's correction change the next run, and every line of a brief traces to the query behind it.

## Pre-existing components
- Matching ideas (brand gate, product-kind overlap, model-number conflict, quotes grounded in the notice) come from my Recall Sloth project (github.com/mikey92/recall-sloth, committed 21 Oct 2026). RecallWhy's matcher (`src/match.ts`) is new code.
- Meterless engine reference implementations (open source, Apache-2.0), mounted unchanged.
- The local Zetaris instance was installed from Zetaris's getting-started repository before the build window. That is tooling, not project code.
