// Recomputes the numbers that README.md, eval/EVAL.md, metadata.json and the deck state from the
// committed evaluation results and example traces, and fails if any document says something else.
// npm run check:claims
import { readFileSync, readdirSync } from "node:fs";

const read = (p: string) => readFileSync(p, "utf8");
const json = (p: string) => JSON.parse(read(p));
type Score = { pairs: number; positives: number; caught: number; falseAlarms: number; wronglyDismissed: number; toHuman: number };
type Row = { recall: string; sku: string; basis: string; label: string; final: string };
type Result = { all: Score; rows: Row[]; modelCalls?: { total: number; failedAfterRetries: number }; cartographerRules?: { transform: string; rows: number }[] };

const ultra: Result = json("eval/results/meterless-nvidia_nemotron-3-ultra-550b-a55b.json");
const light: Result = json("eval/results/meterless-nvidia_nemotron-3.5-lightning-30b-a3b.json");
const rules: Result = json("eval/results/none-none.json");
const proposals: Result = json("eval/results/none-none-map-nvidia_nemotron-3-ultra-550b-a55b.json");
const noCarto: Result = json("eval/results/none-none-no-cartographer.json");
const onDemand: Result = json("eval/results/none-none-map-on-demand.json");

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
const lt = textTable(light, "eval/results/meterless-nvidia_nemotron-3.5-lightning-30b-a3b-first-answers.json");

const u = ultra.all, l = light.all;
const settled = u.pairs - u.toHuman, correct = settled - u.wronglyDismissed - u.falseAlarms;
const calls = (r: Result) => `0 of ${r.modelCalls!.total}`;
const proposed = (proposals.cartographerRules ?? []).filter((x) => x.transform === "proposed").map((x) => x.rows).sort((a, b) => a - b);
const holds = (file: string, n: number) => read(file).includes(`holds for all ${n} of its ship notices`);

const tests = readdirSync("test").filter((f) => f.endsWith(".test.ts")).reduce((n, f) => n + (read(`test/${f}`).match(/^\s*(test|it)\(/gm) ?? []).length, 0);
const README = read("README.md"), EVAL = read("eval/EVAL.md"), META = read("metadata.json"), DECK = read("deck/deck.html"), SITE = read("site/index.html");
const claims: [string, boolean][] = [
  [`README: ${settled} settled without a person, ${correct} correctly`, README.includes(`settle ${settled} (`) && README.includes(`${correct} of them correctly`)],
  [`README: ${u.caught} of ${u.positives} caught, rules alone ${rules.all.caught}`, README.includes(`${u.caught} of ${u.positives} recalled items are caught (rules alone: ${rules.all.caught})`)],
  [`README: Ultra row ${u.caught}/${u.wronglyDismissed}/${u.falseAlarms}/${u.toHuman}, ${calls(ultra)}`, README.includes(`| **${u.caught}** | **${u.wronglyDismissed}** | **${u.falseAlarms}** | ${u.toHuman} | ${calls(ultra)} |`)],
  [`README: Lightning row ${l.caught}/${l.wronglyDismissed}/${l.falseAlarms}/${l.toHuman}, ${calls(light)}`, README.includes(`| ${l.caught} | ${l.wronglyDismissed} | ${l.falseAlarms} | ${l.toHuman} | ${calls(light)} |`)],
  [`README: rules-only row ${rules.all.caught}/${rules.all.toHuman}`, README.includes(`| none (rules only) | ${rules.all.caught} | 0 | 0 | ${rules.all.toHuman} | — |`)],
  [`README: ablation ${noCarto.all.caught} / ${onDemand.all.caught} / ${rules.all.caught} / ${proposals.all.caught}`, README.includes(`| ${noCarto.all.caught} | ${noCarto.all.toHuman} |`) && README.includes(`| ${onDemand.all.caught} | ${onDemand.all.toHuman} |`) && README.includes(`| **${proposals.all.caught}** | ${proposals.all.toHuman} |`)],
  [`README: proposed transforms proven on ${proposed.join(", ")} rows`, README.includes(`(${proposed.join(", ")} rows)`)],
  [`README: Ultra text matches first ${ut.first.join("/")} → final ${ut.final.join("/")}`, README.includes(`| Ultra, judge's first answer | ${ut.first.join(" | ")} |`) && README.includes(`| Ultra, after the Auditor loop | ${ut.final[0]} | **${ut.final[1]}** | **${ut.final[2]}** | ${ut.final[3]} |`)],
  [`README: Lightning text matches first ${lt.first.join("/")} → final ${lt.final.join("/")}`, README.includes(`| Lightning, judge's first answer | ${lt.first.join(" | ")} |`) && README.includes(`| Lightning, after the Auditor loop | ${lt.final.join(" | ")} |`)],
  [`EVAL: Ultra and Lightning rows`, EVAL.includes(`| **${u.caught}** | **${u.wronglyDismissed}** | **${u.falseAlarms}** | ${u.toHuman} | ${calls(ultra)} |`) && EVAL.includes(`| ${l.caught} | ${l.wronglyDismissed} | ${l.falseAlarms} | ${l.toHuman} | ${calls(light)} |`)],
  [`metadata: ${u.caught}/${u.positives}, dismissals ${ut.first[1]} → ${ut.final[1]}`, META.includes(`catches ${u.caught}/${u.positives}`) && META.includes(`dismissals ${ut.first[1]} → ${ut.final[1]}`)],
  [`deck: ${u.caught} of ${u.positives}, ${ut.first[1]} → ${ut.final[1]}, ${settled}/${correct}`, DECK.includes(`${u.caught} of ${u.positives} recalled items caught`) && DECK.includes(`${ut.first[1]} → ${ut.final[1]}`) && DECK.includes(`${settled} of 440 pairs`) && DECK.includes(`${correct} correctly`)],
  [`site: ${u.caught} / ${u.positives}, ${ut.first[1]} → ${ut.final[1]}, ${rules.all.caught} → ${proposals.all.caught}`, SITE.includes(`${u.caught} / ${u.positives}`) && SITE.includes(`${ut.first[1]} → ${ut.final[1]}`) && SITE.includes(`${rules.all.caught} → ${proposals.all.caught}`)],
  [`${tests} tests in metadata and the deck`, META.includes(`(${tests} tests;`) && DECK.includes(`${tests} tests incl.`)],
  [`example_1 trace: SUP007 rule proven on 484 ship notices`, holds("examples/output/example_1/trace.jsonl", 484)],
  [`example_3_after_human_decision trace: SUP010 transform proven on 299 ship notices`, holds("examples/output/example_3_after_human_decision/trace.jsonl", 299)],
  [`example traces: corrected map written back to Zetaris and read back (SUP007 484/484, SUP010 299/299)`, read("examples/output/example_1/trace.jsonl").includes("written back to Zetaris as reconciled.ship_notice_item_keys and read back: SUP007 484/484") && read("examples/output/example_3_after_human_decision/trace.jsonl").includes("written back to Zetaris as reconciled.ship_notice_item_keys and read back: SUP010 299/299")],
];

for (const [what, ok] of claims) console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
const bad = claims.filter(([, ok]) => !ok).length;
console.log(`${claims.length - bad}/${claims.length} claims match the committed results`);
process.exit(bad ? 1 : 0);
