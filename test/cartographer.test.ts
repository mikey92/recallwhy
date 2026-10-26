import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barcodeColumnsByContent, barcodeJoin, chart, joinTest, publish, reconcile, RECONCILED } from "../src/agents/cartographer.ts";
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
    // Each reply is a separate run: a supplier is diagnosed once per run.
    let runs = 0;
    const withReply = async (reply: string) => {
      const trace = new Trace({ dir, quiet: true, runId: `propose-${++runs}` });
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

test("a proposal SQL rejects gets one retry, with the rows where it failed, and the corrected one is adopted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-repropose-"));
  const trace = new Trace({ dir, quiet: true, runId: "repropose" });
  const sql = new DuckSampleRunner({ trace });
  await sql.ready;
  try {
    const rows = (await sql.run("SELECT sku, lot_code FROM supplier_portal.ship_notices WHERE supplier_id = 'SUP019' AND length(upc) = 10 LIMIT 5", { agent: "test", purpose: "pick rows" })).rows;
    const prompts: string[] = [];
    const replies = ['{"supplier": ["digits_only", "take_last:10"], "ours": ["digits_only", "drop_first:2"], "why": "guess"}',
      '{"supplier": ["digits_only", "take_last:10"], "ours": ["digits_only", "drop_first:1", "drop_last:1"], "why": "drop both ends"}'];
    const gen = async (p: string) => { prompts.push(p); return replies[Math.min(prompts.length - 1, 1)]; };
    const ctx = { sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen, model: "test:model" } as unknown as AgentContext;
    ctx.map = await chart(ctx);
    const learned = await reconcile(ctx, "case-test", rows.map((r) => String(r.sku)), rows.map((r) => String(r.lot_code)));
    assert.deepEqual(learned.map((r) => [r.supplier, r.transform, r.ops?.ours]), [["SUP019", "proposed", ["digits_only", "drop_first:1", "drop_last:1"]]]);
    assert.equal(prompts.length, 2, "one retry");
    assert.match(prompts[1], /matched only 0 of \d+ rows\. Where they fail:/);
  } finally {
    await sql.close();
  }
});

test("on Zetaris, a proven rule is written back as a schemastore view and read back before it counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-publish-"));
  const trace = new Trace({ dir, quiet: true, runId: "publish" });
  const duck = new DuckSampleRunner({ trace });
  await duck.ready;
  try {
    // Zetaris stand-in: DDL is recorded, and reads of the published view run its SELECT on DuckDB.
    const ddl: string[] = []; let viewSelect = "";
    const sql = { engine: "zetaris", close: () => duck.close(), run: (q: string, meta: { agent: string; purpose: string }) => {
      if (/^\s*(CREATE SCHEMASTORE|DROP VIEW)/i.test(q)) { ddl.push(q); const m = q.match(/VIEW ship_notice_item_keys[\s\S]*?\bAS\s+(SELECT[\s\S]+)$/i); if (m) viewSelect = m[1]; return Promise.resolve({ rows: [], sqlId: "q-ddl", ms: 1 }); }
      if (/^\s*INFER SQLTABLE SOURCES/i.test(q)) return Promise.resolve({ rows: [{ datasource: "SUPPLIER_PORTAL.ship_notices", alias: "a" }, { datasource: "ERP.skus", alias: "s" }], sqlId: "q-infer", ms: 1 });
      if (/^\s*ACTIVATE USL TABLE/i.test(q)) return Promise.resolve({ rows: [], sqlId: "q-act", ms: 1 });
      if (/^\s*RUN DQ/i.test(q)) return duck.run(`SELECT COUNT(*) AS total_record, SUM(CASE WHEN item_sku = notice_sku THEN 1 ELSE 0 END) AS valid_record, SUM(CASE WHEN item_sku <> notice_sku THEN 1 ELSE 0 END) AS invalid_record FROM (${viewSelect}) v`, meta);
      if (q.includes(RECONCILED)) return duck.run(q.replace(RECONCILED, `(${viewSelect}) v`), meta);
      return duck.run(q, meta);
    } };
    const ctx = { sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen: async () => "", model: "none" } as unknown as AgentContext;
    ctx.map = await chart({ ...ctx, sql: duck } as unknown as AgentContext);
    const rows = (await duck.run("SELECT sku, lot_code FROM supplier_portal.ship_notices WHERE supplier_id = 'SUP007' AND upc <> '' LIMIT 5", { agent: "test", purpose: "pick rows" })).rows;
    const learned = await reconcile(ctx, "case-test", rows.map((r) => String(r.sku)), rows.map((r) => String(r.lot_code)));
    assert.deepEqual(learned.map((r) => r.supplier), ["SUP007"]);
    assert.ok(ddl.some((q) => /CREATE SCHEMASTORE VIEW ship_notice_item_keys WITH CONTAINER reconciled/.test(q)));
    const msgs = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "msg").map((e) => e.text as string);
    assert.ok(msgs.some((t) => new RegExp(`written back to Zetaris as ${RECONCILED.replace(".", "\\.")} and read back: SUP007 ${learned[0].rows}/${learned[0].rows}`).test(t)));
    assert.ok(msgs.some((t) => /Zetaris lineage of reconciled\.ship_notice_item_keys: SUPPLIER_PORTAL\.ship_notices \+ ERP\.skus/.test(t)));
    assert.ok(msgs.some((t) => /Zetaris data-quality rule barcode_names_the_notice_sku on lightning\.metastore\.recallwhy\.recall_keys\.notice_item: (\d+)\/\1 rows valid, 0 invalid/.test(t)), "blank barcodes do not match each other, so every match names the notice's own SKU");
  } finally {
    await duck.close();
  }
});

