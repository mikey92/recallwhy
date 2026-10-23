import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { Trace } from "../src/trace.ts";
import { sqlId } from "../src/sql/types.ts";
import { coerceNumericFields } from "../src/sql/zetaris.ts";
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
