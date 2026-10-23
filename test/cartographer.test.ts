import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barcodeJoin, chart, reconcile } from "../src/agents/cartographer.ts";
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
    assert.ok(j.normalized < j.leftRows, "some suppliers' barcodes join neither way and are left open");
    assert.equal(j.chosen, "normalized");
    assert.match(barcodeJoin(map, "supplier_portal.ship_notices", "erp.skus", "a", "s"), /regexp_replace\(a\.upc/);
    assert.equal(barcodeJoin(undefined, "x", "y", "a", "b"), "a.upc = b.upc");
  } finally {
    await sql.close();
  }
});

test("the Auditor's mismatch goes back to the Cartographer, which learns the supplier's barcode rule", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-reconcile-"));
  const trace = new Trace({ dir, quiet: true, runId: "reconcile" });
  const sql = new DuckSampleRunner({ trace });
  await sql.ready;
  try {
    const ctx = { sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen: async () => "", model: "none" } as unknown as AgentContext;
    ctx.map = await chart(ctx);
    const rows = (await sql.run("SELECT sku, lot_code FROM supplier_portal.ship_notices WHERE supplier_id = 'SUP007' AND upc <> '' LIMIT 5", { agent: "test", purpose: "pick rows" })).rows;
    const skus = rows.map((r) => String(r.sku)), lots = rows.map((r) => String(r.lot_code));
    const reach = async () => Number((await sql.run(`SELECT COUNT(*) AS n FROM supplier_portal.ship_notices a JOIN erp.skus s ON ${barcodeJoin(ctx.map, "supplier_portal.ship_notices", "erp.skus", "a", "s")}
      WHERE a.supplier_id = 'SUP007' AND a.upc <> ''`, { agent: "test", purpose: "reach" })).rows[0]?.n);
    assert.equal(await reach(), 0, "the upfront map cannot reach SUP007's 11-digit barcodes");
    const learned = await reconcile(ctx, "case-test", skus, lots);
    assert.deepEqual(learned.map((r) => [r.supplier, r.transform]), [["SUP007", "no-check-digit"]]);
    assert.ok(learned[0].rows > 0 && (await reach()) === learned[0].rows, "the corrected map reaches every SUP007 ship notice");
    assert.deepEqual(await reconcile(ctx, "case-test", skus, lots), [], "nothing left to learn the second time");
  } finally {
    await sql.close();
  }
});
