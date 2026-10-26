import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trace } from "../src/trace.ts";
import { sqlId, type SqlResult } from "../src/sql/types.ts";
import { bySupplier, checkShipNoticeKey, dqRow, mergeVerdicts, priorVerdicts, publishVerdicts, verdictsViewSql, USL } from "../src/zetaris-usl.ts";
import type { AgentContext } from "../src/agents/context.ts";

// A Zetaris stand-in: answers by the statement's first words, records every statement.
function fakeZetaris(answers: [RegExp, Record<string, unknown>[]][]) {
  const seen: string[] = [];
  const sql = {
    engine: "zetaris" as const,
    async run(q: string): Promise<SqlResult> {
      seen.push(q);
      const hit = answers.find(([re]) => re.test(q));
      return { sqlId: sqlId(q), engine: "zetaris", columns: [], rows: hit ? hit[1] : [], ms: 1 };
    },
    async close() {},
  };
  const trace = new Trace({ dir: mkdtempSync(join(tmpdir(), "rw-usl-")), quiet: true, runId: "usl-run" });
  return { ctx: { sql, trace } as unknown as AgentContext, seen };
}

test("dqRow picks the foreign-key row when a rule name is also a key column", () => {
  const rows = [{ type: "Primary Key Constraint", total_record: "10", valid_record: "10", invalid_record: "0" }, { type: "Foreign Key Constraint", total_record: "10", valid_record: "7", invalid_record: "3" }];
  assert.deepEqual(dqRow(rows, "sku", "t", /foreign/i), { rule: "sku", table: "t", total: 10, valid: 7, invalid: 3 });
  assert.equal(dqRow([], "sku", "t"), undefined);
});

test("bySupplier counts Zetaris's invalid records per supplier, largest first", () => {
  assert.deepEqual(bySupplier([{ supplier_id: "SUP037" }, { supplier_id: "SUP001" }, { supplier_id: "SUP001" }]), [{ supplier: "SUP001", n: 2 }, { supplier: "SUP037", n: 1 }]);
});

test("checkShipNoticeKey re-binds ship_notice, runs the key rule and names the unreached ship notices", async () => {
  const { ctx, seen } = fakeZetaris([
    [/^RUN DQ matched_sku/, [{ type: "Foreign Key Constraint", total_record: "14244", valid_record: "12361", invalid_record: "3" }]],
    [/^SELECT supplier_id, COUNT\(\*\) AS n, MIN\(asn_id\)/, [{ supplier_id: "SUP001", n: "2", asn_id: "A1", notice_upc: "6078000010" }, { supplier_id: "SUP037", n: "1", asn_id: "A3", notice_upc: "2" }]],
  ]);
  const k = (await checkShipNoticeKey(ctx, { rules: ["SUP028 no-check-digit 391/391"] }))!;
  assert.match(seen[0], new RegExp(`^ACTIVATE USL TABLE ${USL.replace(/\./g, "\\.")}\\.ship_notice AS[\\s\\S]*COALESCE\\(r\\.item_sku, 'unreached'\\)`));
  assert.deepEqual([k.total, k.valid, k.invalid], [14244, 12361, 3]);
  assert.deepEqual(k.bySupplier, [{ supplier: "SUP001", n: 2 }, { supplier: "SUP037", n: 1 }]);
  assert.equal(k.examples[0].asn_id, "A1");
});

