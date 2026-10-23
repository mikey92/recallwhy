import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barcodeJoin, chart } from "../src/agents/cartographer.ts";
import type { AgentContext } from "../src/agents/context.ts";
import { DuckSampleRunner } from "../src/sql/duck.ts";
import { CaseMemory } from "../src/memory.ts";
import { World } from "../src/world.ts";
import { Trace } from "../src/trace.ts";

test("Cartographer discovers the GTIN-14 padding and the Auditor gets the normalized join", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-carto-"));
  const trace = new Trace({ dir, quiet: true, runId: "carto" });
  const sql = new DuckSampleRunner({ trace });
  await sql.ready;
  try {
    const map = await chart({ sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen: async () => "", model: "none" } as unknown as AgentContext);
    assert.ok(map.tables.some((t) => t.name === "erp.skus" && t.columns.find((c) => c.name === "upc")?.role === "barcode"));
    const j = map.joins.find((x) => x.left === "supplier_portal.ship_notices" && x.right === "erp.skus")!;
    assert.ok(j.normalized > j.asWritten, "some suppliers send padded barcodes");
    assert.equal(j.normalized, j.leftRows, "every barcoded ship notice joins once zeros are stripped");
    assert.equal(j.chosen, "normalized");
    assert.match(barcodeJoin(map, "supplier_portal.ship_notices", "erp.skus", "a", "s"), /regexp_replace\(a\.upc/);
    assert.equal(barcodeJoin(undefined, "x", "y", "a", "b"), "a.upc = b.upc");
  } finally {
    await sql.close();
  }
});
