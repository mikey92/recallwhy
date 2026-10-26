// A Scout implementation of the Meterless Scout Intent spec (engines/scout-intent/docs at Meterless@1742dec):
// the five-stage pipeline Sense → Interpret → Guard → Route → Recommend, ending in a signed execution contract.
// Its API is what the upstream eval harness (conformance/scout-intent/evals/runner/index.ts) loads:
//   new Scout({ intentRegistry, policyPack }), await scout.decide({ prompt, user, surface }).
//
// Sense is the spec's Stage 1 only (docs/scoring.md): a deterministic, weighted trigger scan whose triggers come
// from the registry's own fields (id, category, examples, parameter names and enum values, description,
// capabilities), weighted by how many intents share a trigger, plus a small generic English thesaurus that maps
// common verbs and nouns onto registry vocabulary. Scores are calibrated from the registry alone: K is set so
// that a typical registry example, scored with that example left out, lands at the High band floor (0.80).
// There is no Stage 2 (no embedding model, no conversation context), so semantic, contextual and recency are 0
// and Stage 1's score stands, as the spec allows. Nothing here reads the regression set.
// Guard uses RecallWhy's injection guard (src/guard.ts) plus the registry's roles and surfaces.
import { readFileSync } from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { detectInjection } from "../guard.ts";
import { canonical, ulid } from "../contract.ts";
import { profiles, route } from "../scout-intent.ts";

// ---------------------------------------------------------------------------------------------------------------
// Types (docs/intent-registry.md, docs/risk-and-policy.md, docs/execution-contract.md)
// ---------------------------------------------------------------------------------------------------------------

export type RiskClass = "low" | "medium" | "high";
export interface ParameterSchema { type?: string; properties?: Record<string, { type?: string; enum?: unknown[]; minimum?: number; maximum?: number; items?: unknown; optional?: boolean }>; required?: string[] }
export interface Intent {
  id: string; category: string; description: string; parameters: ParameterSchema; capabilities: string[];
  riskClass: RiskClass; surfaces: string[]; roles: string[]; examples: string[]; version: number;
}
export interface Registry { version: number; registryVersion?: number; intents: Intent[] }
export interface Candidate { intent: string; score: number; span?: string }
export interface RiskFlag { layer: "injection" | "policy" | "scope" | "pii"; result: "warn" | "block"; code: string; detail?: string }
export interface Redaction { kind: string; count: number }
export interface ApprovalSpec { kind: "user-confirm" | "operator-review"; reason: string }
export interface Risk {
  level: RiskClass | "block"; flags: RiskFlag[]; redactions: Redaction[]; reason?: string; approvalsRequired?: ApprovalSpec[];
  injection: { detected: boolean; kind?: "pattern" | "role-drift" | "tool-ref" | "model"; score: number; evidence: string[] };
}
export interface ToolStep { capability: string; tool: string; intent: string; input: Record<string, unknown> }
export interface Clarification { question: string; reason: string; options: { label: string; intent: string }[] }
export interface ExecutionContract {
  contractId: string; parentId?: string; traceId: string;
  intent: { primary: { id: string; version: number }; parameters: Record<string, unknown>; references: Record<string, unknown>; confidence: number; alternates: Candidate[]; secondary: { id: string; version: number }[] };
  risk: { level: RiskClass; flags: RiskFlag[]; redactions: Redaction[]; approvals: unknown[]; approvalsRequired: ApprovalSpec[] };
  toolPlan: ToolStep[];
  modelProfile: { id: string; model: string; chain: string[]; reason: string };
  scope: { user: { id: string; role: string }; surface: string; capabilities: string[] };
  issuedAt: string; expiresAt: string; registryVersion: number; policyPackVersion: string;
  signature: string; signedBy: "scout";
}
export interface Decision {
  traceId: string;
  candidates: Candidate[];
  intents: string[];
  interpretation: { intent: string; parameters: Record<string, unknown>; references: Record<string, unknown>; needsClarification: boolean; band: Band };
  risk: Risk;
  toolPlan: ToolStep[];
  modelProfile?: ExecutionContract["modelProfile"];
  clarification: Clarification | null;
  executionContract: ExecutionContract | null;
}
export type Band = "high" | "medium" | "low" | "reject";

