// Re-runs the evaluations that need no model (rules only, no Cartographer, map only on demand) and checks
// that every pair's verdict, the scores and the learned supplier rules match the committed results.
// npm run check:repro   (CI runs it on every push)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const runs: [string, string[]][] = [["none-none", []], ["none-none-no-cartographer", ["--no-cartographer"]], ["none-none-map-on-demand", ["--map-on-demand"]]];
type Result = { all: unknown; textOnly: unknown; rows: { recall: string; sku: string; final: string }[]; cartographerRules?: { supplier: string; transform: string; rows: number }[] };
const comparable = (r: Result) => JSON.stringify({
  all: r.all, textOnly: r.textOnly,
  rows: r.rows.map((x) => `${x.recall} ${x.sku} ${x.final}`).sort(),
  rules: (r.cartographerRules ?? []).map((x) => `${x.supplier} ${x.transform} ${x.rows}`).sort(),
});

let bad = 0;
for (const [tag, flags] of runs) {
  const file = `eval/results/${tag}.json`;
  const committed: Result = JSON.parse(execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" }));
  execFileSync("npx", ["tsx", "eval/run.ts", "--provider", "none", "--model", "none", ...flags], { stdio: "ignore", env: { ...process.env, SAMPLE_MODE: "true" } });
  const fresh: Result = JSON.parse(readFileSync(file, "utf8"));
  const same = comparable(fresh) === comparable(committed);
  console.log(`${same ? "ok  " : "FAIL"} ${tag}: ${fresh.rows.length} pairs re-run, scores, verdicts and rules ${same ? "match" : "differ from"} the committed result`);
  if (!same) bad++;
  execFileSync("git", ["checkout", "--", file]);
}
process.exit(bad ? 1 : 0);
