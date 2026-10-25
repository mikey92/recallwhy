import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barcodeJoin, chart, reconcile } from "../src/agents/cartographer.ts";
import { scout } from "../src/agents/scout.ts";
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

test("on Zetaris, the Cartographer reads the catalog statements and skips the sample databases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-zcat-"));
  const trace = new Trace({ dir, quiet: true, runId: "zcat" });
  const seen: string[] = [];
  // Responses shaped like the local Zetaris instance's answers to each catalog statement.
  const answer = (sql: string): Record<string, unknown>[] => {
    if (sql === "SHOW DATASOURCES") return [{ name: "erp" }, { name: "supplier_portal" }];
    if (sql === "SHOW DATASOURCE TABLES erp") return [{ name: "skus" }];
    if (sql === "SHOW DATASOURCE TABLES supplier_portal") return [{ name: "ship_notices" }];
    if (sql.startsWith("DESCRIBE DATASOURCE TABLE")) return [{ col_name: "sku", data_type: "string" }, { col_name: "upc", data_type: "string" }];
    if (sql === "SHOW LIGHTNING DATABASES") return [{ name: "recall_feeds", description: "live recall feeds" }, { name: "tpch", description: "TPC-H sample benchmark" }];
    if (sql === "SHOW TABLES IN recall_feeds") return [{ table_identifier: "recall_feeds.fda_food_rest" }];
    if (sql === "SHOW TABLES IN recallfeeds") return [{ table_identifier: "FDA_FOOD" }];
    if (sql === "DESCRIBE recallfeeds.fda_food") return [{ col_name: "recall_number", data_type: "string" }];
    if (sql.includes("GROUP BY length(upc)")) return sql.includes("ship_notices") ? [{ len: 12, n: 6 }, { len: 14, n: 6 }] : [{ len: 12, n: 10 }];
    if (sql.includes("regexp_replace")) return [{ n: 12 }];
    if (sql.includes("JOIN")) return [{ n: 6 }];
    throw new Error(`unexpected SQL: ${sql}`);
  };
  const sql = { engine: "zetaris", run: async (q: string) => { seen.push(q); return { sqlId: `q-${seen.length}`, engine: "zetaris", columns: [], rows: answer(q), ms: 1 }; }, close: async () => {} };
  const map = await chart({ sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen: async () => "", model: "none" } as unknown as AgentContext);
  assert.deepEqual(map.skipped.map((s) => s.name), ["tpch"]);
  assert.deepEqual(map.tables.map((t) => `${t.kind}:${t.name}`), ["jdbc:erp.skus", "jdbc:supplier_portal.ship_notices", "rest:recall_feeds.fda_food_rest", "view:recallfeeds.fda_food"]);
  assert.ok(!seen.some((q) => q.includes("tpch")), "nothing is queried inside a skipped database");
  const j = map.joins[0];
  assert.deepEqual([j.left, j.asWritten, j.normalized, j.chosen], ["supplier_portal.ship_notices", 6, 12, "normalized"]);
});

test("a live feed that is down does not stop the run: the Scout goes on with the other feed and says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-feeddown-"));
  const trace = new Trace({ dir, quiet: true, runId: "feeddown" });
  const duck = new DuckSampleRunner({ trace });
  await duck.ready;
  try {
    // Like openFDA answering 500 through Zetaris: every query that touches the FDA feed fails.
    // The first FDA read succeeds and every later one fails, as when the feed drops mid-run.
    let fdaReads = 0;
    const sql = { engine: duck.engine, close: () => duck.close(), run: (q: string, meta: { agent: string; purpose: string }) =>
      q.includes("recallfeeds.fda_food") && (meta.agent !== "Scout" || fdaReads++ > 0) ? Promise.reject(new Error("Zetaris query failed 400: REST API call failed: HTTP 500 for api.fda.gov")) : duck.run(q, meta) };
    const ctx = { sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen: async () => "", model: "none" } as unknown as AgentContext;
    const map = await chart(ctx);
    assert.ok(map.joins.length > 0, "the map stands without the feed profile");
    const { cases } = await scout(ctx, { since: "2026-07-01" });
    assert.ok(cases.length > 0, "the run goes on");
    const msgs = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "msg").map((e) => e.text);
    assert.ok(msgs.some((t) => /FDA UPC sweep feed unavailable/.test(t)));
    assert.ok(msgs.some((t) => /could not profile the live feeds/.test(t)));
  } finally {
    await duck.close();
  }
});

test("for a barcode format it has no rule for, the model proposes a transform and SQL decides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-propose-"));
  const trace = new Trace({ dir, quiet: true, runId: "propose" });
  const sql = new DuckSampleRunner({ trace });
  await sql.ready;
  try {
    const rows = (await sql.run("SELECT sku, lot_code FROM supplier_portal.ship_notices WHERE supplier_id = 'SUP019' AND length(upc) = 10 LIMIT 5", { agent: "test", purpose: "pick rows" })).rows;
    const skus = rows.map((r) => String(r.sku)), lots = rows.map((r) => String(r.lot_code));
    const withReply = async (reply: string) => {
      const ctx = { sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen: async () => reply, model: "test:model" } as unknown as AgentContext;
      ctx.map = await chart(ctx);
      return reconcile(ctx, "case-test", skus, lots);
    };
    const wrong = await withReply('{"supplier": ["take_last:10"], "ours": ["drop_last:2"], "why": "guess"}');
    assert.deepEqual(wrong, [], "a proposal SQL disproves is not adopted");
    assert.deepEqual(await withReply('{"supplier": ["digits_only"], "ours": ["x\') OR 1=1 --"]}'), [], "anything outside the op set is refused");
    const right = await withReply('{"supplier": ["digits_only", "take_last:10"], "ours": ["digits_only", "drop_first:1", "drop_last:1"], "why": "10-digit core"}');
    assert.deepEqual(right.map((r) => [r.supplier, r.transform, r.proposedBy]), [["SUP019", "proposed", "test:model"]]);
    const n = Number((await sql.run("SELECT COUNT(*) AS n FROM supplier_portal.ship_notices WHERE supplier_id = 'SUP019' AND upc <> ''", { agent: "test", purpose: "count" })).rows[0]?.n);
    assert.equal(right[0].rows, n, "proven on every SUP019 ship notice");
  } finally {
    await sql.close();
  }
});

test("a live feed that answers with almost nothing is flagged as degraded, not read as a quiet week", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-degraded-"));
  const trace = new Trace({ dir, quiet: true, runId: "degraded" });
  const duck = new DuckSampleRunner({ trace });
  await duck.ready;
  try {
    // Like the CPSC REST table returning one error row with no date during an upstream outage.
    const sql = { engine: duck.engine, close: () => duck.close(), run: (q: string, meta: { agent: string; purpose: string }) =>
      /FROM recallfeeds\.cpsc_recalls/.test(q) && meta.agent === "Cartographer" ? Promise.resolve({ rows: [{ n: 1, with_upc: 0, with_models: 0, date_example: "" }], sqlId: "q-test", ms: 1 }) : duck.run(q, meta) };
    const ctx = { sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen: async () => "", model: "none" } as unknown as AgentContext;
    await chart(ctx);
    const msgs = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "msg").map((e) => e.text as string);
    assert.ok(msgs.some((t) => /WARNING: live feed recallfeeds\.cpsc_recalls looks degraded/.test(t)));
    assert.ok(!msgs.some((t) => /WARNING: live feed recallfeeds\.fda_food/.test(t)), "a healthy feed is not flagged");
  } finally {
    await duck.close();
  }
});