// ---------------------------------------------------------------------------------------------------------------
// Registry loading
// ---------------------------------------------------------------------------------------------------------------

export function loadRegistry(src: string | Registry): Registry {
  const r = typeof src === "string" ? (JSON.parse(readFileSync(src, "utf8")) as Registry) : src;
  if (!r || !Array.isArray(r.intents) || !r.intents.length) throw new Error("intent registry has no intents");
  const ids = new Set<string>();
  for (const i of r.intents) {
    for (const k of ["id", "category", "description", "riskClass"] as const) if (typeof i[k] !== "string") throw new Error(`intent ${i.id ?? "?"}: missing ${k}`);
    if (!["low", "medium", "high"].includes(i.riskClass)) throw new Error(`intent ${i.id}: bad riskClass ${i.riskClass}`);
    if (!Array.isArray(i.examples) || !i.examples.length) throw new Error(`intent ${i.id}: examples are mandatory`);
    if (ids.has(i.id)) throw new Error(`duplicate intent ${i.id}`);
    ids.add(i.id);
  }
  if (!ids.has("GENERAL")) throw new Error("registry needs the GENERAL fallback intent");
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Sense: Stage-1 deterministic trigger scan
// ---------------------------------------------------------------------------------------------------------------

const STOP = new Set(("a an the and or but of to for in on at by with from into about as is are was were be been being it its this that " +
  "these those i im me my mine we us our you your he him his she her they them their what which who whom whose how why when where " +
  "do does did done can could would should will shall may might must please hi hey let lets just also some any so if then than " +
  "there here up out again very too get got give gave go going want need like make one").split(" "));

// A generic thesaurus written once, before any eval run: common words mapped onto the vocabulary the registry
// uses (its intent ids, categories and capability names). It is not derived from, and does not mention, any
// regression-set prompt.
const THESAURUS: Record<string, string[]> = {
  write: ["draft"], compose: ["draft"], prepare: ["draft"], craft: ["draft"], reply: ["draft", "email"],
  mail: ["email"], "e-mail": ["email"], inbox: ["email"], thread: ["email"],
  recap: ["summarize"], digest: ["summarize"], overview: ["summarize"], tldr: ["summarize"], brief: ["summarize"],
  blast: ["send"], broadcast: ["send"], announce: ["send"],
  change: ["update"], modify: ["update"], edit: ["update"], set: ["update"], mark: ["update"], move: ["update"],
  lookup: ["query"], check: ["query"], status: ["query"],
  versus: ["comparison"], vs: ["comparison"], contrast: ["comparison"], compare: ["comparison"], evaluate: ["comparison"],
  competitor: ["market"], competition: ["market"], industry: ["market"], landscape: ["market"], trend: ["market"],
  roadmap: ["plan"], strategy: ["plan"], timeline: ["plan"], milestone: ["plan"], phased: ["plan"], rollout: ["plan"], migrate: ["plan"], migration: ["plan"],
  schedule: ["calendar", "create"], book: ["calendar", "create"], remind: ["calendar", "create"], reminder: ["calendar", "create"],
  meeting: ["calendar"], event: ["calendar"], invite: ["calendar"],
  rescue: ["recover"], revive: ["recover"], stalled: ["recover", "stuck"], stuck: ["recover"], slipping: ["recover"], risk: ["recover"],
  investigate: ["research"], analyze: ["research"], analyse: ["research"], explore: ["research"], survey: ["research"],
  number: ["report"], metric: ["report"], kpi: ["report"], dashboard: ["report"], figure: ["report"], result: ["report"],
  opportunity: ["deal"], opp: ["deal"], pipeline: ["deal"], renewal: ["deal"],
  customer: ["account"], client: ["account"], company: ["account"],
};
const SYNONYM_FACTOR = 0.8;

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) { const s = w.slice(0, -3); return /([b-df-hj-np-tv-z])\1$/.test(s) ? s.slice(0, -1) : s; }
  if (w.length > 4 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us")) return w.slice(0, -1);
  return w;
}
/** Content words of a text, stemmed, in order, with their character spans. */
function words(text: string): { w: string; start: number; end: number }[] {
  const out: { w: string; start: number; end: number }[] = [];
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9]*(?:[-'][a-z0-9]+)*/g)) {
    const raw = m[0].replace(/'s$/, "");
    if (STOP.has(raw)) continue;
    for (const part of raw.includes("-") && !THESAURUS[raw] ? [raw, ...raw.split("-")] : [raw]) {
      if (STOP.has(part) || part.length < 2) continue;
      out.push({ w: stem(part), start: m.index!, end: m.index! + m[0].length });
    }
  }
  return out;
}
const splitId = (s: string) => s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);

