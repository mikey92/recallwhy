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
// Our item titles from the pull list (column "item"), when the packet predates its `items` field.
function withItems(p, csvFile) {
  if (p.items || !existsSync(csvFile)) return p;
  const rows = readFileSync(csvFile, "utf8").trim().split("\n").slice(1).map((l) => (l.match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')));
  return { ...p, items: [...new Set(rows.map((r) => r[6]).filter(Boolean))] };
}
const pk = "example_1";
const packets = {
  runId: JSON.parse(readFileSync(`${ex}/${pk}.json`, "utf8")).runId,
  packets: existsSync(`${ex}/${pk}/actions`) ? readdirSync(`${ex}/${pk}/actions`).filter((c) => existsSync(`${ex}/${pk}/actions/${c}/packet.json`)).map((c) => withItems(JSON.parse(readFileSync(`${ex}/${pk}/actions/${c}/packet.json`, "utf8")), `${ex}/${pk}/actions/${c}/pull-list.csv`)) : [],
};
const data = { runs, queue, packets, note: "Recorded live runs. First decide the matches the Auditor would not settle, then approve a packet. The queue is the one left after example_3; the run \"After a reviewer decides\" on the project page shows the next run following such decisions. Nothing is sent; your clicks stay in this browser (in the product a decision goes into H-MEM and the next run follows it)." };
const html = readFileSync("src/review.html", "utf8").replace("<script>", `<script>window.RW_STATIC = ${JSON.stringify(data).replace(/</g, "\\u003c")};</script>\n<script>`);
writeFileSync(`${out}/review.html`, html);
console.log(`review.html: ${queue.length} queued case(s), ${packets.packets.length} packet(s), ${Object.keys(runs).length} run(s)`);

// The project page's "Which Nemotron model handled each call" table, from the llm events of every live
// example trace: the model the agent asked for, the model Nightshift routed to, the task, how many calls,
// and one Nightshift receipt id per row (each call's own receipt is in the trace).
const task = (p) => p.replace(/\s*\(attempt \d+\)/, "").replace(/\s+(case-\S+|fda:\S+|cpsc:\S+|NW-\d+ vs \S+)/g, "").replace(/\s+(for\s+)?SUP\d+/g, "").replace(/\s+NW-\d+/g, "").replace(/\s+\d+\/\d+(?=\s|\)|$)/, "").trim();
const rows = new Map();
for (const d of readdirSync(ex).filter((d) => existsSync(`${ex}/${d}/trace.jsonl`) && !/sample_mode/.test(d))) {
  for (const l of readFileSync(`${ex}/${d}/trace.jsonl`, "utf8").trim().split("\n")) {
    const e = JSON.parse(l);
    if (e.kind !== "llm" || String(e.output).startsWith("ERROR")) continue;
    const k = `${e.agent}|${task(e.purpose)}|${e.model}|${e.served_model ?? ""}`;
    const r = rows.get(k) ?? { agent: e.agent, task: task(e.purpose), model: String(e.model).replace(/^meterless:/, ""), served: e.served_model ?? "", n: 0, ms: [], receipt: e.receipt };
    r.n++; r.ms.push(e.ms); rows.set(k, r);
  }
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)] ?? 0; };
const list = [...rows.values()].sort((a, b) => a.model.localeCompare(b.model) || b.n - a.n);
const table = `<h2>Which Nemotron model handled each call</h2><p><small>Every model call of the live example runs, from their traces: the model the agent asked Meterless Nightshift for, the model Nightshift reports it routed to, and one Nightshift receipt per row. Narrow tasks whose output is checked word for word (lot codes must appear in the notice) go to the small Nemotron 3.5 Lightning; judging, briefs, the Auditor's check and the digest go to Nemotron 3 Ultra.</small></p>
<div class="tbl"><table><thead><tr><th>Agent</th><th>Task</th><th>Asked for</th><th>Served by (Nightshift)</th><th>Calls</th><th>Median</th><th>A receipt</th></tr></thead><tbody>${list.map((r) => `<tr><td>${esc(r.agent)}</td><td>${esc(r.task)}</td><td><code>${esc(r.model)}</code></td><td><code>${esc(r.served)}</code></td><td class="n">${r.n}</td><td class="n">${(med(r.ms) / 1000).toFixed(1)} s</td><td><code>${esc(r.receipt ?? "")}</code></td></tr>`).join("")}</tbody></table></div>`;
if (existsSync(`${out}/index.html`)) {
  const idx = readFileSync(`${out}/index.html`, "utf8");
  if (idx.includes("<!-- MODELS -->")) { writeFileSync(`${out}/index.html`, idx.replace("<!-- MODELS -->", table)); console.log(`index.html: ${list.length} model-call rows`); }
}
