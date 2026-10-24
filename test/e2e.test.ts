import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, inQueue, reviewQueue, runOnce } from "../src/app.ts";
import { Trace } from "../src/trace.ts";

test("sample mode end to end: a case goes to review, a reviewer decides, the next run follows and the queue empties", async () => {
  // Every state, log and output path is relative to the working directory; run in a fresh one.
  const cwd = process.cwd();
  process.chdir(mkdtempSync(join(tmpdir(), "rw-e2e-")));
  try {
    const env = { SAMPLE_MODE: "true", LLM_PROVIDER: "none" };
    const opts = { since: "2026-07-01", only: ["H-1407-2026"] };

    const r1 = await runOnce(env, opts, new Trace({ quiet: true }));
    assert.equal(r1.engine, "duckdb-sample");
    assert.deepEqual(r1.cases.map((c) => c.verdict), ["needs-human"], "without a model the text match is left to a person");
    assert.equal(reviewQueue().length, 1);
    assert.ok(inQueue("H-1407-2026", "NW-100005"));
    assert.equal(inQueue("H-1407-2026", "NW-999999"), false, "decisions are only taken for pairs in the queue");

    decide("H-1407-2026", "NW-100005", "same", "the 1/4 lb bag");
    const r2 = await runOnce(env, opts, new Trace({ quiet: true }));
    assert.notEqual(r2.cases[0].verdict, "needs-human");
    assert.match(r2.briefs[r2.cases[0].id], /a reviewer decided it is this product: the 1\/4 lb bag/);
    assert.equal(reviewQueue().length, 0, "a settled case leaves the queue");
  } finally {
    process.chdir(cwd);
  }
});