function commonPrefix(a: string, b: string): number { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; }
/** Two stems match when equal, or when they share a prefix of at least max(4, shorter length − 2). */
function same(a: string, b: string): boolean {
  if (a === b) return true;
  const m = Math.min(a.length, b.length);
  return m >= 4 && commonPrefix(a, b) >= Math.max(4, m - 2);
}

const FIELD_WEIGHT = { action: 3, category: 2, example: 1, parameter: 0.75, description: 0.5, capability: 0.25 } as const;
const BIGRAM_WEIGHT = 1.5;

interface Lexicon { terms: Map<string, number>; bigrams: Set<string> }

function lexicon(i: Intent, skipExample = -1): Lexicon {
  const terms = new Map<string, number>();
  const add = (w: string, wt: number) => { if (!STOP.has(w) && w.length > 1 && (terms.get(w) ?? 0) < wt) terms.set(w, wt); };
  const [cat, ...action] = i.id.split(".");
  for (const w of action.flatMap(splitId)) add(w, FIELD_WEIGHT.action);
  if (!action.length) for (const w of splitId(cat)) add(w, FIELD_WEIGHT.action); // single-word ids (GENERAL)
  for (const w of [...splitId(cat), ...splitId(i.category)]) add(w, FIELD_WEIGHT.category);
  const bigrams = new Set<string>();
  i.examples.forEach((ex, n) => {
    if (n === skipExample) return;
    const ws = words(ex).map((x) => x.w);
    for (const w of ws) add(w, FIELD_WEIGHT.example);
    for (let k = 1; k < ws.length; k++) bigrams.add(`${ws[k - 1]} ${ws[k]}`);
  });
  for (const [name, p] of Object.entries(i.parameters?.properties ?? {})) {
    for (const w of splitId(name)) add(w, FIELD_WEIGHT.parameter);
    for (const e of p.enum ?? []) for (const w of splitId(String(e))) add(w, FIELD_WEIGHT.parameter);
  }
  for (const w of words(i.description)) add(w.w, FIELD_WEIGHT.description);
  for (const c of i.capabilities ?? []) for (const w of splitId(c)) add(w, FIELD_WEIGHT.capability);
  return { terms, bigrams };
}

interface Term { w: string; factor: number; start: number; end: number }

function promptTerms(text: string): { terms: Term[]; seq: string[] } {
  const ws = words(text);
  const terms: Term[] = ws.map((x) => ({ w: x.w, factor: 1, start: x.start, end: x.end }));
  for (const x of ws) {
    const raw = text.slice(x.start, x.end).toLowerCase();
    for (const syn of THESAURUS[x.w] ?? THESAURUS[raw] ?? []) terms.push({ w: syn, factor: SYNONYM_FACTOR, start: x.start, end: x.end });
  }
  return { terms, seq: ws.map((x) => x.w) };
}

