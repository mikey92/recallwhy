// What each part of RecallWhy adds, on the same 322 recall/SKU pairs, from the committed results only (no model call):
// the same model alone (eval/one-prompt.ts), the agents with the judge's first answer standing (no Auditor loop),
// the agents with the judge off (rules, Cartographer), and the full system. The dangerous error is a recalled item
// dismissed; its rate gets a Wilson 95% interval.   npx tsx eval/ladder.ts → eval/results/ladder.json
import { readFileSync, writeFileSync } from "node:fs";

type Row = { recall: string; sku: string; basis: string; label: string; final: string };
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const ultra: { rows: Row[] } = json("eval/results/meterless-nvidia_nemotron-3-ultra-550b-a55b.json");
const first: Record<string, string> = json("eval/results/meterless-nvidia_nemotron-3-ultra-550b-a55b-first-answers.json").firstAnswers;
const one: { rows: (Row & { agents?: string })[] } = json("eval/results/one-prompt-nvidia_nemotron-3-ultra-550b-a55b.json");
const rules: { rows: Row[] } = json("eval/results/none-none-map-nvidia_nemotron-3-ultra-550b-a55b.json");
const noCarto: { rows: Row[] } = json("eval/results/none-none-no-cartographer.json");

export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (!n) return [0, 0];
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}
function score(rows: Row[], get: (r: Row) => string) {
  const pos = rows.filter((r) => r.label === "same");
  const missed = pos.filter((r) => get(r) === "not-this").length;
  const [lo, hi] = wilson(missed, pos.length);
  return { pairs: rows.length, positives: pos.length, caught: pos.filter((r) => get(r) === "same").length, missed, falseAlarms: rows.filter((r) => r.label === "not-this" && get(r) === "same").length,
    toHuman: rows.filter((r) => get(r) === "unsure").length, missRate: +(missed / pos.length).toFixed(4), missRate95: [+lo.toFixed(4), +hi.toFixed(4)] };
}
const out = {
  note: "Same 322 pairs. Missed = a recalled item dismissed (the dangerous error), with a Wilson 95% interval on its rate. The ground truth (data/synthetic/eval/ground_truth.csv) was last changed in commit 17b8d67 (25 Oct 13:49 UTC), before the Ultra run started (25 Oct 16:41 UTC); labels follow a fixed rule: an item built from the notice, or whose barcode the notice prints.",
  ladder: [
    { setup: "No Cartographer, judge off (barcodes joined as written, rules only)", ...score(noCarto.rows, (r) => r.final) },
    { setup: "Cartographer + model-proposed barcode rules, judge off", ...score(rules.rows, (r) => r.final) },
    { setup: "Nemotron 3 Ultra alone, one prompt per case (no agents)", ...score(one.rows, (r) => r.final) },
    { setup: "Agents without the Auditor loop (the judge's first answer stands)", ...score(ultra.rows, (r) => (r.basis === "text" ? first[`${r.recall} ${r.sku}`] ?? r.final : r.final)) },
    { setup: "Full system: Cartographer + Nemotron 3 Ultra judge + Auditor", ...score(ultra.rows, (r) => r.final) },
  ],
};
writeFileSync("eval/results/ladder.json", JSON.stringify(out, null, 2) + "\n");
for (const l of out.ladder) console.log(`${l.setup}: caught ${l.caught}, missed ${l.missed} (${(l.missRate95[0] * 100).toFixed(1)}–${(l.missRate95[1] * 100).toFixed(1)}%), false alarms ${l.falseAlarms}, to a person ${l.toHuman}`);
