// Held-out check for RecallWhy's Scout (src/scout/index.ts) on the Meterless Scout Intent regression set.
// The official fixtures registry (conformance/scout-intent/evals/fixtures/intents.json) contains many of the
// regression-set prompts word for word as intent examples, so the official run partly scores memorisation.
// Here, for each regression-set example, the same registry is loaded, every registry example whose text equals
// that prompt (exact match after trim) is removed, and only that one example is scored by a fresh Scout.
// If removing an intent's examples would leave it with none, its description stands in as its only example
// (the registry loader requires examples); this is reported per example.
//
// tally / toMetrics / sliceValue / computeSlices / gate below are a faithful reimplementation of the official
// runner's functions (conformance/scout-intent/evals/runner/index.ts, Meterless@1742dec). The runner is not
// imported because it runs main() on import and exits the process.
//   npm run check:scout:heldout   → eval/results/scout-heldout.json
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Scout, type Registry } from "../src/scout/index.ts";
import { parse as parseYaml } from "./yaml-subset.ts";

const EVALS = "conformance/scout-intent/evals";
type Example = { id: string; prompt: string; user?: { role: string }; surface?: string; expected: { intent?: string; toolPlan?: string[]; injection?: boolean; risk?: string; clarification?: boolean } };
type Result = { ex: Example; out: any };
type Metrics = Record<string, number>;

// --- reimplemented from the official runner -------------------------------------------------------------------
type Tally = { intentTop1Hits: number; intentTop3Hits: number; intentTotal: number; injTP: number; injFP: number; injFN: number; injTN: number; toolHits: number; toolTotal: number; clarifications: number; contractsIssued: number; overrides: number; overrideDataSeen: boolean; n: number };
function tally(results: Result[]): Tally {
  const t: Tally = { intentTop1Hits: 0, intentTop3Hits: 0, intentTotal: 0, injTP: 0, injFP: 0, injFN: 0, injTN: 0, toolHits: 0, toolTotal: 0, clarifications: 0, contractsIssued: 0, overrides: 0, overrideDataSeen: false, n: results.length };
  for (const { ex, out } of results) {
    if (ex.expected.intent) {
      t.intentTotal++;
      const top1 = out.executionContract?.intent?.primary?.id;
      const top3 = (out.candidates ?? []).slice(0, 3).map((c: any) => c.intent);
      if (top1 === ex.expected.intent) t.intentTop1Hits++;
      if (top3.includes(ex.expected.intent)) t.intentTop3Hits++;
    }
    if (ex.expected.injection !== undefined) {
      const blocked = out.risk?.level === "block";
      if (ex.expected.injection && blocked) t.injTP++;
      else if (ex.expected.injection && !blocked) t.injFN++;
      else if (!ex.expected.injection && blocked) t.injFP++;
      else t.injTN++;
    }
    if (ex.expected.toolPlan?.length) {
      t.toolTotal++;
      const got = (out.toolPlan ?? []).map((s: any) => s.capability);
      if (ex.expected.toolPlan.every((c) => got.includes(c))) t.toolHits++;
    }
    if (out.clarification) t.clarifications++;
    if (out.executionContract) t.contractsIssued++;
    if (out.overrides !== undefined) { t.overrideDataSeen = true; t.overrides += Array.isArray(out.overrides) ? out.overrides.length : 0; }
  }
  return t;
}
function toMetrics(t: Tally): Metrics {
  return {
    intent_top1: t.intentTotal ? t.intentTop1Hits / t.intentTotal : 0,
    intent_top3_recall: t.intentTotal ? t.intentTop3Hits / t.intentTotal : 0,
    injection_precision: t.injTP + t.injFP ? t.injTP / (t.injTP + t.injFP) : 1,
    injection_recall: t.injTP + t.injFN ? t.injTP / (t.injTP + t.injFN) : 1,
    tool_precision: t.toolTotal ? t.toolHits / t.toolTotal : 0,
    clarification_rate: t.n ? t.clarifications / t.n : 0,
    override_frequency: t.contractsIssued ? t.overrides / t.contractsIssued : 0,
  };
}
function sliceValue(ex: Example, dim: string): string | undefined {
  switch (dim) {
    case "surface": return ex.surface ?? "chat";
    case "role": return ex.user?.role ?? "ae";
    case "intent_family": return ex.expected.intent?.split(".")[0];
    case "risk_class": return ex.expected.risk && ex.expected.risk !== "block" ? ex.expected.risk : undefined;
    default: return undefined;
  }
}
type SliceReport = Record<string, { metrics: Metrics; tally: Tally }>;
function computeSlices(results: Result[], thresholds: any): SliceReport {
  const slices: SliceReport = {};
  for (const spec of thresholds.slices ?? []) for (const value of spec.values ?? []) {
    const subset = results.filter((r) => sliceValue(r.ex, spec.dim) === value);
    if (!subset.length) continue;
    const t = tally(subset);
    slices[`${spec.dim}=${value}`] = { metrics: toMetrics(t), tally: t };
  }
  return slices;
}
function gate(metrics: Metrics, slices: SliceReport, thresholds: any): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const [name, t] of Object.entries(thresholds.metrics as Record<string, any>)) {
    const v = metrics[name];
    if (v === undefined) continue;
    if (t.hard_floor !== undefined && v < t.hard_floor) failures.push(`${name}=${v.toFixed(3)} below floor ${t.hard_floor}`);
    if (t.hard_max !== undefined && v > t.hard_max) failures.push(`${name}=${v.toFixed(3)} above ceiling ${t.hard_max}`);
  }
  for (const [metric, policy] of Object.entries((thresholds.slice_policy ?? {}) as Record<string, any>)) {
    const floor = policy.slice_hard_floor;
    if (floor === undefined) continue;
    for (const [key, s] of Object.entries(slices)) {
      const relevant = metric === "intent_top1" ? s.tally.intentTotal > 0 : metric === "injection_precision" ? s.tally.injTP + s.tally.injFP > 0 : true;
      if (!relevant) continue;
      const v = s.metrics[metric];
      if (v !== undefined && v < floor) failures.push(`slice ${key}: ${metric}=${v.toFixed(3)} below slice floor ${floor}`);
    }
  }
  return { pass: failures.length === 0, failures };
}
// ---------------------------------------------------------------------------------------------------------------

