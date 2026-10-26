import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trace } from "../src/trace.ts";
import { sqlId, type SqlResult } from "../src/sql/types.ts";
import { remember, rulesViewSql, barcodeJoin, type SourceMap } from "../src/agents/cartographer.ts";
import type { AgentContext } from "../src/agents/context.ts";

test("rulesViewSql keeps every rule with its ops as JSON", () => {
  const v = rulesViewSql("run-9", [
    { supplier: "SUP028", transform: "no-check-digit", rows: 391, learnedFrom: "case-a", sqlId: "q-1" },
    { supplier: "SUP010", transform: "proposed", rows: 193, learnedFrom: "case-b", sqlId: "q-2", ops: { supplier: ["digits_only"], ours: ["drop_first:1", "drop_last:1"] }, proposedBy: "meterless:nvidia/nemotron" },
  ]);
  assert.match(v, /^CREATE SCHEMASTORE VIEW supplier_rules WITH CONTAINER reconciled AS/);
  assert.match(v, /\('SUP028', 'no-check-digit', 'null', '391', 'case-a', 'run-9', ''\)/);
  assert.match(v, /'\{"supplier":\["digits_only"\],"ours":\["drop_first:1","drop_last:1"\]\}'/);
});

test("remembered rules are re-proven on every ship notice before they join the map; one that no longer holds is dropped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-remember-"));
  const trace = new Trace({ dir, quiet: true, runId: "remember" });
  const sql = {
    engine: "zetaris" as const,
    async run(q: string): Promise<SqlResult> {
      const rows = /FROM reconciled\.supplier_rules/.test(q)
        ? [{ supplier_id: "SUP028", transform: "no-check-digit", ops: "null", proven_rows: "391", learned_from: "case-a", run_id: "r1", proposed_by: "" },
           { supplier_id: "SUP010", transform: "proposed", ops: '{"supplier":["digits_only"],"ours":["drop_first:1","drop_last:1"]}', proven_rows: "193", learned_from: "case-b", run_id: "r1", proposed_by: "m" },
           { supplier_id: "SUP001", transform: "no-check-digit", ops: "null", proven_rows: "390", learned_from: "case-c", run_id: "r1", proposed_by: "" },
           { supplier_id: "x'; DROP", transform: "no-check-digit", ops: "null", proven_rows: "1", learned_from: "", run_id: "", proposed_by: "" }]
        : /supplier_id = 'SUP028'/.test(q) ? [{ n: 391, ok: 391 }] : /supplier_id = 'SUP010'/.test(q) ? [{ n: 193, ok: 193 }] : [{ n: 390, ok: 12 }];
      return { sqlId: sqlId(q), engine: "zetaris", columns: [], rows, ms: 1 };
    },
    async close() {},
  };
  const ctx = { sql, trace } as unknown as AgentContext;
  const map: SourceMap = { tables: [], skipped: [], barcodes: [], joins: [] };
  const kept = await remember(ctx, map);
  assert.deepEqual(kept.map((r) => `${r.supplier} ${r.rows}`), ["SUP028 391", "SUP010 193"]);
  assert.match(barcodeJoin(map, "supplier_portal.ship_notices", "erp.skus", "a", "s"), /a\.supplier_id = 'SUP028'[\s\S]*a\.supplier_id = 'SUP010'/);
  const msg = readFileSync(join(dir, "trace-remember.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.kind === "msg");
  assert.match(msg.text, /remembered 2 supplier rule\(s\) from Zetaris \(reconciled\.supplier_rules\), each re-proven on all its ship notices: SUP028 no-check-digit 391\/391, SUP010 model-proposed 193\/193; no longer holding, dropped: SUP001 12\/390/);
  assert.doesNotMatch(msg.text, /holds for all/, "never reads as a newly proven rule");
});
