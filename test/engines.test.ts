// Meterless engine tests: each engine is exercised through the feature that uses it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaseMemory } from "../src/memory.ts";
import { World, buildContext } from "../src/world.ts";
import { Trace } from "../src/trace.ts";
import { decide } from "../src/agents/investigator.ts";
import type { AgentContext } from "../src/agents/context.ts";
import type { Case } from "../src/agents/scout.ts";
import type { Candidate } from "../src/match.ts";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `rw-${p}-`));
const quiet = (dir: string, runId: string) => new Trace({ dir, quiet: true, runId });

const recall = { id: "fda:F-0001-2026", feed: "fda_food", number: "F-0001-2026", date: "2026-10-01", reported: "2026-10-08", firm: "Acme Foods", title: "Acme Frozen Pepperoni Pizza 12 oz", text: "Acme Frozen Pepperoni Pizza, 12 oz box", reason: "Undeclared milk", codeInfo: "", upcs: [], models: [], states: "nationwide" };
const cand = { sku: { sku: "SKU-1", title: "Acme Frozen Cheese Pizza 12 oz", upc: "000111222333" }, basis: "text", evidence: "Acme pizza", brandWords: ["acme"] } as unknown as Candidate;
const theCase = { id: "case-1", recall, recallEntity: "e-1", candidates: [cand] } as unknown as Case;

test("H-MEM: a human decision from session 1 survives a restart and changes the session-2 decision", async () => {
  const dir = tmp("hmem"), logs = tmp("logs");
  // Session 1: a reviewer says this SKU is not covered.
  new CaseMemory(quiet(logs, "s1"), dir).record({ recallId: recall.id, sku: "SKU-1", verdict: "not-this", reason: "cheese, not pepperoni", by: "human", runId: "s1" }, "Human");

  // Session 2: a fresh process. The judge model would say SAME, but must not even be asked.
  let modelCalls = 0;
  const t2 = quiet(logs, "s2");
  const ctx = { trace: t2, memory: new CaseMemory(t2, dir), gen: async () => { modelCalls++; return "SAME: pizza"; } } as unknown as AgentContext;
  const d = await decide(ctx, theCase, cand);
  assert.equal(d.verdict, "not-this");
  assert.equal(d.decidedBy, "human-memory");
  assert.equal(modelCalls, 0);

  // Without the memory the same candidate goes to the judge and comes back SAME.
  const t3 = quiet(logs, "s3");
  const fresh = { trace: t3, memory: new CaseMemory(t3, tmp("hmem-empty")), gen: async () => { modelCalls++; return "SAME: Frozen Pizza"; } } as unknown as AgentContext;
  assert.equal((await decide(fresh, theCase, cand)).verdict, "same");
  assert.equal(modelCalls, 1);
});

test("H-MEM: human decisions outrank agent decisions on the same pair", () => {
  const dir = tmp("hmem2"), t = quiet(tmp("logs"), "r");
  const mem = new CaseMemory(t, dir);
  mem.record({ recallId: recall.id, sku: "SKU-1", verdict: "same", reason: "judge said same", by: "agent", runId: "r" }, "Investigator");
  mem.record({ recallId: recall.id, sku: "SKU-1", verdict: "not-this", reason: "reviewer", by: "human", runId: "r" }, "Human");
  const hits = new CaseMemory(t, dir).priorDecisions(recall.id, "SKU-1", "Investigator");
  assert.equal(hits.length, 2);
  assert.ok(hits[0].tags.includes("by:human"));
  assert.ok(hits[0].confidence > hits[1].confidence);
});

test("World Model: the same entity written twice keeps one id, facts persist with provenance, and the Briefer's context cites them", async () => {
  const dir = tmp("world"), t = quiet(tmp("logs"), "w");
  const w1 = new World(t, dir);
  const a = await w1.entity("recall", "fda", "F-0001-2026", "Acme recall", {}, { kind: "zetaris", by: "Scout", ref: "q-1" });
  const b = await w1.entity("recall", "fda", "F-0001-2026", "Acme recall", {}, { kind: "zetaris", by: "Auditor", ref: "q-2" });
  assert.equal(a, b);
  await w1.fact(a, "our_units_on_hand", 379, { kind: "zetaris", by: "Investigator", ref: "q-7" });

  const w2 = new World(t, dir); // restart
  const facts = w2.facts(a);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].value, 379);
  assert.equal(facts[0].source.url, "q-7");
  const ctx = buildContext(w2, [a], "Briefer", t);
  assert.match(ctx.text, /\[E1\] our units on hand: 379/);
  assert.match(ctx.evidence[0].source, /zetaris q-7 by Investigator/);
});