const thresholds = parseYaml(readFileSync(join(EVALS, "config/thresholds.yaml"), "utf8"));
const registryText = readFileSync(join(EVALS, "fixtures/intents.json"), "utf8");
const corpus: Example[] = [];
for (const d of ["intents", "injection", "multi-intent", "edge-cases"]) {
  const dir = join(EVALS, "regression-set/v1", d);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")))
    corpus.push(...readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Example));
}

const results: Result[] = [];
const verbatim: string[] = [], descriptionFallback: string[] = [];
for (const ex of corpus) {
  const registry = JSON.parse(registryText) as Registry;
  let found = false;
  for (const i of registry.intents) {
    const keep = i.examples.filter((e) => e.trim() !== ex.prompt.trim());
    if (keep.length === i.examples.length) continue;
    found = true;
    i.examples = keep.length ? keep : [i.description];
    if (!keep.length) descriptionFallback.push(`${ex.id}:${i.id}`);
  }
  if (found) verbatim.push(ex.id);
  const scout = new Scout({ intentRegistry: registry, policyPack: ["default", "adversarial-tight"] });
  const out = await scout.decide({ prompt: ex.prompt, user: { id: "eval", role: ex.user?.role ?? "ae" }, surface: ex.surface ?? "chat" });
  results.push({ ex, out });
}

const t = tally(results);
const metrics = toMetrics(t);
const slices = computeSlices(results, thresholds);
const g = gate(metrics, slices, thresholds);
const round = (m: Metrics) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
const misses = results.filter((r) => r.ex.expected.intent && r.out.executionContract?.intent?.primary?.id !== r.ex.expected.intent)
  .map((r) => ({ id: r.ex.id, expected: r.ex.expected.intent, got: r.out.executionContract?.intent?.primary?.id ?? null }));

mkdirSync("eval/results", { recursive: true });
writeFileSync("eval/results/scout-heldout.json", JSON.stringify({
  method: "per example: fixtures registry minus every example equal to the prompt (exact, after trim); official runner's tally/toMetrics/gate reimplemented",
  corpus: "conformance/scout-intent/evals/regression-set/v1 (Meterless@1742dec)",
  verbatimInRegistry: { found: verbatim.length, of: corpus.length, ids: verbatim },
  descriptionFallback,
  metrics: round(metrics),
  slices: Object.fromEntries(Object.entries(slices).map(([k, s]) => [k, { n: s.tally.n, metrics: round(s.metrics) }])),
  gate: g,
  intentMisses: misses,
  overrideNote: t.overrideDataSeen ? undefined : "override_frequency is 0 by definition: no override data in corpus v1",
}, null, 2) + "\n");

const fmt = (k: string) => `${k}=${metrics[k].toFixed(3)}`;
console.log(`${g.pass ? "PASS" : "FAIL"} scout held-out: ${Object.keys(metrics).map(fmt).join(" ")}; ${verbatim.length}/${corpus.length} prompts verbatim in registry${g.failures.length ? `; ${g.failures.join("; ")}` : ""}`);
process.exit(g.pass ? 0 : 1);
