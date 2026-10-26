// Model routing as Meterless Scout Intent specifies it (engines/scout-intent/docs/model-routing.md, intent-registry.md):
// every model call is classified into an intent from a registry; the intent's risk class and how its output is
// checked decide which model profile runs it; a profile declares its fallbacks, and a high-risk intent never
// falls back to a smaller model. Each decision is a trace event (`route`), so the eval and a judge can see
// whether the right profile was picked, not only whether the answer was good.
import type { LlmConfig } from "./llm.ts";

export type RiskClass = "low" | "medium" | "high";
export interface Intent {
  id: string;
  /** How the task's purpose string reads (the agents name every model call by its purpose). */
  match: RegExp;
  risk: RiskClass;
  /** What checks the output before anything acts on it: why a small model can (or cannot) be trusted with it. */
  checkedBy: string;
}

export const INTENTS: Intent[] = [
  { id: "match.judge", match: /^judge /, risk: "high", checkedBy: "the Auditor's grounding, product-word and size checks; blocked dismissals go back or to a person" },
  { id: "brief.check", match: /^check brief support/, risk: "high", checkedBy: "nothing after it: it is the Auditor's own check" },
  { id: "brief.write", match: /^why-paragraph/, risk: "medium", checkedBy: "lexical evidence checks and the Auditor's model check; else the template" },
  { id: "digest.write", match: /^digest chunk/, risk: "medium", checkedBy: "every number comes from the audited cases" },
  { id: "barcode.transform.propose", match: /^propose a barcode transform/, risk: "medium", checkedBy: "a closed op set compiled by code; SQL must prove it on every ship notice of the supplier" },
  { id: "lots.read", match: /^read lot codes/, risk: "low", checkedBy: "each code must appear word for word in the notice; dates are dropped" },
];
const UNKNOWN: Intent = { id: "other", match: /.*/, risk: "high", checkedBy: "unknown task: treated as high risk" };

export interface ModelProfile { id: string; model: string; quality: "high" | "standard"; fallbacks: string[] }

/** The deployment's profiles: the main model (high quality) and, when set, a fast one for low-risk checked tasks. */
export function profiles(cfg: Pick<LlmConfig, "model" | "fastModel">): ModelProfile[] {
  const out: ModelProfile[] = [{ id: "capable", model: cfg.model, quality: "high", fallbacks: [] }];
  if (cfg.fastModel && cfg.fastModel !== cfg.model) out.push({ id: "fast", model: cfg.fastModel, quality: "standard", fallbacks: ["capable"] });
  return out;
}

/** The intent of a model call, from its purpose. An unknown task is high risk. */
export function classify(purpose: string): Intent {
  return INTENTS.find((i) => i.match.test(purpose)) ?? UNKNOWN;
}

export interface Route { intent: string; risk: RiskClass; profile: string; model: string; chain: string[]; reason: string }

/**
 * Pick the profile for an intent: a low-risk intent whose output is checked downstream goes to the fast profile
 * (falling back to the capable one); medium and high risk go to the capable profile with no fallback to a
 * smaller model, as the spec's quality rule for high-risk classes asks.
 */
export function route(intent: Intent, ps: ModelProfile[]): Route {
  const byId = new Map(ps.map((p) => [p.id, p]));
  const fast = byId.get("fast"), capable = byId.get("capable")!;
  const pick = intent.risk === "low" && fast ? fast : capable;
  const chain = [pick.id, ...pick.fallbacks.filter((f) => byId.has(f))];
  const reason = pick === fast
    ? `low risk, output checked (${intent.checkedBy}): fast profile, falls back to capable`
    : intent.risk === "low" ? "low risk, but no fast profile configured" : `${intent.risk} risk: capable profile, no fallback to a smaller model`;
  return { intent: intent.id, risk: intent.risk, profile: pick.id, model: pick.model, chain: chain.map((id) => byId.get(id)!.model), reason };
}