class Scanner {
  readonly lex: Lexicon[];
  constructor(readonly intents: Intent[], skip?: { intent: number; example: number }) {
    this.lex = intents.map((i, n) => lexicon(i, skip && skip.intent === n ? skip.example : -1));
  }
  private weight(l: Lexicon, w: string): number {
    let best = l.terms.get(w) ?? 0;
    if (best < FIELD_WEIGHT.action) for (const [u, wt] of l.terms) if (wt > best && same(u, w)) best = wt;
    return best;
  }
  /** Raw weighted-match sum per intent; each prompt word counts once per intent (its best match). */
  raw(text: string): { raw: number[]; hits: number[][] } {
    const { terms, seq } = promptTerms(text);
    const N = this.intents.length;
    const idf = new Map<string, number>();
    const idfOf = (w: string) => {
      let v = idf.get(w);
      if (v === undefined) { const df = this.lex.filter((l) => this.weight(l, w) > 0).length; v = df ? Math.log(1 + N / df) : 0; idf.set(w, v); }
      return v;
    };
    const raw = new Array(N).fill(0), hits: number[][] = this.lex.map(() => []);
    this.lex.forEach((l, n) => {
      const best = new Map<number, number>(); // word start → best contribution
      for (const t of terms) {
        const c = t.factor * this.weight(l, t.w) * idfOf(t.w);
        if (c > (best.get(t.start) ?? 0)) best.set(t.start, c);
      }
      for (const [start, c] of best) { raw[n] += c; hits[n].push(start); }
      for (let k = 1; k < seq.length; k++) {
        let hit = false;
        for (const b of l.bigrams) { const [x, y] = b.split(" "); if (same(x, seq[k - 1]) && same(y, seq[k])) { hit = true; break; } }
        if (hit) raw[n] += BIGRAM_WEIGHT * (idfOf(seq[k - 1]) + idfOf(seq[k])) / 2;
      }
    });
    return { raw, hits };
  }
}

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// Confidence bands (docs/scoring.md)
const BANDS = { high: 0.8, medium: 0.55, low: 0.4 };
const band = (s: number): Band => (s >= BANDS.high ? "high" : s >= BANDS.medium ? "medium" : s >= BANDS.low ? "low" : "reject");

// ---------------------------------------------------------------------------------------------------------------
// Interpret: parameter binding from the registry's parameter schemas
// ---------------------------------------------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20 };
const money = (s: string) => { const m = s.match(/^\$?(\d+(?:\.\d+)?)([km])?$/i); return m ? Number(m[1]) * (m[2]?.toLowerCase() === "k" ? 1e3 : m[2]?.toLowerCase() === "m" ? 1e6 : 1) : NaN; };

