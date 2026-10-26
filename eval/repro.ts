// Judge repeatability: the same subset of recall/SKU pairs run again with Nemotron 3 Ultra through Nightshift
// (eval/run.ts --recalls, twice), compared pair by pair with each other and with the committed full run.
//   npx tsx eval/repro.ts <run1.json> <run2.json>   → eval/results/repro.json
import { readFileSync, writeFileSync } from "node:fs";

interface Row { recall: string; sku: string; basis: string; label: string; final: string }
const load = (f: string): Row[] => JSON.parse(readFileSync(f, "utf8")).rows;
const [a, b] = process.argv.slice(2).map(load);
const full = new Map(load("eval/results/meterless-nvidia_nemotron-3-ultra-550b-a55b.json").map((r) => [`${r.recall}|${r.sku}`, r]));
const key = (r: Row) => `${r.recall}|${r.sku}`;
const bMap = new Map(b.map((r) => [key(r), r]));
const pairs = a.filter((r) => bMap.has(key(r)) && full.has(key(r)));
const agree = (x: (r: Row) => string, y: (r: Row) => string) => pairs.filter((r) => x(r) === y(r)).length;
const f1 = (r: Row) => r.final, f2 = (r: Row) => bMap.get(key(r))!.final, f0 = (r: Row) => full.get(key(r))!.final;
const allThree = pairs.filter((r) => f1(r) === f2(r) && f2(r) === f0(r)).length;
const dangerous = (f: (r: Row) => string) => pairs.filter((r) => r.label === "same" && f(r) === "not-this").length;
const out = {
  note: "Final decision per pair after the Investigator ⇄ Auditor loop; three runs of Nemotron 3 Ultra on the same pairs (the committed full run and two re-runs of the subset).",
  pairs: pairs.length, covered: pairs.filter((r) => r.label === "same").length,
  agreeRun1Run2: agree(f1, f2), agreeRun1Full: agree(f1, f0), agreeRun2Full: agree(f2, f0), agreeAllThree: allThree,
  wronglyDismissed: { full: dangerous(f0), run1: dangerous(f1), run2: dangerous(f2) },
  differences: pairs.filter((r) => !(f1(r) === f2(r) && f2(r) === f0(r))).map((r) => ({ recall: r.recall, sku: r.sku, label: r.label, full: f0(r), run1: f1(r), run2: f2(r) })),
};
writeFileSync("eval/results/repro.json", JSON.stringify(out, null, 2) + "\n");
console.log(`${out.pairs} pairs (${out.covered} covered): the same final decision in all three runs for ${allThree}; run 1 vs 2 ${out.agreeRun1Run2}; wrongly dismissed full/run1/run2 ${dangerous(f0)}/${dangerous(f1)}/${dangerous(f2)}`);
