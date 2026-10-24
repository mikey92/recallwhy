import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Trace } from "../src/trace.ts";
import { sqlId } from "../src/sql/types.ts";
import { coerceNumericFields, ZetarisRunner } from "../src/sql/zetaris.ts";
import { toDuckDialect, DuckSampleRunner } from "../src/sql/duck.ts";
import { makeRunner } from "../src/sql/index.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("sqlId", () => {
  it("is stable for the same normalised SQL", () => {
    const a = sqlId("SELECT  1");
    const b = sqlId("SELECT 1");
    assert.equal(a, b);
    assert.match(a, /^q-[0-9a-f]{10}$/);
  });

  it("matches sha256 of normalised SQL", () => {
    const sql = "SELECT sku FROM erp.skus";
    const normalised = sql.trim().replace(/\s+/g, " ");
    const hex = createHash("sha256").update(normalised).digest("hex").slice(0, 10);
    assert.equal(sqlId(sql), `q-${hex}`);
  });

  it("differs for different SQL", () => {
    assert.notEqual(sqlId("SELECT 1"), sqlId("SELECT 2"));
  });
});

describe("coerceNumericFields", () => {
  it("converts numeric-looking strings in count/units columns", () => {
    const row = coerceNumericFields({
      on_hand: "42",
      units: "7",
      loyalty_customers: "3",
      sold_units: "10",
      n: "5",
      title: "guac",
    });
    assert.equal(row.on_hand, 42);
    assert.equal(row.units, 7);
    assert.equal(row.loyalty_customers, 3);
    assert.equal(row.sold_units, 10);
    assert.equal(row.n, 5);
    assert.equal(row.title, "guac");
  });

  it("keeps identifiers that are all digits as strings (UPCs, yyyymmdd dates)", () => {
    const row = coerceNumericFields({ sku_count: "9", upc: "012345678905", report_date: "20260923", title: "42" });
    assert.equal(row.sku_count, 9);
    assert.equal(row.upc, "012345678905");
    assert.equal(row.report_date, "20260923");
    assert.equal(row.title, "42");
  });

  it("leaves non-numeric strings alone", () => {
    const row = coerceNumericFields({ units: "n/a", on_hand: "" });
    assert.equal(row.units, "n/a");
    assert.equal(row.on_hand, "");
  });
});

describe("toDuckDialect", () => {
  it("adds g option to 3-arg regexp_replace", () => {
    assert.equal(
      toDuckDialect("regexp_replace(code_info, '[^0-9]', '')"),
      "regexp_replace(code_info, '[^0-9]', '', 'g')",
    );
  });

  it("leaves 4-arg regexp_replace alone", () => {
    assert.equal(
      toDuckDialect("regexp_replace(a, b, c, 'g')"),
      "regexp_replace(a, b, c, 'g')",
    );
  });

  it("maps infix rlike to regexp_matches", () => {
    assert.equal(
      toDuckDialect("WHERE code_info rlike '[0-9]+'"),
      "WHERE regexp_matches(code_info, '[0-9]+')",
    );
  });

  it("maps simple infix rlike", () => {
    assert.equal(toDuckDialect("a rlike b"), "regexp_matches(a, b)");
  });
});

describe("DuckSampleRunner smoke", () => {
  it("loads synthetic CSVs and sample feeds, joins across schemas", async () => {
    const trace = new Trace({ quiet: true, dir: mkdtempSync(`${tmpdir()}/rw-duck-`) });
    const runner = new DuckSampleRunner({ trace });
    await runner.ready;

    const skus = await runner.run("SELECT COUNT(*) AS n FROM erp.skus", {
      agent: "test",
      purpose: "sku-count",
    });
    assert.ok(Number(skus.rows[0]!.n) > 0);
    assert.equal(skus.engine, "duckdb-sample");
    assert.match(skus.sqlId, /^q-[0-9a-f]{10}$/);

    const fda = await runner.run("SELECT COUNT(*) AS n FROM recallfeeds.fda_food", {
      agent: "test",
      purpose: "fda-count",
    });
    assert.equal(Number(fda.rows[0]!.n), 333);

    const join = await runner.run(
      `SELECT COUNT(*) AS n
       FROM erp.inventory i
       JOIN supplier_portal.ship_notices s
         ON i.sku = s.sku AND i.lot_code = s.lot_code`,
      { agent: "test", purpose: "federated-join" },
    );
    assert.ok(Number(join.rows[0]!.n) > 0);

    await runner.close();
  });
});

describe("makeRunner", () => {
  it("falls back to sample mode when Zetaris does not answer, and says so in the trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rw-fallback-"));
    const trace = new Trace({ dir, quiet: true, runId: "fallback-test" });
    const env = { ZETARIS_BASE_URL: "http://127.0.0.1:9", ZETARIS_USERNAME: "u", ZETARIS_PASSWORD: "p" };
    const runner = await makeRunner(env, trace);
    assert.equal(runner.engine, "duckdb-sample");
    await runner.close();
    const kinds = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
    assert.deepEqual(kinds.slice(0, 2), ["sql.error", "note"]);
    await assert.rejects(makeRunner({ ...env, ZETARIS_FALLBACK: "false" }, trace));
  });
});

describe("ZetarisRunner", () => {
  it("logs in, sends each query with a fresh request id, re-logs in on 401, and traces failures", async () => {
    const trace = new Trace({ quiet: true, dir: mkdtempSync(`${tmpdir()}/rw-zrun-`) });
    const calls: { url: string; headers: Record<string, string>; body: { sql?: string; limit?: number } }[] = [];
    let logins = 0, queries = 0;
    // Shaped like the local Zetaris instance's answers to /api/auth/login and run-query.
    const fetchFn = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/api/auth/login")) return json(200, { idToken: `token-${++logins}`, orgId: "org-7" });
      queries++;
      if (queries === 2) return json(401, { msg: "expired" });
      if (queries === 4) return json(400, { msg: "Table or view not found: erp.nope" });
      return json(200, { headers: ["sku", "on_hand"], data: [["NW-100005", "12"]], total: 1, timeUsed: 9 });
    }) as unknown as typeof fetch;
    const z = new ZetarisRunner({ baseUrl: "http://zetaris:3000/", username: "u", password: "p", trace, fetchFn });

    const r = await z.run("SELECT sku, on_hand FROM erp.inventory", { agent: "Investigator", purpose: "test" });
    assert.deepEqual(r.rows, [{ sku: "NW-100005", on_hand: 12 }], "numeric columns are coerced, ids stay strings");
    const q1 = calls.find((c) => c.url.endsWith("run-query"))!;
    assert.equal(q1.url, "http://zetaris:3000/api/proxy/sql-editor/sqls/run-query");
    assert.equal(q1.headers.Authorization, "Bearer token-1");
    assert.equal(q1.headers["X-Org-ID"], "org-7", "the org id from the login answer is used");

    await z.run("SELECT 1 AS n", { agent: "Investigator", purpose: "after expiry" });
    assert.equal(logins, 2, "a 401 triggers one new login");
    assert.equal(calls.at(-1)!.headers.Authorization, "Bearer token-2");
    const ids = calls.filter((c) => c.url.endsWith("run-query")).map((c) => c.headers["X-Request-ID"]);
    assert.equal(new Set(ids).size, ids.length, "every request has its own X-Request-ID");

    await assert.rejects(z.run("SELECT * FROM erp.nope", { agent: "Auditor", purpose: "bad table" }), /Table or view not found/);
    const last = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    assert.equal(last.kind, "sql.error");
    assert.equal(last.agent, "Auditor");
  });
});
