// One JSONL trace per run: logs/trace-<runId>.jsonl, mirrored to stdout.
// Every agent message, SQL call, model call and memory/world access goes
// through here, so the trace is exactly what the code did.
import { mkdirSync, appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export type TraceKind =
  | "run.start" | "run.end" | "msg" | "sql" | "sql.error" | "llm" | "memory.read" | "memory.write"
  | "world.write" | "world.context" | "verdict" | "critique" | "escalate" | "brief" | "note";

export interface TraceEvent { t: string; run: string; seq: number; kind: TraceKind; agent: string; [k: string]: unknown }

export class Trace {
  readonly runId: string;
  readonly file: string;
  private seq = 0;
  private quiet: boolean;
  constructor(opts: { dir?: string; quiet?: boolean; runId?: string } = {}) {
    this.runId = opts.runId ?? `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${randomUUID().slice(0, 6)}`;
    const dir = opts.dir ?? "logs";
    mkdirSync(dir, { recursive: true });
    this.file = `${dir}/trace-${this.runId}.jsonl`;
    this.quiet = opts.quiet ?? false;
  }
  emit(kind: TraceKind, agent: string, data: Record<string, unknown> = {}): TraceEvent {
    const ev: TraceEvent = { t: new Date().toISOString(), run: this.runId, seq: ++this.seq, kind, agent, ...redact(data) };
    appendFileSync(this.file, JSON.stringify(ev) + "\n");
    if (!this.quiet) console.log(pretty(ev));
    return ev;
  }
}

const C = { dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m" };
const COLORS: Record<string, string> = { Cartographer: "\x1b[96m", Scout: "\x1b[36m", Investigator: "\x1b[33m", Auditor: "\x1b[35m", Briefer: "\x1b[32m", Orchestrator: "\x1b[34m", Human: "\x1b[31m" };

function pretty(ev: TraceEvent): string {
  const who = `${COLORS[ev.agent] ?? ""}${ev.agent.padEnd(12)}${C.reset}`;
  const k = ev.kind.padEnd(12);
  let body = "";
  if (ev.kind === "msg") body = `→ ${ev.to}: ${ev.text}`;
  else if (ev.kind === "sql") body = `[${ev.engine}] ${ev.sqlId} ${ev.purpose} (${ev.rows} rows, ${ev.ms}ms)`;
  else if (ev.kind === "llm") body = `${ev.served_model ? `${ev.model} ⇒ ${ev.served_model}` : ev.model} ${ev.purpose} → ${String(ev.output).replace(/\s+/g, " ").slice(0, 100)}`;
  else body = String(ev.text ?? ev.summary ?? JSON.stringify(Object.fromEntries(Object.entries(ev).filter(([x]) => !["t", "run", "seq", "kind", "agent"].includes(x))))).slice(0, 160);
  return `${C.dim}${String(ev.seq).padStart(4)}${C.reset} ${who} ${C.dim}${k}${C.reset} ${body}`;
}

/** Traces are meant to be shared: never let a password or key reach one. */
export function redact<T>(v: T): T {
  if (typeof v === "string") return v.replace(/\b(password|api[_-]?key|token|secret)(\s*[:=]?\s*)(["'])[^"']*\3/gi, "$1$2$3***$3") as T;
  if (Array.isArray(v)) return v.map(redact) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /password|api[_-]?key|secret|token/i.test(k) ? "***" : redact(x)])) as T;
  return v;
}