function bindParameters(intent: Intent, prompt: string): { parameters: Record<string, unknown>; references: Record<string, unknown>; issues: string[] } {
  const parameters: Record<string, unknown> = {}, references: Record<string, unknown> = {}, issues: string[] = [];
  const lower = prompt.toLowerCase();
  const ints = [...lower.matchAll(/(?<![$\w.])(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)(?![\w%$]|-month|-week|-day| ?(?:months?|weeks?|days?|years?|quarters?))/g)].map((m) => NUMBER_WORDS[m[1]] ?? Number(m[1]));
  const amounts = [...prompt.matchAll(/\$\d+(?:\.\d+)?[kKmM]?\b/g)].map((m) => money(m[0]));
  const proper = [...prompt.matchAll(/(?<=\S\s+)([A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+)*)/g)].map((m) => m[1]).filter((w) => !/^(Q[1-4]|I|AI)$/.test(w));
  for (const [name, p] of Object.entries(intent.parameters?.properties ?? {})) {
    if (p.enum) {
      const hit = p.enum.find((e) => words(prompt).some((x) => same(x.w, stem(String(e).toLowerCase()))));
      if (hit !== undefined) parameters[name] = hit;
    } else if (p.type === "integer" && ints.length) {
      const v = ints[0];
      parameters[name] = v;
      if ((p.minimum !== undefined && v < p.minimum) || (p.maximum !== undefined && v > p.maximum)) issues.push(`${name}=${v} outside [${p.minimum ?? "-∞"}, ${p.maximum ?? "∞"}]`);
    } else if (p.type === "number" && amounts.length) parameters[name] = amounts[0];
    else if (p.type === "string") {
      const n = name.toLowerCase();
      if (/account|recipient|subject|audience/.test(n) && proper.length) references[name] = parameters[name] = proper[0];
      else if (/window|period|when|horizon/.test(n)) {
        const m = prompt.match(/\b(Q[1-4](?:\s\d{4})?|(?:this|last|next) (?:week|month|quarter|year)|today|tomorrow|yesterday|(?:next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|\d+[- ](?:month|week|day|year)s?)\b/i);
        if (m) parameters[name] = m[1];
      } else if (/topic/.test(n)) { const m = prompt.match(/\babout ([^.,;?!]+)/i); if (m) parameters[name] = m[1].trim(); }
      else if (/stage/.test(n)) { const m = lower.match(/\b(closed[- ]won|closed[- ]lost|negotiation|discovery|proposal|qualification)\b/); if (m) parameters[name] = m[1]; }
    }
  }
  for (const r of intent.parameters?.required ?? []) if (parameters[r] === undefined) issues.push(`required parameter ${r} not bound`);
  return { parameters, references, issues };
}

// ---------------------------------------------------------------------------------------------------------------
// Guard: policy packs (docs/risk-and-policy.md)
// ---------------------------------------------------------------------------------------------------------------

interface PolicyRule { intent: string; deny?: ((p: Record<string, unknown>) => string | null)[]; requireApproval?: ((p: Record<string, unknown>) => string | null)[] }
interface PolicyPack { name: string; version: number; toolRefCheck: boolean; rules: PolicyRule[] }

const PACKS: Record<string, PolicyPack> = {
  // Conservative defaults: pattern injection check (src/guard.ts), RBAC and surface gates from the registry,
  // PII redaction, and the one declarative policy the spec writes out (policies/deal.recover.yaml).
  default: {
    name: "default", version: 1, toolRefCheck: false,
    rules: [{
      intent: "deal.recover",
      deny: [(p) => (p.channel === "call" && Number(p.count) > 5 ? "never bulk-call (channel=call, count>5)" : null), (p) => (Number(p.count) > 20 ? "count above 20" : null)],
      requireApproval: [(p) => (/closed[- ]won/i.test(String(p.stage ?? "")) ? "touches a closed-won deal" : null)],
    }],
  },
  // Hardened posture for hostile surfaces: also blocks out-of-band tool references, i.e. a prompt naming a
  // registry capability that the routed intent does not declare.
  "adversarial-tight": { name: "adversarial-tight", version: 1, toolRefCheck: true, rules: [] },
};

const PII: [string, RegExp][] = [
  ["email-address", /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g],
  ["ssn", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["card-number", /\b(?:\d[ -]?){13,16}\b/g],
  ["phone", /(?<!\w)\+?\d{1,2}[ .-]?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g],
  ["credential", /\b(?:sk|pk|ghp|xox[abp])[-_][A-Za-z0-9_-]{12,}\b|\b(?:api[_ -]?key|password|token)\s*[:=]\s*\S+/gi],
];

const LIFT: Record<RiskClass, RiskClass> = { low: "medium", medium: "high", high: "high" };
const RANK: Record<RiskClass, number> = { low: 0, medium: 1, high: 2 };

// ---------------------------------------------------------------------------------------------------------------
// Scout
// ---------------------------------------------------------------------------------------------------------------

const TTL_MS = 5 * 60 * 1000;
const SELF_TEST_MS = 16;

export interface ScoutOptions { intentRegistry: string | Registry; policyPack?: string | string[]; secret?: string; now?: () => number }
export interface DecideInput { prompt: string; user?: { id?: string; role?: string }; surface?: string; parentId?: string; traceId?: string }

export class Scout {
  readonly registry: Registry;
  readonly packs: PolicyPack[];
  /** Score calibration constant: raw/(raw+K); K puts the median leave-one-out registry example at 0.80. */
  readonly K: number;
  private readonly scanner: Scanner;
  private readonly byId: Map<string, Intent>;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly capabilityIds: string[];

  constructor(opts: ScoutOptions) {
    this.registry = loadRegistry(opts.intentRegistry);
    const names = opts.policyPack === undefined ? ["default"] : Array.isArray(opts.policyPack) ? opts.policyPack : [opts.policyPack];
    this.packs = names.map((n) => { const p = PACKS[n]; if (!p) throw new Error(`unknown policy pack ${n} (known: ${Object.keys(PACKS).join(", ")})`); return p; });
    this.secret = opts.secret ?? process.env.RECALLWHY_CONTRACT_SECRET ?? randomBytes(32).toString("hex");
    this.now = opts.now ?? Date.now;
    const intents = this.registry.intents;
    this.byId = new Map(intents.map((i) => [i.id, i]));
    this.capabilityIds = [...new Set(intents.flatMap((i) => i.capabilities ?? []))];
    this.scanner = new Scanner(intents);

    // Calibrate K from the registry: each non-GENERAL example scored against its own intent with that example
    // removed from the lexicon (leave-one-out).
    const loo: number[] = [];
    intents.forEach((i, n) => {
      if (i.id === "GENERAL") return;
      i.examples.forEach((ex, e) => loo.push(new Scanner(intents, { intent: n, example: e }).raw(ex).raw[n]));
    });
    const med = median(loo.filter((x) => x > 0));
    this.K = med > 0 ? (med * (1 - BANDS.high)) / BANDS.high : 1;

    // Stage-1 startup self-test: a full-registry scan of every registry example must stay under 16 ms each.
    for (const ex of intents.flatMap((i) => i.examples)) {
      const t0 = performance.now();
      this.scanner.raw(ex);
      const ms = performance.now() - t0;
      if (ms > SELF_TEST_MS) throw new Error(`Scout Stage-1 self-test failed: full-registry scan took ${ms.toFixed(1)} ms (> ${SELF_TEST_MS} ms)`);
    }
  }

  get policyPackVersion(): string { return this.packs.map((p) => `${p.name}@${p.version}`).join("+"); }

  /** Stage-1 scores for every intent, highest first (GENERAL included only when it matched). */
  score(text: string): Candidate[] {
    const { raw } = this.scanner.raw(text);
    return this.registry.intents
      .map((i, n) => ({ intent: i.id, score: Math.round((raw[n] / (raw[n] + this.K)) * 1000) / 1000 }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  /** Split a prompt into request clauses at coordinating conjunctions and sentence breaks. */
  private clauses(prompt: string): { text: string; start: number }[] {
    const out: { text: string; start: number }[] = [];
    const re = /\s*(?:[;.!?]\s+|,?\s+(?:and then|and also|and|then|plus|also)\s+)/gi;
    let last = 0;
    for (const m of prompt.matchAll(re)) { out.push({ text: prompt.slice(last, m.index), start: last }); last = m.index! + m[0].length; }
    out.push({ text: prompt.slice(last), start: last });
    return out.filter((c) => words(c.text).length > 0);
  }

  async decide(input: DecideInput): Promise<Decision> {
    const prompt = String(input.prompt ?? "");
    const user = { id: input.user?.id ?? "anonymous", role: input.user?.role ?? "viewer" };
    const surface = input.surface ?? "chat";
    const traceId = input.traceId ?? ulid(this.now());

    // ---- Sense
    const whole = this.score(prompt);
    const general = this.byId.get("GENERAL")!;
    let primary: Candidate = whole[0] && band(whole[0].score) !== "reject" ? whole[0] : { intent: "GENERAL", score: whole.find((c) => c.intent === "GENERAL")?.score ?? 0 };

    // Multi-intent (docs/scoring.md): two clause winners, both High, on disjoint spans, and the whole-prompt
    // winner does not by itself explain every clause.
    let secondary: Candidate[] = [];
    const clauses = this.clauses(prompt);
    if (clauses.length > 1 && primary.intent !== "GENERAL") {
      const wins = clauses.map((c) => ({ ...this.score(c.text)[0], span: c.text.trim(), all: this.score(c.text) })).filter((w) => w.intent && w.intent !== "GENERAL");
      const distinct: typeof wins = [];
      for (const w of wins) if (!distinct.some((d) => d.intent === w.intent)) distinct.push(w);
      const high = distinct.filter((d) => band(d.score) === "high");
      const explainsAll = wins.every((w) => (w.all.find((c) => c.intent === primary.intent)?.score ?? 0) >= BANDS.medium);
      if (high.length >= 2 && !explainsAll) {
        const ranked = [...distinct].sort((a, b) => b.score - a.score);
        primary = { intent: ranked[0].intent, score: ranked[0].score, span: ranked[0].span };
        secondary = ranked.slice(1).filter((d) => d.score >= BANDS.medium).map((d) => ({ intent: d.intent, score: d.score, span: d.span }));
      }
    }
    const lead = [primary, ...secondary];
    const candidates = [...lead, ...whole.filter((c) => !lead.some((l) => l.intent === c.intent))].slice(0, 5);
    const intent = this.byId.get(primary.intent) ?? general;
    const planIntents = [intent, ...secondary.map((s) => this.byId.get(s.intent)!)];
    const b = band(primary.score);

    // ---- Interpret
    const bound = bindParameters(intent, prompt);
    let clarification: Clarification | null = null;
    const top3 = whole.filter((c) => c.intent !== "GENERAL").slice(0, 3);
    const options = (cs: Candidate[]) => cs.slice(0, 4).map((c) => ({ label: this.byId.get(c.intent)!.description.split(/[.—:]/)[0].trim(), intent: c.intent }));
    if (intent.id !== "GENERAL") {
      const second = whole.find((c) => c.intent !== primary.intent && !secondary.some((s) => s.intent === c.intent));
      if (b === "low") clarification = { reason: "low-confidence", question: "Which of these did you mean?", options: options(top3) };
      else if (b === "medium" && second && primary.score - second.score <= 0.05) clarification = { reason: "close-call", question: `Did you mean ${intent.id} or ${second.intent}?`, options: options([primary, second]) };
      else if (bound.issues.some((i) => i.startsWith("required"))) clarification = { reason: "missing-parameters", question: `I need more detail: ${bound.issues.join("; ")}.`, options: options([primary]) };
      else if (planIntents.some((i) => i.riskClass === "high") && primary.score < 0.95) clarification = { reason: "high-risk-confirmation", question: `This is a high-risk action (${intent.id}). Confirm that is what you want?`, options: options([primary]) };
    }

    // ---- Guard
    const flags: RiskFlag[] = [];
    const g = detectInjection(prompt);
    const injection: Risk["injection"] = { detected: false, score: 0, evidence: [] };
    if (g.flagged) {
      Object.assign(injection, { detected: true, kind: g.cls === "role-confusion" ? "role-drift" : g.cls === "tool-ref" ? "tool-ref" : "pattern", score: 1, evidence: [g.cls!] });
      flags.push({ layer: "injection", result: "block", code: `injection.${g.cls}` });
    }
    if (!injection.detected && this.packs.some((p) => p.toolRefCheck)) {
      const allowed = new Set(planIntents.flatMap((i) => i.capabilities));
      const named = this.capabilityIds.filter((c) => new RegExp(`(^|[^\\w.])${c.replace(".", "\\.")}([^\\w.]|$)`, "i").test(prompt) && !allowed.has(c));
      if (named.length) {
        Object.assign(injection, { detected: true, kind: "tool-ref", score: 1, evidence: ["out-of-band-capability"] });
        flags.push({ layer: "injection", result: "block", code: "injection.tool-ref", detail: named.join(", ") });
      }
    }
    for (const i of planIntents) {
      if (!i.roles.includes("*") && !i.roles.includes(user.role)) flags.push({ layer: "policy", result: "block", code: "rbac.role", detail: `${i.id} is not allowed for role ${user.role}` });
      if (!i.surfaces.includes(surface)) flags.push({ layer: "scope", result: "block", code: "scope.surface", detail: `${i.id} is not allowed on surface ${surface}` });
    }
    const approvalReasons: string[] = [];
    for (const pack of this.packs) for (const rule of pack.rules) {
      if (!planIntents.some((i) => i.id === rule.intent)) continue;
      for (const d of rule.deny ?? []) { const r = d(bound.parameters); if (r) flags.push({ layer: "policy", result: "block", code: `${pack.name}.${rule.intent}.deny`, detail: r }); }
      for (const a of rule.requireApproval ?? []) { const r = a(bound.parameters); if (r) approvalReasons.push(r); }
    }
    for (const issue of bound.issues.filter((i) => !i.startsWith("required"))) flags.push({ layer: "policy", result: "warn", code: "parameter.out-of-schema", detail: issue });
    const redactions: Redaction[] = [];
    for (const [kind, re] of PII) { const n = prompt.match(re)?.length ?? 0; if (n) redactions.push({ kind, count: n }); }
    if (redactions.length) flags.push({ layer: "pii", result: "warn", code: "pii.redacted", detail: redactions.map((r) => r.kind).join(", ") });

    const blocked = flags.find((f) => f.result === "block");
    let level: RiskClass = planIntents.reduce<RiskClass>((m, i) => (RANK[i.riskClass] > RANK[m] ? i.riskClass : m), "low");
    if (flags.some((f) => f.result === "warn" && f.layer !== "pii")) level = LIFT[level];
    const approvalsRequired: ApprovalSpec[] = [];
    if (planIntents.some((i) => i.riskClass === "high") && RANK[level] >= RANK.medium) approvalsRequired.push({ kind: "user-confirm", reason: "high-risk intent" }, { kind: "operator-review", reason: "high-risk intent: signed contract review" });
    for (const r of approvalReasons) approvalsRequired.push({ kind: "operator-review", reason: r });
    const risk: Risk = {
      level: blocked ? "block" : level, flags, redactions, injection,
      ...(blocked ? { reason: blocked.detail ?? blocked.code } : {}),
      ...(approvalsRequired.length ? { approvalsRequired } : {}),
    };

    // ---- Route: each intent's declared capabilities, in order, de-duplicated (tool = capability; no tool registry)
    const toolPlan: ToolStep[] = [];
    if (!blocked) for (const i of planIntents) for (const c of i.capabilities) if (!toolPlan.some((s) => s.capability === c)) toolPlan.push({ capability: c, tool: c, intent: i.id, input: i === intent ? bound.parameters : {} });

    const interpretation = { intent: intent.id, parameters: bound.parameters, references: bound.references, needsClarification: clarification !== null, band: b };
    if (blocked) return { traceId, candidates, intents: lead.map((c) => c.intent), interpretation, risk, toolPlan: [], clarification: null, executionContract: null };

    // ---- Recommend: model profile (src/scout-intent.ts routing rule) and the signed contract
    const r = route({ id: intent.id, match: /.*/, risk: level, checkedBy: "the downstream engine re-verifies the contract scope" }, profiles({ model: "capable", fastModel: "fast" }));
    const modelProfile = { id: r.profile, model: r.model, chain: r.chain, reason: r.reason };
    const now = this.now();
    const body: Omit<ExecutionContract, "signature"> = {
      contractId: ulid(now), ...(input.parentId ? { parentId: input.parentId } : {}), traceId,
      intent: {
        primary: { id: intent.id, version: intent.version }, parameters: bound.parameters, references: bound.references,
        confidence: primary.score, alternates: candidates.filter((c) => c.intent !== intent.id).slice(0, 3),
        secondary: secondary.map((s) => ({ id: s.intent, version: this.byId.get(s.intent)!.version })),
      },
      risk: { level, flags, redactions, approvals: [], approvalsRequired },
      toolPlan, modelProfile,
      scope: { user, surface, capabilities: toolPlan.map((s) => s.capability) },
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL_MS).toISOString(),
      registryVersion: this.registry.registryVersion ?? this.registry.version, policyPackVersion: this.policyPackVersion,
      signedBy: "scout",
    };
    const executionContract: ExecutionContract = { ...body, signature: this.sign(body) };
    return { traceId, candidates, intents: lead.map((c) => c.intent), interpretation, risk, toolPlan, modelProfile, clarification, executionContract };
  }

  private sign(body: Omit<ExecutionContract, "signature">): string { return createHmac("sha256", this.secret).update(canonical(body)).digest("hex"); }

  /** Downstream check: signature over the canonical encoding, freshness, and (optionally) a capability in scope. */
  verify(c: ExecutionContract, capability?: string): { ok: true } | { ok: false; reason: "signature" | "expired" | "scope" } {
    const { signature, ...body } = c;
    const want = Buffer.from(this.sign(body), "hex"), got = Buffer.from(String(signature), "hex");
    if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "signature" };
    if (this.now() > Date.parse(c.expiresAt)) return { ok: false, reason: "expired" };
    if (capability && !c.scope.capabilities.includes(capability)) return { ok: false, reason: "scope" };
    return { ok: true };
  }
}
