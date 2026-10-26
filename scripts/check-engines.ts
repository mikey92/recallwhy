// The three Meterless engines mounted in src/engines/ are the upstream reference code: every file is
// byte-identical to Meterless/Meterless@1742dec (git blob ids in conformance/upstream-blobs.txt), and each
// passes its upstream conformance suite (conformance/<engine>/runner.ts, copied unchanged).
//   npm run check:engines
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const blob = (path: string) => { const b = readFileSync(path); return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"); };
const upstream = readFileSync("conformance/upstream-blobs.txt", "utf8").trim().split("\n").map((l) => l.split(" "));
let bad = 0;
for (const engine of ["hmem", "markovian", "world-model"]) {
  const want = upstream.filter(([e]) => e === engine);
  const ours = readdirSync(`src/engines/${engine}`).filter((f) => f.endsWith(".ts"));
  const diff = want.filter(([, id, f]) => !ours.includes(f) || blob(`src/engines/${engine}/${f}`) !== id).map(([, , f]) => f);
  const extra = ours.filter((f) => !want.some(([, , w]) => w === f));
  const same = !diff.length && !extra.length;
  if (!same) bad++;
  console.log(`${same ? "ok  " : "FAIL"} ${engine}: ${want.length} files identical to Meterless@1742dec${same ? "" : ` (differ: ${diff.join(", ") || "-"}; not upstream: ${extra.join(", ") || "-"})`}`);
  const envName = { hmem: "HMEM_IMPL", markovian: "MARKOVIAN_IMPL", "world-model": "WORLD_MODEL_IMPL" }[engine]!;
  const r = spawnSync(process.execPath, ["--import", "tsx", `conformance/${engine}/runner.ts`], { env: { ...process.env, [envName]: resolve(`src/engines/${engine}/index.ts`) }, encoding: "utf8" });
  const summary = (r.stdout.match(/(\d+)\/(\d+) checks passed/) ?? [])[0] ?? "no summary";
  if (r.status !== 0) bad++;
  console.log(`${r.status === 0 ? "ok  " : "FAIL"} ${engine}: upstream conformance suite, ${summary}`);
}
process.exit(bad ? 1 : 0);
