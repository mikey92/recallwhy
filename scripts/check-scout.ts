// Runs the official Meterless Scout Intent eval harness (conformance/scout-intent/evals/runner/index.ts, copied
// unchanged from Meterless@1742dec, blob ids in conformance/upstream-blobs.txt) against RecallWhy's Scout
// (src/scout/index.ts), and prints its metrics and PASS/FAIL gate against evals/config/thresholds.yaml.
//   npm run check:scout            # full suite
//   npm run check:scout -- injection   # one slice of the corpus (intent | injection | multi-intent)
// The runner imports the `yaml` package; scripts/yaml-register.mjs resolves that import to scripts/yaml-subset.ts.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const base = "conformance/scout-intent";
const blob = (path: string) => { const b = readFileSync(path); return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"); };
const want = readFileSync("conformance/upstream-blobs.txt", "utf8").trim().split("\n").map((l) => l.split(" ")).filter(([e]) => e === "scout-intent");
const diff = want.filter(([, id, f]) => { try { return blob(`${base}/${f}`) !== id; } catch { return true; } }).map(([, , f]) => f);
console.log(`${diff.length ? "FAIL" : "ok  "} scout-intent: ${want.length} harness files identical to Meterless@1742dec${diff.length ? ` (differ: ${diff.join(", ")})` : ""}`);

const r = spawnSync(process.execPath, ["--import", "tsx", "--import", "./scripts/yaml-register.mjs", `${base}/evals/runner/index.ts`, ...process.argv.slice(2)], {
  env: { ...process.env, SCOUT_IMPL: resolve("src/scout/index.ts") }, encoding: "utf8",
});
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);
console.log(`${r.status === 0 ? "PASS" : "FAIL"} scout-intent: official eval gate (thresholds.yaml), runner exit ${r.status}`);
process.exit(diff.length || r.status !== 0 ? 1 : 0);
