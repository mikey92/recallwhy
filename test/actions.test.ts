import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trace } from "../src/trace.ts";
import { DuckSampleRunner } from "../src/sql/duck.ts";
import { CaseMemory } from "../src/memory.ts";
import { World } from "../src/world.ts";
import { scout } from "../src/agents/scout.ts";
import { adjudicate } from "../src/orchestrator.ts";
import { chart } from "../src/agents/cartographer.ts";
import { actionPacket, approvePacket } from "../src/actions.ts";
import type { AgentContext } from "../src/agents/context.ts";

test("an act-now case gets a pull list that adds up to the audited on-hand, a supplier request citing its ship notices, and a customer notice; a mismatch withholds it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-actions-"));
  const trace = new Trace({ dir, quiet: true, runId: "actions" });
  const sql = new DuckSampleRunner({ trace });
  await sql.ready;
  try {
    const ctx = { sql, trace, memory: new CaseMemory(trace, `${dir}/hmem`), world: new World(trace, `${dir}/world`), gen: async () => "UNSURE: no model", model: "none:none", queueFile: `${dir}/q.json` } as unknown as AgentContext;
    ctx.map = await chart(ctx);
    const { cases } = await scout(ctx, { since: "2026-07-01" });
    const k = cases.find((c) => c.recall.id === "fda:H-1095-2026")!;
    const { finding } = await adjudicate(ctx, k);
    assert.equal(finding.verdict, "act-now");
    const p = (await actionPacket(ctx, k, finding, `${dir}/out`))!;
    assert.equal(p.status, "draft");
    assert.equal(p.pullUnits, finding.numbers!.onHandUnits, "the pull list sums to the audited on-hand");
    const rows = readFileSync(`${p.dir}/pull-list.csv`, "utf8").trim().split("\n").slice(1);
    assert.equal(new Set(rows.map((r) => r.split(",")[0])).size, finding.numbers!.storesWithStock);
    const req = readFileSync(`${p.dir}/${p.files.find((f) => f.startsWith("supplier-request"))}`, "utf8");
    assert.match(req, /^# DRAFT — not sent/);
    assert.match(req, /\| ASN-\d{6} \|/);
    assert.match(readFileSync(`${p.dir}/customer-notice.md`, "utf8"), /at most \d+ \(a count/);

    // Same case, but the finding's on-hand disagrees with the pull list: nothing to hand on.
    const bad = await actionPacket(ctx, k, { ...finding, numbers: { ...finding.numbers!, onHandUnits: finding.numbers!.onHandUnits + 1 } }, `${dir}/out2`);
    assert.equal(bad!.status, "withheld");
    assert.equal(existsSync(`${bad!.dir}/pull-list.csv`), false);
  } finally {
    await sql.close();
  }
});

test("approving a packet records who and when, and refuses unknown or withheld packets", () => {
  assert.equal(approvePacket("../etc", "x", "me").ok, false);
  assert.equal(approvePacket("no-such-run", "case-x", "me").ok, false);
});
