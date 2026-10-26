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
  [`deck: judge off ${rules.all.caught} / ${proposals.all.caught} / ${noCarto.all.caught} of ${u.positives}`, DECK.includes(`Judge off: <b>${rules.all.caught}</b> of ${u.positives} caught with known rules, <b>${proposals.all.caught}</b> with proposals, <b>${noCarto.all.caught}</b> without the Cartographer`)],
  [`${tests} tests in metadata and the deck`, META.includes(`(${tests} tests;`) && DECK.includes(`${tests} tests incl.`)],
  ...measuredClaims(),
  [`no placeholder left in the documents`, ![README, EVAL, REAL, META, DECK, SITE, SUB].some((d) => /\{[A-Z]_[A-Z_]+\}/.test(d))],
  ...exampleChecks,
];

// Today's measurements: time per case, Markovian prompt sizes, the by-hand case, the live run time, repeatability.
function measuredClaims(): [string, boolean][] {
  const lat = json("eval/results/latency.json"), mk = json("eval/results/markovian.json"), rp = json("eval/results/repro.json");
  const f1 = (x: number) => x.toFixed(1), n = (x: number) => x.toLocaleString("en-US");
  const maxSql = Math.max(...lat.cases.filter((c: { packet: boolean }) => c.packet).map((c: { sqlSeconds: number }) => c.sqlSeconds));
  const ev = read("examples/output/example_2/trace.jsonl").trim().split("\n").map((l) => JSON.parse(l));
  let on = false, t0 = 0, t1 = 0, sqlN = 0, llmN = 0;
  for (const e of ev) {
    if (e.kind === "msg" && e.agent === "Investigator" && /^opening /.test(e.text ?? "")) { on = /H-1362/.test(e.text); if (on) t0 = Date.parse(e.t); }
    if (!on) continue;
    if (e.kind === "sql") sqlN++; if (e.kind === "llm") llmN++;
    if (e.kind === "msg" && e.agent === "Orchestrator" && /action packet drafted/.test(e.text ?? "")) { t1 = Date.parse(e.t); on = false; }
  }
  const secs = Math.round((t1 - t0) / 1000);
  const ex4 = read("examples/output/example_4/trace.jsonl").trim().split("\n");
  const d4 = Math.round((Date.parse(JSON.parse(ex4[ex4.length - 1]).t) - Date.parse(JSON.parse(ex4[0]).t)) / 1000);
  const run4 = `${Math.floor(d4 / 60)} min ${d4 % 60} s`;
  return [
    [`README: time per case median ${f1(lat.medianSeconds)} s over ${lat.casesWithPacket}, model ${f1(lat.medianModelSeconds)}, SQL ${f1(lat.medianSqlSeconds)} up to ${f1(maxSql)}`, README.includes(`median ${f1(lat.medianSeconds)} s over ${lat.casesWithPacket} cases (${f1(lat.minSeconds)} s to ${f1(lat.maxSeconds)} s)`) && README.includes(`model calls ${f1(lat.medianModelSeconds)} s`) && README.includes(`Zetaris SQL ${f1(lat.medianSqlSeconds)} s (median; up to ${f1(maxSql)} s`)],
    [`Markovian: largest prompt ${mk.largestPromptTokens.markovian} vs ${n(mk.onePromptAllCasesTokens)} over ${mk.cases} cases`, [README, SUB].every((d) => d.includes(`${mk.largestPromptTokens.markovian} tokens`) && d.includes(n(mk.onePromptAllCasesTokens))) && DECK.includes(`largest ${mk.largestPromptTokens.markovian} tokens over ${mk.cases} cases`)],
    [`by hand: H-1362 in ${secs} s, ${sqlN} SQL, ${llmN} model calls`, README.includes(`${secs} seconds with ${sqlN} SQL statements and ${llmN} model calls`) && read("eval/BY-HAND.md").includes(`${sqlN} SQL statements and ${llmN} model calls, ${secs} seconds`)],
    [`example_4 took ${run4}`, [README, SUB, SITE, DECK].every((d) => d.includes(run4)) && read("examples/README.md").includes(run4)],
    (() => { const h = json("eval/results/scout-heldout.json"); const t1 = h.metrics.intent_top1.toFixed(3); return [`Scout held-out: ${h.verbatimInRegistry.found} of ${h.verbatimInRegistry.of} prompts in the registry, top-1 ${t1}, gate ${h.gate.pass ? "passes" : "fails"}`, [README, SUB].every((d) => new RegExp(`${h.verbatimInRegistry.found} of (the |its )?${h.verbatimInRegistry.of}`).test(d) && (d.includes(`top-1 is ${t1}`) || d.includes(`top-1 ${t1}`))) && !h.gate.pass === /gate (\*\*)?fails/.test(README)] as [string, boolean]; })(),
    (() => { const o = json("eval/results/one-prompt-nvidia_nemotron-3-ultra-550b-a55b.json"); const p = o.onePrompt, t = o.onePromptText, at = o.agentsText; return [`one prompt: ${p.caught}/${p.wronglyDismissed}/${p.falseAlarms}/${p.toHuman}, text ${t.caught}/${t.wronglyDismissed}/${t.falseAlarms}/${t.toHuman}`, README.includes(`It catches ${p.caught} of ${p.positives} recalled items, misses ${p.wronglyDismissed}, raises ${p.falseAlarms} false alarms and leaves ${p.toHuman} unsure`) && README.includes(`(${t.caught} caught, ${t.wronglyDismissed} missed, ${t.falseAlarms} false alarms, ${t.toHuman} unsure, against ${at.caught} / ${at.wronglyDismissed} / ${at.falseAlarms} / ${at.toHuman})`) && EVAL.includes(`${p.caught} caught, ${p.wronglyDismissed} missed`) && SUB.includes(`${p.caught} caught, ${p.wronglyDismissed} missed`)] as [string, boolean]; })(),
    [`repeatability ${rp.agreeAllThree}/${rp.pairs} in all three runs, ${rp.agreeRun1Run2} between re-runs`, README.includes(`all three runs for ${rp.agreeAllThree} of ${rp.pairs}`) && README.includes(`between the two re-runs for ${rp.agreeRun1Run2}`) && read("eval/EVAL.md").includes(`all three runs for ${rp.agreeAllThree} of ${rp.pairs} pairs, ${rp.agreeRun1Run2} between the two re-runs`)],
  ];
}

for (const [what, ok] of claims) console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
const bad = claims.filter(([, ok]) => !ok).length;
console.log(`${claims.length - bad}/${claims.length} claims match the committed results`);
process.exit(bad ? 1 : 0);
