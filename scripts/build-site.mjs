// Writes <out>/review.html for the public site: the review screen (src/review.html) on the recorded
// live runs in examples/output/. The queue is the one recorded after example_3
// (examples/output/review-queue.json); the action packets are example_1's. Decisions and approvals
// stay in the visitor's browser; nothing is recorded or sent. Plain Node, no dependencies.
//   node scripts/build-site.mjs _site
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";

const out = process.argv[2] ?? "_site";
const ex = "examples/output";
const runs = {};
for (const f of readdirSync(ex).filter((f) => f.endsWith(".json") && f !== "review-queue.json")) {
  const runId = JSON.parse(readFileSync(`${ex}/${f}`, "utf8")).runId;
  if (runId) runs[runId] = `examples/${f.replace(/\.json$/, "")}`;
}
const queue = existsSync(`${ex}/review-queue.json`) ? JSON.parse(readFileSync(`${ex}/review-queue.json`, "utf8")) : [];
const pk = "example_1";
const packets = {
  runId: JSON.parse(readFileSync(`${ex}/${pk}.json`, "utf8")).runId,
  packets: existsSync(`${ex}/${pk}/actions`) ? readdirSync(`${ex}/${pk}/actions`).filter((c) => existsSync(`${ex}/${pk}/actions/${c}/packet.json`)).map((c) => JSON.parse(readFileSync(`${ex}/${pk}/actions/${c}/packet.json`, "utf8"))) : [],
};
const data = { runs, queue, packets, note: "Demo on recorded live runs (Zetaris + Nemotron 3 Ultra): the queue the agents left after example_3 and the action packets of example_1. Your decisions and approvals stay in this browser; nothing is recorded or sent. In the product, a decision goes into H-MEM with high trust and the next run follows it." };
const html = readFileSync("src/review.html", "utf8").replace("<script>", `<script>window.RW_STATIC = ${JSON.stringify(data).replace(/</g, "\\u003c")};</script>\n<script>`);
writeFileSync(`${out}/review.html`, html);
console.log(`review.html: ${queue.length} queued case(s), ${packets.packets.length} packet(s), ${Object.keys(runs).length} run(s)`);
