// Recomputes the numbers that README.md, eval/EVAL.md, eval/REAL.md, metadata.json, the deck, the site and
// docs/SUBMISSION.md state from the committed evaluation results and example traces, and fails if any
// document says something else.   npm run check:claims
import { readFileSync, readdirSync, existsSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const json = (p: string) => JSON.parse(read(p));
type Score = { pairs: number; positives: number; caught: number; falseAlarms: number; wronglyDismissed: number; toHuman: number };
type Row = { recall: string; sku: string; basis: string; label: string; final: string };
type Result = { all: Score; rows: Row[]; scanned: number; modelCalls?: { total: number; failedAfterRetries: number }; cartographerRules?: { transform: string; rows: number }[] };

const ultra: Result = json("eval/results/meterless-nvidia_nemotron-3-ultra-550b-a55b.json");
const light: Result = json("eval/results/meterless-nvidia_nemotron-3.5-lightning-30b-a3b.json");
const rules: Result = json("eval/results/none-none.json");
const proposals: Result = json("eval/results/none-none-map-nvidia_nemotron-3-ultra-550b-a55b.json");
const noCarto: Result = json("eval/results/none-none-no-cartographer.json");
const onDemand: Result = json("eval/results/none-none-map-on-demand.json");
const real = json("eval/results/real-items-nvidia_nemotron-3-ultra-550b-a55b.json");

// The judge's first answer vs the final decision on text matches (same logic as eval/first-vs-final.py).
function textTable(r: Result, firstFile: string) {
  const first: Record<string, string> = json(firstFile).firstAnswers;
  const rows = r.rows.filter((x) => x.basis === "text");
  const score = (get: (x: Row) => string) => [
    rows.filter((x) => x.label === "same" && get(x) === "same").length,
    rows.filter((x) => x.label === "same" && get(x) === "not-this").length,
    rows.filter((x) => x.label === "not-this" && get(x) === "same").length,
    rows.filter((x) => get(x) === "unsure").length,
  ];
  return { first: score((x) => first[`${x.recall} ${x.sku}`] ?? "missing"), final: score((x) => x.final) };
}
const ut = textTable(ultra, "eval/results/meterless-nvidia_nemotron-3-ultra-550b-a55b-first-answers.json");
const u = ultra.all, l = light.all;
const settled = u.pairs - u.toHuman, correct = settled - u.wronglyDismissed - u.falseAlarms;
const calls = (r: Result) => `0 of ${r.modelCalls!.total}`;
const proposed = (proposals.cartographerRules ?? []).filter((x) => x.transform === "proposed").map((x) => x.rows).sort((a, b) => a - b);
// Lightning is compared only when it ran on the same pairs as Ultra.
const lightCurrent = l.pairs === u.pairs && l.positives === u.positives;

const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts")).reduce((n, f) => n + (read(`test/${f}`).match(/^\s*(test|it)\(/gm) ?? []).length, 0);
const README = read("README.md"), EVAL = read("eval/EVAL.md"), REAL = read("eval/REAL.md"), META = read("metadata.json"), DECK = read("deck/deck.html"), SITE = read("site/index.html"), SUB = read("docs/SUBMISSION.md");
const bc = real.barcodePath, ra = real.afterAuditor, rf = real.judgeFirstAnswer;

// Every live example: each supplier rule the Cartographer proved is the rule written back to Zetaris and read back in full, and Zetaris's data-quality rule reports no invalid row.
const examples = existsSync("examples/output") ? readdirSync("examples/output").filter((d) => existsSync(`examples/output/${d}/trace.jsonl`) && !d.includes("sample_mode")) : [];
const exampleChecks: [string, boolean][] = examples.map((d) => {
  const t = read(`examples/output/${d}/trace.jsonl`);
  const proven = [...t.matchAll(/(SUP\d+) sends [^\n]*?holds for all (\d+) of its ship notices/g)].map((m) => `${m[1]} ${m[2]}/${m[2]}`);
  const readBack = [...t.matchAll(/read back: ((?:SUP\d+ \d+\/\d+(?:, )?)+)/g)].flatMap((m) => m[1].split(", "));
  const dq = [...t.matchAll(/data-quality rule barcode_names_the_notice_sku on \S+: (\d+)\/(\d+) rows valid, (\d+) invalid/g)];
  const ok = proven.every((p) => readBack.includes(p)) && readBack.every((r) => { const [a, b] = r.split(" ")[1].split("/"); return a === b; }) && dq.every((m) => m[1] === m[2] && m[3] === "0") && (!proven.length || dq.length > 0);
  return [`example ${d}: proven rules ${proven.join(", ") || "none"} read back in full from Zetaris, data-quality rule 0 invalid`, ok];
});

const claims: [string, boolean][] = [
  [`README: ${settled} settled without a person, ${correct} correctly`, README.includes(`settle ${settled} (`) && README.includes(`${correct} of them correctly`)],
  [`README: ${u.caught} of ${u.positives} caught, ${u.wronglyDismissed} missed, ${u.falseAlarms} false alarm, rules alone ${rules.all.caught}`, README.includes(`${u.caught} of ${u.positives} recalled items are caught, with ${u.wronglyDismissed} missed and ${u.falseAlarms} false alarm${u.falseAlarms === 1 ? "" : "s"} (rules alone: ${rules.all.caught})`)],
  [`README/EVAL: Ultra row ${u.caught}/${u.wronglyDismissed}/${u.falseAlarms}/${u.toHuman}, ${calls(ultra)}`, [README, EVAL].every((d) => d.includes(`| **${u.caught}** | **${u.wronglyDismissed}** | **${u.falseAlarms}** | ${u.toHuman} | ${calls(ultra)} |`))],
  [`README/EVAL: rules-only row ${rules.all.caught}/${rules.all.toHuman}`, README.includes(`| none (rules only) | ${rules.all.caught} | 0 | 0 | ${rules.all.toHuman} | — |`) && EVAL.includes(`| ${rules.all.caught} | 0 | 0 | ${rules.all.toHuman} | — |`)],
  [`README: ablation ${noCarto.all.caught} / ${onDemand.all.caught} / ${rules.all.caught} / ${proposals.all.caught}`, README.includes(`| ${noCarto.all.caught} | ${noCarto.all.toHuman} |`) && README.includes(`| ${onDemand.all.caught} | ${onDemand.all.toHuman} |`) && README.includes(`| **${proposals.all.caught}** | ${proposals.all.toHuman} |`)],
  [`README: proposed transforms proven on ${proposed.join(", ")} rows`, README.includes(`(${proposed.join(", ")} rows)`)],
  [`README/EVAL: Ultra text matches first ${ut.first.join("/")} → final ${ut.final.join("/")}`, README.includes(`| Ultra, judge's first answer | ${ut.first.join(" | ")} |`) && README.includes(`| Ultra, after the Auditor loop | ${ut.final[0]} | **${ut.final[1]}** | **${ut.final[2]}** | ${ut.final[3]} |`) && EVAL.includes(`| Ultra, after the Auditor loop | ${ut.final.join(" | ")} |`)],
  [`Lightning ${lightCurrent ? `row ${l.caught}/${l.wronglyDismissed}/${l.falseAlarms}/${l.toHuman}` : "is from the earlier item master and is not in the current tables"}`, lightCurrent ? README.includes(`| ${l.caught} | ${l.wronglyDismissed} | ${l.falseAlarms} | ${l.toHuman} | ${calls(light)} |`) : !README.includes(`| ${l.caught} | ${l.wronglyDismissed} | ${l.falseAlarms} | ${l.toHuman} | ${calls(light)} |`)],
  [`metadata: ${u.caught}/${u.positives}, dismissals ${ut.first[1]} → ${ut.final[1]}`, META.includes(`catches ${u.caught}/${u.positives}`) && META.includes(`dismissals ${ut.first[1]} → ${ut.final[1]}`)],
  [`deck: ${u.caught} of ${u.positives}, ${settled} of ${u.pairs}, ${correct} correctly`, DECK.includes(`${u.caught} of ${u.positives} recalled items caught`) && DECK.includes(`${settled} of ${u.pairs} pairs`) && DECK.includes(`${correct} correctly`)],
  [`site: ${u.caught} / ${u.positives}, ${ut.first[1]} → ${ut.final[1]}, ${rules.all.caught} → ${proposals.all.caught}`, SITE.includes(`${u.caught} / ${u.positives}`) && SITE.includes(`${ut.first[1]} → ${ut.final[1]}`) && SITE.includes(`${rules.all.caught} → ${proposals.all.caught}`)],
  [`submission: ${u.caught} of ${u.positives}, ${ut.first[1]} to ${ut.final[1]}`, SUB.includes(`catches ${u.caught} of ${u.positives} covered pairs (rules alone: ${rules.all.caught})`) && SUB.includes(`from ${ut.first[1]} to ${ut.final[1]}`)],
  [`real products: barcode ${bc.settledByUpcRule}/97, re-checked ${bc.settledAndAuditorDigitsAgree}, text ${ra.caught}/${ra.wronglyDismissed}/${ra.falseAlarms}/${ra.toHuman}`,
    README.includes(`**${bc.settledByUpcRule} of 97 by the UPC rule`) && README.includes(`catches ${ra.caught} of 97, misses ${ra.wronglyDismissed}, raises ${ra.falseAlarms} false alarms`) &&
    REAL.includes(`| after the Auditor (final) | ${ra.caught} / 97 | **${ra.wronglyDismissed}** | ${ra.falseAlarms} / 152 | ${ra.toHuman}`) && REAL.includes(`| judge, first answer | ${rf.caught} / 97 | ${rf.wronglyDismissed} | ${rf.falseAlarms} / 152 | ${rf.toHuman} |`) &&
    META.includes(`${bc.settledByUpcRule}/97 settled by the UPC rule`) && SUB.includes(`settles ${bc.settledByUpcRule} of 97 recalls`)],
  [`${tests} tests in metadata and the deck`, META.includes(`(${tests} tests;`) && DECK.includes(`${tests} tests incl.`)],
  [`no placeholder left in the documents`, ![README, EVAL, REAL, META, DECK, SITE, SUB].some((d) => /\{[A-Z]_[A-Z_]+\}/.test(d))],
  ...exampleChecks,
];

for (const [what, ok] of claims) console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
const bad = claims.filter(([, ok]) => !ok).length;
console.log(`${claims.length - bad}/${claims.length} claims match the committed results`);
process.exit(bad ? 1 : 0);
