# RecallWhy — build spec (read before editing)

Open Agent Hackathon 2026, Track 1: "Solving Fragmented Intelligence".

## Problem
A regional retailer's safety team gets dozens of federal recall notices a week (CPSC consumer
products, FDA food enforcement). For each one they must answer: do we sell this, which lots,
which stores still hold it, how many customers bought it, and *why do we believe that*.
Today that is manual cross-checking between the recall feed, the ERP and the supplier portal.

RecallWhy is a team of agents that investigates each new recall across those sources through
Zetaris federated SQL and returns an evidence-backed action brief, or says "not ours" with the
reason, or escalates to a human when the evidence is not good enough.

## Data (retailer stock, sales and ship notices are SYNTHETIC and labelled as such; food items are real products)
- Live public feeds, registered in Zetaris as Lightning REST tables:
  - `CPSC_REST.recalls_2026h2`   (saferproducts.gov Recall API, top-level JSON array)
  - `OPENFDA_REST.food_enforcement` → view `recallfeeds.fda_food` (api.fda.gov food enforcement)
- Synthetic retailer "Northwind Mercantile (synthetic)" in Postgres, two databases registered
  in Zetaris as two JDBC datasources:
  - `erp` : stores(store_id, name, city, state), skus(sku, upc, title, brand, department,
    supplier_id), inventory(store_id, sku, lot_code, on_hand, received_on),
    sales(store_id, sku, lot_code, sold_on, units, loyalty_customers)
    (loyalty_customers is a COUNT of distinct synthetic loyalty IDs, never identities)
  - `supplier_portal` : suppliers(supplier_id, name, contact_role), ship_notices(asn_id,
    supplier_id, sku, upc, lot_code, shipped_on, units, dc_state)
- Food lines of `erp.skus` are real products (`data/real/`: USDA FoodData Central CC0, Open Food Facts
  ODbL): every product whose barcode an FDA notice in `sample/` prints, same-brand siblings, and a
  seeded FDC shelf sample. Non-food lines are synthetic (CPSC-derived or invented).
- Store locations are real SNAP-authorized supermarkets (`data/real/stores.json`, USDA FNS, public
  domain); the chain name (Northwind) is fictional and no row names the real business at an address.
- No personal data anywhere.

## Agents (separate roles, separate prompts, talk through the bus; every message is traced)
0. Cartographer — before any case, maps the sources through Zetaris's catalog statements, tags
   barcode/SKU/lot columns, profiles identifier formats (also in the live feeds) and tests the
   cross-source barcode joins. Writes the source map to the World Model. When the Auditor sends
   back ship-notice rows the map's key cannot reach, it diagnoses that supplier, tests the fix on
   all of its ship notices and corrects the map (`reconcile` in src/agents/cartographer.ts).
1. Scout — pulls recalls reported since a date from the Zetaris feed views, normalises them
   (recall id, firm, product text, UPCs, lot codes, model numbers, states), and opens one case
   per recall in the World Model.
2. Investigator — for one case: (a) asks H-MEM for prior adjudications on this firm/product,
   (b) runs federated SQL in Zetaris to find candidate SKUs (exact UPC join first, then
   brand+kind text candidates), (c) asks the judge model (NVIDIA Nemotron) whether a text
   candidate is the same product, quoting the recall's words, (d) computes exposure with SQL:
   affected lots, on-hand units per store, units sold since the recall's initiation date,
   loyalty customers to notify (count), shipping states vs the recall's distribution pattern.
   Produces a Finding with every number tied to the SQL that produced it.
3. Auditor — has authority to BLOCK. Independently re-derives every number in the Finding
   with its own SQL, aggregated in the database instead of summed in code; confirms the affected
   lots through supplier ship notices reached by barcode (sending key mismatches to the
   Cartographer); checks every quote is literally present in the recall text, lot codes are in the
   recall's code_info, every product word of our item is in the notice, and that a dismissal's
   quote does not name our item. Mismatch → returns a critique to the Investigator
   (max 2 revision rounds) → still failing → escalate to human review queue.
4. Briefer — writes the action brief only from the World Model context builder (it never sees
   raw rows): verdict, why (evidence list with source + SQL id), actions (pull lots from
   stores, notify N loyalty customers, contact supplier), caveats. Auditor approves the brief.
5. Action packet (`src/actions.ts`, Orchestrator step) — for act-now/notify cases: pull list per
   store × lot (withheld unless it sums to the Auditor's on-hand), supplier request citing ASNs,
   customer notice (count only). Drafts; approval records who/when; nothing is sent.
6. Weekly digest (`src/digest.ts`) — all cases of a run through the Markovian engine in bounded
   chunks; totals in code; model lines dropped if they state a number no case has.

Human decisions (`npm run decide -- <recall-id> <sku> same|not-this --note ...`) go into H-MEM with high
trust; the next run retrieves them and the Investigator follows them and cites them.

## Meterless engines mounted unchanged (Apache-2.0 reference code; byte-identical to upstream, see engines/*/CHANGES.md)
- `src/engines/hmem/`        H-MEM: MemoryStoreService, MemoryRetrievalService, TrustLedgerService.
- `src/engines/world-model/` World Model: WorldStoreService, IngestPipelineService. `src/world.ts` adds our context builder over its fact view.
- `src/engines/markovian/`   Markovian: chunked chain with compressed carryover, used by `src/digest.ts`.
Engine state persists under `state/` (gitignored). Engines emit JSONL to `logs/`.

## Model calls
All LLM calls go through one injected `Generator` (src/llm.ts):
- `meterless` provider (default) → Meterless Nightshift Runtime API (`127.0.0.1:8088/v1`), model
  `nvidia/nemotron-3-ultra-550b-a55b` for judging, briefs, the Auditor's check and the digest, and
  `nvidia/nemotron-3.5-lightning-30b-a3b` for reading lot codes (tier "fast", `METERLESS_FAST_MODEL`);
  the trace records the requested and routed model and the receipt per call,
- `ollama` provider → any local model; `openai` provider → any OpenAI-compatible endpoint,
- `none` → no model: text matches go to the human queue, briefs use the template.
  Configured only by env vars. No keys in code.

## Modes
- Live (default when Zetaris env vars are set): real Zetaris REST API, real feeds.
- `SAMPLE_MODE=true`: no credentials. Same agents, same SQL, executed by a local DuckDB
  stand-in over `sample/` snapshots of the feeds (captured on a stated date) and the synthetic
  CSVs. Output and logs are labelled SAMPLE. Never claim Zetaris was used in sample mode.

## Rules
- Never hardcode outputs or write traces by hand. Traces come only from the code path.
- No secrets in the repo. `.env` is gitignored; `.env.example` has placeholders.
- Keep functions small, typed (TypeScript, Node 22+, run with tsx), tested with node:test.
