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

test("the weekly digest reads every case through Markovian in bounded chunks, and drops model lines that state numbers no case has", async () => {
  const { digest } = await import("../src/digest.ts");
  const dir = mkdtempSync(join(tmpdir(), "rw-digest-"));
  const trace = new Trace({ dir, quiet: true, runId: "digest" });
  const cases = Array.from({ length: 40 }, (_, i) => ({ id: `case-${i}`, recall: `fda:H-${i}`, firm: `Firm ${i}`, product: "Product", verdict: i % 3 ? "needs-human" : "act-now", onHand: i % 3 ? 0 : 10 + i, stores: i % 3 ? 0 : 2, sold: 0, customers: i % 3 ? 0 : 3 }));
  const calls: string[] = [];
  const honest = { trace, model: "test:model", gen: async (p: string) => { calls.push(p); const ids = [...p.matchAll(/^(case-\d+) \| (Firm \d+)/gm)]; return ids.map((m) => `- ${m[2]}: check it [${m[1]}]`).join("\n") + (/last batch/.test(p) ? "\n[TASK_COMPLETE]" : "\n[STATE_CHECKPOINT]\nCOMPLETED: batch read, most urgent noted\nREMAINING: more\nDECISIONS: none\nCONTEXT: x"); } } as unknown as AgentContext;
  const d = await digest(honest, { runId: "digest", scanned: 99 }, cases, dir);
  assert.equal(d.by, "model");
  assert.ok(d.chunks >= 6, "40 cases in batches of 6");
  assert.ok(calls.every((p) => p.length < 4000), "every chunk's prompt stays bounded");
  assert.ok(calls.slice(1).every((p) => p.includes("[CARRYOVER STATE]")), "later chunks get the carried state, not the earlier cases");
  const liar = { ...honest, gen: async (p: string) => `- Firm 0: pull 99999 units\n${/last batch/.test(p) ? "[TASK_COMPLETE]" : "[STATE_CHECKPOINT]\nCOMPLETED: read a batch of cases"}` } as unknown as AgentContext;
  const d2 = await digest(liar, { runId: "digest", scanned: 99 }, cases, dir);
  assert.equal(d2.by, "template");
  assert.match(d2.rejected ?? "", /99999/);
});

test("approving a packet needs a name, records a signed high-risk contract that verifies later, and sends nothing", async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { signatureValid } = await import("../src/contract.ts");
  const run = `test-approve-${process.pid}`, dir = `out/${run}/actions/case-x`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/packet.json`, JSON.stringify({ caseId: "case-x", status: "draft", files: ["pull-list.csv"], pullUnits: 5, stores: 1 }));
  try {
    assert.deepEqual(approvePacket(run, "case-x", "  "), { ok: false, reason: "an approval needs the approver's name" });
    const r = approvePacket(run, "case-x", "Dana, safety manager", "checked the lots");
    assert.equal(r.ok, true);
    const a = JSON.parse(readFileSync(r.file!, "utf8"));
    assert.equal(a.sent, false);
    assert.equal(a.contract.risk.level, "high");
    assert.deepEqual(a.contract.risk.approvals.map((x: { by: string }) => x.by), ["Dana, safety manager"]);
    assert.equal(signatureValid(a.contract), true, "the recorded contract verifies again from the file");
    assert.equal(signatureValid({ ...a.contract, intent: { ...a.contract.intent, parameters: { pullUnits: 500 } } }), false);
  } finally { rmSync(`out/${run}`, { recursive: true, force: true }); }
});