test("the verdicts view escapes quotes and stays valid with no verdicts", () => {
  const v = verdictsViewSql("run-1", [{ recall_id: "fda:H-1", sku: "NW-1", verdict: "same", basis: "upc", decided_by: "agent" }, { recall_id: "cpsc:2", sku: "NW-2", verdict: "not-this", basis: "text", decided_by: "person" }]);
  assert.match(v, /^CREATE SCHEMASTORE VIEW case_verdicts WITH CONTAINER reconciled AS/);
  assert.match(v, /\('run-1', 'fda:H-1', 'NW-1', 'same', 'upc', 'agent'\),\n {2}\('run-1', 'cpsc:2'/);
  assert.match(v, /AS t\(run_id, recall_id, sku, verdict, basis, decided_by\)$/);
  assert.match(verdictsViewSql("r", [{ recall_id: "x'y", sku: "s", verdict: "same", basis: "b", decided_by: "agent" }]), /'x''y'/);
  assert.match(verdictsViewSql("r", []), /WHERE recall_id <> 'none'$/);
});

test("publishVerdicts writes the view, re-binds the decision table, reads it back and runs its rules; priorVerdicts reads them", async () => {
  const { ctx, seen } = fakeZetaris([
    [/^SELECT COUNT\(\*\) AS n FROM .*decision/, [{ n: "2" }]],
    [/^RUN DQ (recall_id|sku)/, [{ type: "Foreign Key Constraint", total_record: "2", valid_record: "2", invalid_record: "0" }]],
    [/^RUN DQ known_verdict/, [{ type: "Custom Data Quality", total_record: "2", valid_record: "2", invalid_record: "0" }]],
    [/^SELECT run_id, recall_id, sku, verdict, basis, decided_by FROM reconciled\.case_verdicts/, [{ run_id: "old", recall_id: "fda:H-1", sku: "NW-1", verdict: "unsure", basis: "text", decided_by: "agent" }]],
  ]);
  const r = (await publishVerdicts(ctx, [{ recall_id: "fda:H-1", sku: "NW-1", verdict: "same", basis: "upc", decided_by: "agent" }, { recall_id: "fda:H-1", sku: "NW-2", verdict: "not-this", basis: "text", decided_by: "person" }]))!;
  assert.deepEqual(seen.slice(0, 3).map((q) => q.split(/\s+/).slice(0, 3).join(" ")), ["DROP VIEW IF", "CREATE SCHEMASTORE VIEW", "ACTIVATE USL TABLE"]);
  assert.deepEqual([r.written, r.read, r.carried], [2, 2, 0]);
  assert.deepEqual(r.dq.map((d) => `${d.rule} ${d.valid}/${d.total}`), ["recall_id 2/2", "sku 2/2", "known_verdict 2/2"]);
  const prior = await priorVerdicts(ctx);
  assert.deepEqual(prior.get("fda:H-1 NW-1"), { run_id: "old", verdict: "unsure", decided_by: "agent", basis: "text" });
});

test("on the DuckDB stand-in nothing is written and nothing is read", async () => {
  const { ctx, seen } = fakeZetaris([]);
  (ctx.sql as { engine: string }).engine = "duckdb-sample";
  assert.equal(await checkShipNoticeKey(ctx), undefined);
  assert.equal(await publishVerdicts(ctx, []), undefined);
  assert.equal((await priorVerdicts(ctx)).size, 0);
  assert.equal(seen.length, 0);
});

test("mergeVerdicts carries earlier verdicts this run did not decide and keeps one row per recall and item", () => {
  const prior = new Map([["fda:H-1 NW-1", { run_id: "old", verdict: "unsure", decided_by: "agent", basis: "text" }], ["fda:H-2 NW-9", { run_id: "old", verdict: "same", decided_by: "person", basis: "text" }]]);
  const now = [{ recall_id: "fda:H-1", sku: "NW-1", verdict: "same", basis: "upc", decided_by: "agent" as const }, { recall_id: "fda:H-1", sku: "NW-1", verdict: "same", basis: "upc", decided_by: "agent" as const }];
  const m = mergeVerdicts("new", now, prior);
  assert.deepEqual(m.map((r) => `${r.run_id} ${r.recall_id} ${r.sku} ${r.verdict} ${r.decided_by}`).sort(), ["new fda:H-1 NW-1 same agent", "old fda:H-2 NW-9 same person"]);
  assert.match(verdictsViewSql("new", m), /\('old', 'fda:H-2', 'NW-9', 'same', 'text', 'person'\)/);
});