test("writing the corrected map back is idempotent: a second publish replaces the view and reads back the same rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-idem-"));
  const trace = new Trace({ dir, quiet: true, runId: "idem" });
  const duck = new DuckSampleRunner({ trace });
  await duck.ready;
  try {
    const views = new Map<string, string>(); let creates = 0;
    const sql = { engine: "zetaris", close: () => duck.close(), run: (q: string, meta: { agent: string; purpose: string }) => {
      if (/^\s*SHOW TABLES IN reconciled/i.test(q)) return Promise.resolve({ rows: [...views.keys()].map((v) => ({ name: v })), sqlId: "q-show", ms: 1 });
      if (/^\s*DROP VIEW IF EXISTS/i.test(q)) { if (q.includes(RECONCILED)) views.delete(RECONCILED); return Promise.resolve({ rows: [], sqlId: "q-drop", ms: 1 }); }
      if (/^\s*CREATE SCHEMASTORE VIEW supplier_rules/i.test(q)) return Promise.resolve({ rows: [], sqlId: "q-rules", ms: 1 });
      const m = q.match(/^\s*CREATE SCHEMASTORE VIEW[\s\S]*?\bAS\s+(SELECT[\s\S]+)$/i);
      if (m) { assert.ok(!views.has(RECONCILED), "the old view is dropped before it is recreated"); views.set(RECONCILED, m[1]); creates++; return Promise.resolve({ rows: [], sqlId: "q-create", ms: 1 }); }
      if (/^\s*CREATE SCHEMASTORE CONTAINER/i.test(q)) return Promise.resolve({ rows: [], sqlId: "q-c", ms: 1 });
      if (q.includes(RECONCILED)) return duck.run(q.replace(RECONCILED, `(${views.get(RECONCILED)}) v`), meta);
      return duck.run(q, meta);
    } };
    const ctx = { sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen: async () => "", model: "none" } as unknown as AgentContext;
    const map = await chart({ ...ctx, sql: duck } as unknown as AgentContext);
    const n = Number((await duck.run("SELECT COUNT(*) AS n FROM supplier_portal.ship_notices WHERE supplier_id = 'SUP007' AND upc <> ''", { agent: "test", purpose: "count" })).rows[0]?.n);
    const rule = { supplier: "SUP007", transform: "no-check-digit" as const, rows: n, learnedFrom: "case-test", sqlId: "q-test" };
    (map.joins.find((j) => j.left === "supplier_portal.ship_notices")!.rules ??= []).push(rule);
    const first = await publish(ctx, map, [rule]), second = await publish(ctx, map, [rule]);
    assert.equal(creates, 2);
    assert.deepEqual(first.readBack.map((p) => [p.supplier, p.read]), [["SUP007", n]]);
    assert.deepEqual(second.readBack.map((p) => [p.supplier, p.read]), first.readBack.map((p) => [p.supplier, p.read]));
  } finally {
    await duck.close();
  }
});

