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
    const opts = { since: "2026-07-01", only: ["H-0021-2027"] };

    const r1 = await runOnce(env, opts, new Trace({ quiet: true }));
    assert.equal(r1.engine, "duckdb-sample");
    assert.deepEqual(r1.cases.map((c) => c.verdict), ["needs-human"], "without a model the text match is left to a person");
    assert.equal(reviewQueue().length, 1);
    assert.ok(inQueue("H-0021-2027", "NW-100117"));
    assert.equal(inQueue("H-0021-2027", "NW-999999"), false, "decisions are only taken for pairs in the queue");

    decide("H-0021-2027", "NW-100117", "not-this", "ours is cheese; the notice is pepperoni");
    const r2 = await runOnce(env, opts, new Trace({ quiet: true }));
    assert.equal(r2.cases[0].verdict, "not-ours");
    assert.match(r2.briefs[r2.cases[0].id], /a reviewer decided it is not this product: ours is cheese/);
    assert.equal(reviewQueue().length, 0, "a settled case leaves the queue");
  } finally {
    process.chdir(cwd);
  }
});
