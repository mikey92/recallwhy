// The Guard step of Meterless Scout Intent (engines/scout-intent/docs/risk-and-policy.md), for the one
// untrusted input that reaches a model here: the text of a public recall notice. A notice that carries
// instructions for a model (override, role confusion, embedded control tokens, a tool or secrets request,
// or an answer it wants the judge to give) is not sent to the judge; the pair goes to a person.
// Tested on Scout's own adversarial regression set (test/guard.test.ts) and on every notice in sample/,
// none of which it flags.
export type InjectionClass = "instruction-override" | "role-confusion" | "embedded-control" | "tool-ref" | "answer-steering" | "unicode";
export interface GuardResult { flagged: boolean; cls?: InjectionClass; match?: string }

const RULES: [InjectionClass, RegExp][] = [
  ["unicode", /[\u202A-\u202E\u2066-\u2069]|\\u20(2[A-E]|6[6-9])/],
  ["instruction-override", /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,30}\b(all (of )?(the )?)?(previous|prior|above|earlier|preceding|system|your)\b[^.\n]{0,25}\b(instructions?|rules?|prompts?|guidelines?)\b|\bignore (all |any )?previous\b|\byou are now\b|\bunrestricted mode\b|\bnew instructions?\s*:/i],
  ["instruction-override", /\bdisregard the (user|system|operator)\b(?! manual)[^.\n]{0,20}\b(and|to)\b/i],
  ["role-confusion", /<\/?\s*(system|user|assistant|developer)\s*>|^\s*(system|assistant|developer)\s*:/im],
  ["role-confusion", /\bpretend (to be|you are)\b|\bact as (the )?(system|admin|administrator|root)\b|\byou are an? (database |system )?(admin|administrator|root)\b/i],
  ["embedded-control", /\[\/?INST\]|<\|im_(start|end)\|>|<\|(system|user|assistant)\|>|###\s*(instruction|system)|BEGIN (SYSTEM )?PROMPT/i],
  ["tool-ref", /\b(grant|give|elevate)\b[^.\n]{0,20}\b(me|us)\b[^.\n]{0,20}\b(admin|root|access|privileges?)\b|\breveal\b[^.\n]{0,40}\b(api keys?|keys|credentials?|passwords?|secrets?|tokens?)\b|\buse [a-z]+_[a-z_]+ to\b/i],
  ["answer-steering", /\b(answer|respond|reply|output|say|return)\b[^.\n]{0,25}\b(SAME|DIFFERENT|UNSURE)\b|\bmark (this|it|every|all)\b[^.\n]{0,20}\b(as )?(not[- ]?ours|safe|not recalled|not this)\b/],
];

export function detectInjection(text: string): GuardResult {
  for (const [cls, re] of RULES) {
    const m = text.match(re);
    if (m) return { flagged: true, cls, match: m[0].slice(0, 80) };
  }
  return { flagged: false };
}
