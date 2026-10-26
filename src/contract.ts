// Execution contracts, as Meterless Scout Intent specifies them (engines/scout-intent/docs/execution-contract.md):
// a write that changes shared state runs only with a contract that names it. The contract carries the
// intent and its evidence, the exact capabilities it allows, its risk and approvals, is signed with
// HMAC-SHA256 over its canonical JSON, expires after 5 minutes, and each capability can be used once.
// Every issue, verification and refusal is a trace event (contract.issued / verified / refused / expired).
// Used for the Cartographer's write-back of the corrected map, the Orchestrator's write-back of verdicts
// (both to Zetaris), and a person's approval of an action packet.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Trace } from "./trace.ts";

export interface Approval { kind: "operator-review"; by: string; at: string; decision: "approve" }
export interface ExecutionContract {
  contractId: string;
  traceId: string;
  intent: { primary: string; parameters: Record<string, unknown>; confidence: number };
  risk: { level: "low" | "medium" | "high"; flags: string[]; approvals: Approval[] };
  toolPlan: string[];
  scope: { surface: string; capabilities: string[] };
  issuedAt: string;
  expiresAt: string;
  signedBy: "scout";
  signature: string;
}
export class ContractRefused extends Error {
  constructor(readonly reason: "signature" | "expired" | "scope" | "used" | "approval-missing", detail: string) { super(`contract refused (${reason}): ${detail}`); }
}

const TTL_MS = 5 * 60 * 1000;
// Per-deployment secret: RECALLWHY_CONTRACT_SECRET when set, else one per process (contracts never leave it).
const SECRET = process.env.RECALLWHY_CONTRACT_SECRET || randomBytes(32).toString("hex");
const used = new Set<string>();

/** Canonical JSON: object keys sorted at every level, no whitespace. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
const sign = (c: Omit<ExecutionContract, "signature">, secret = SECRET) => createHmac("sha256", secret).update(canonical(c)).digest("hex");

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A ULID: 48-bit time and 80 random bits, Crockford base32, sortable by issue time. */
export function ulid(now = Date.now()): string {
  let t = now, time = "";
  for (let i = 0; i < 10; i++) { time = B32[t % 32] + time; t = Math.floor(t / 32); }
  const rnd = randomBytes(16);
  let r = "";
  for (let i = 0; i < 16; i++) r += B32[rnd[i] % 32];
  return time + r;
}

export function issueContract(trace: Trace, o: { intent: string; parameters: Record<string, unknown>; capabilities: string[]; toolPlan?: string[]; risk?: ExecutionContract["risk"]["level"]; flags?: string[]; approvals?: Approval[]; surface?: string; now?: number }): ExecutionContract {
  const now = o.now ?? Date.now();
  const body: Omit<ExecutionContract, "signature"> = {
    contractId: ulid(now), traceId: trace.runId,
    intent: { primary: o.intent, parameters: o.parameters, confidence: 1 },
    risk: { level: o.risk ?? "medium", flags: o.flags ?? [], approvals: o.approvals ?? [] },
    toolPlan: o.toolPlan ?? o.capabilities, scope: { surface: o.surface ?? "agent", capabilities: o.capabilities },
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL_MS).toISOString(), signedBy: "scout",
  };
  const c = { ...body, signature: sign(body) };
  trace.emit("contract", "Scout", { event: "contract.issued", contractId: c.contractId, intent: o.intent, risk: c.risk.level, capabilities: o.capabilities, expiresAt: c.expiresAt });
  return c;
}

/** Verify a contract at the boundary of the write it allows; a capability can be used once. Throws ContractRefused. */
export function verifyContract(trace: Trace, c: ExecutionContract, capability: string, engine: string, now = Date.now()): void {
  const refuse = (reason: ContractRefused["reason"], detail: string): never => {
    trace.emit("contract", engine, { event: reason === "expired" ? "contract.expired" : "contract.refused", contractId: c.contractId, capability, reason, detail });
    throw new ContractRefused(reason, detail);
  };
  const { signature, ...body } = c;
  const want = Buffer.from(sign(body), "hex"), got = Buffer.from(String(signature), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) refuse("signature", "signature does not match the contract");
  if (now > Date.parse(c.expiresAt)) refuse("expired", `expired at ${c.expiresAt}`);
  if (!c.scope.capabilities.includes(capability)) refuse("scope", `${capability} is not in the contract's capabilities`);
  if (c.risk.level === "high" && !c.risk.approvals.some((a) => a.kind === "operator-review" && a.decision === "approve" && a.by)) refuse("approval-missing", "a high-risk contract needs an operator's approval");
  const key = `${c.contractId} ${capability}`;
  if (used.has(key)) refuse("used", `${capability} was already used under this contract`);
  used.add(key);
  trace.emit("contract", engine, { event: "contract.verified", contractId: c.contractId, capability });
}

/** Test hook: sign with an explicit secret (to show a contract from another signer is refused). */
export const _signWith = (c: Omit<ExecutionContract, "signature">, secret: string) => sign(c, secret);