// Zetaris refusing a write must never stop a run: the map is still corrected for this run, and the trace says what failed.
async function reconcileWith(failOn: RegExp) {
  const dir = mkdtempSync(join(tmpdir(), "rw-fail-"));
  const trace = new Trace({ dir, quiet: true, runId: "fail" });
  const duck = new DuckSampleRunner({ trace });
  await duck.ready;
  let viewSelect = "";
  const sql = { engine: "zetaris", close: () => duck.close(), run: (q: string, meta: { agent: string; purpose: string }) => {
    if (failOn.test(q)) return Promise.reject(new Error("Zetaris query failed 400: refused for the test"));
    if (/^\s*(CREATE SCHEMASTORE|DROP VIEW)/i.test(q)) { const m = q.match(/VIEW ship_notice_item_keys[\s\S]*?\bAS\s+(SELECT[\s\S]+)$/i); if (m) viewSelect = m[1]; return Promise.resolve({ rows: [], sqlId: "q-ddl", ms: 1 }); }
    if (/^\s*(INFER|ACTIVATE)/i.test(q)) return Promise.resolve({ rows: [], sqlId: "q-x", ms: 1 });
    if (/^\s*RUN DQ/i.test(q)) return Promise.resolve({ rows: [{ type: "Foreign Key Constraint", total_record: "1", valid_record: "1", invalid_record: "0" }], sqlId: "q-dq", ms: 1 });
    if (q.includes(RECONCILED)) return duck.run(q.replace(RECONCILED, `(${viewSelect}) v`), meta);
    if (/reconciled\.supplier_rules/.test(q)) return Promise.reject(new Error("no such view"));
    return duck.run(q, meta);
  } };
  const ctx = { sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen: async () => "", model: "none" } as unknown as AgentContext;
  ctx.map = await chart({ ...ctx, sql: duck } as unknown as AgentContext);
  const rows = (await duck.run("SELECT sku, lot_code FROM supplier_portal.ship_notices WHERE supplier_id = 'SUP007' AND upc <> '' LIMIT 5", { agent: "test", purpose: "pick rows" })).rows;
  const learned = await reconcile(ctx, "case-test", rows.map((r) => String(r.sku)), rows.map((r) => String(r.lot_code)));
  const msgs = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "msg").map((e) => e.text as string);
  await duck.close();
  return { learned, msgs, map: ctx.map };
}

test("if Zetaris refuses the map write-back, the rule still corrects this run's map and the trace says the write failed", async () => {
  const { learned, msgs, map } = await reconcileWith(/^\s*CREATE SCHEMASTORE VIEW ship_notice_item_keys/i);
  assert.deepEqual(learned.map((r) => r.supplier), ["SUP007"]);
  assert.ok(map!.joins.some((j) => j.rules?.some((r) => r.supplier === "SUP007")));
  assert.ok(msgs.some((t) => /could not write the corrected map back to Zetaris \(Zetaris query failed 400: refused for the test/.test(t)));
});

test("if the USL re-bind fails, the write-back still counts and the trace says the key was not re-checked", async () => {
  const { learned, msgs } = await reconcileWith(/^\s*ACTIVATE USL TABLE lightning\.metastore\.recallwhy\.recall_exposure\.ship_notice/i);
  assert.equal(learned.length, 1);
  assert.ok(msgs.some((t) => /written back to Zetaris as reconciled\.ship_notice_item_keys and read back: SUP007/.test(t)));
  assert.ok(msgs.some((t) => /could not re-check the barcode key in the Zetaris USL \(Zetaris query failed 400/.test(t)));
});

test("with column names that say nothing, the Cartographer finds the barcode columns by content and the join test gives the same answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-opaque-"));
  const trace = new Trace({ dir, quiet: true, runId: "opaque" });
  const sql = new DuckSampleRunner({ trace });
  await sql.ready;
  try {
    const run = (q: string) => sql.run(q, { agent: "test", purpose: "setup" });
    await run("CREATE SCHEMA IF NOT EXISTS opaque");
    await run("CREATE OR REPLACE VIEW opaque.t1 AS SELECT asn_id AS c1, supplier_id AS c2, sku AS c3, upc AS c4, lot_code AS c5 FROM supplier_portal.ship_notices");
    await run("CREATE OR REPLACE VIEW opaque.t2 AS SELECT sku AS f1, title AS f2, upc AS f3, brand AS f4 FROM erp.skus");
    const cols = async (t: string) => (await run(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'opaque' AND table_name = '${t}' ORDER BY ordinal_position`)).rows.map((r) => ({ name: String(r.column_name), type: String(r.data_type).toLowerCase() }));
    const ctx = { sql, trace } as unknown as AgentContext;
    const a = await barcodeColumnsByContent(ctx, { name: "opaque.t1", kind: "jdbc", source: "opaque", columns: await cols("t1") });
    const b = await barcodeColumnsByContent(ctx, { name: "opaque.t2", kind: "jdbc", source: "opaque", columns: await cols("t2") });
    assert.deepEqual(a.map((x) => x.column), ["c4"]);
    assert.deepEqual(b.map((x) => x.column), ["f3"]);
    const opaque = await joinTest(ctx, "opaque.t1", "c4", "opaque.t2", "f3");
    const named = await joinTest(ctx, "supplier_portal.ship_notices", "upc", "erp.skus", "upc");
    assert.equal(Number(opaque.norm.rows[0].n), Number(named.norm.rows[0].n));
    assert.equal(Number(opaque.norm.rows[0].n), 11512);
    assert.equal(Number(opaque.raw.rows[0].n), 6810);
  } finally {
    await sql.close();
  }
});
