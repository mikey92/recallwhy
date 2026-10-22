# RecallWhy — build spec (read before editing)

Open Agent Hackathon 2026, Track 2: "The Agent That Can Explain Why".

## Problem
A regional retailer's safety team gets dozens of federal recall notices a week (CPSC consumer
products, FDA food enforcement). For each one they must answer: do we sell this, which lots,
which stores still hold it, how many customers bought it, and *why do we believe that*.
Today that is manual cross-checking between the recall feed, the ERP and the supplier portal.

RecallWhy is a team of agents that investigates each new recall across those sources through
Zetaris federated SQL and returns an evidence-backed action brief, or says "not ours" with the
reason, or escalates to a human when the evidence is not good enough.

## Data (all retailer data is SYNTHETIC and labelled as such)
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
- No personal data anywhere. Store names and cities are fictional.

## Agents (separate roles, separate prompts, talk through the bus; every message is traced)
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
   with its own SQL written differently (e.g. from supplier ship notices instead of ERP
   inventory), checks every quote is literally present in the recall text, checks lot codes
   really appear in the recall's code_info. Mismatch → returns a critique to the Investigator
   (max 2 revision rounds) → still failing → escalate to human review queue.
4. Briefer — writes the action brief only from the World Model context builder (it never sees
   raw rows): verdict, why (evidence list with source + SQL id), actions (pull lots from
   stores, notify N loyalty customers, contact supplier), caveats. Auditor approves the brief.

Human decisions (`recallwhy decide <case> same|not-this --note ...`) go into H-MEM with high
trust; the next run retrieves them and the Investigator must honour or explicitly overrule them.

## Meterless engines mounted (Apache-2.0 reference code, adapted, see engines/*/NOTICE)
- `src/engines/hmem/`        H-MEM: MemoryStoreService, MemoryRetrievalService, TrustLedgerService.
- `src/engines/world-model/` World Model: WorldStoreService, IngestPipelineService, ContextBuilder.
Engine state persists under `state/` (gitignored). Engines emit JSONL to `logs/`.

## Model calls
All LLM calls go through one injected `Generator` (src/llm.ts):
- `ollama` provider → `nemotron-3-nano` (default) or any local model,
- `openai` provider → any OpenAI-compatible endpoint (NVIDIA API Catalog / Meterless runtime),
  configured only by env vars. No keys in code.

## Modes
- Live (default when Zetaris env vars are set): real Zetaris REST API, real feeds.
- `SAMPLE_MODE=true`: no credentials. Same agents, same SQL, executed by a local DuckDB
  stand-in over `sample/` snapshots of the feeds (captured on a stated date) and the synthetic
  CSVs. Output and logs are labelled SAMPLE. Never claim Zetaris was used in sample mode.

## Rules
- Never hardcode outputs or write traces by hand. Traces come only from the code path.
- No secrets in the repo. `.env` is gitignored; `.env.example` has placeholders.
- Keep functions small, typed (TypeScript, Node 22+, run with tsx), tested with node:test.
