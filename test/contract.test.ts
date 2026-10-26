import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Trace } from "../src/trace.ts";
import { canonical, issueContract, verifyContract, ulid, ContractRefused, _signWith } from "../src/contract.ts";

const newTrace = () => { const dir = mkdtempSync(join(tmpdir(), "rw-contract-")); return { dir, trace: new Trace({ dir, quiet: true, runId: "contract-run" }) }; };
const refusal = (fn: () => void) => { try { fn(); } catch (e) { return e instanceof ContractRefused ? e.reason : "other"; } return "none"; };

test("canonical JSON sorts keys at every level, and ULIDs sort by time", () => {
  assert.equal(canonical({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: "x" } }), '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}');
  assert.ok(ulid(1000) < ulid(2000));
  assert.match(ulid(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
});

test("a contract allows exactly its capabilities, once each, until it expires; tampering or another signer is refused", () => {
  const { trace } = newTrace();
  const c = issueContract(trace, { intent: "write-back.corrected-barcode-map", parameters: { supplier: "SUP028" }, capabilities: ["zetaris.view.replace:reconciled.x", "zetaris.usl.activate:t"], now: Date.now() });
  assert.equal(refusal(() => verifyContract(trace, c, "zetaris.view.replace:reconciled.x", "Cartographer")), "none");
  assert.equal(refusal(() => verifyContract(trace, c, "zetaris.view.replace:reconciled.x", "Cartographer")), "used");
  assert.equal(refusal(() => verifyContract(trace, c, "zetaris.view.replace:reconciled.other", "Cartographer")), "scope");
  assert.equal(refusal(() => verifyContract(trace, { ...c, intent: { ...c.intent, parameters: { supplier: "SUP001" } } }, "zetaris.usl.activate:t", "Cartographer")), "signature");
  const { signature: _, ...body } = c;
  assert.equal(refusal(() => verifyContract(trace, { ...c, signature: _signWith(body, "another-deployment") }, "zetaris.usl.activate:t", "Cartographer")), "signature");
  assert.equal(refusal(() => verifyContract(trace, c, "zetaris.usl.activate:t", "Cartographer", Date.parse(c.expiresAt) + 1)), "expired");
  assert.equal(refusal(() => verifyContract(trace, c, "zetaris.usl.activate:t", "Cartographer")), "none");
});

test("a high-risk contract needs an operator's approval, and every step is a trace event", () => {
  const { dir, trace } = newTrace();
  const bare = issueContract(trace, { intent: "packet.approve", parameters: {}, capabilities: ["packet.approve:r/c"], risk: "high" });
  assert.equal(refusal(() => verifyContract(trace, bare, "packet.approve:r/c", "Human")), "approval-missing");
  const ok = issueContract(trace, { intent: "packet.approve", parameters: {}, capabilities: ["packet.approve:r/c"], risk: "high", approvals: [{ kind: "operator-review", by: "Dana", at: new Date().toISOString(), decision: "approve" }] });
  assert.equal(refusal(() => verifyContract(trace, ok, "packet.approve:r/c", "Human")), "none");
  const events = readFileSync(join(dir, "trace-contract-run.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "contract").map((e) => e.event);
  assert.deepEqual(events, ["contract.issued", "contract.refused", "contract.issued", "contract.verified"]);
});
