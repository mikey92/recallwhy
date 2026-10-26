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
packets.packets = packets.packets.map((p) => ({ ...p, files: p.files.map((f) => f.replace(/\.(md|csv)$/, ".html")) }));
const data = { runs, queue, packets, note: "Recorded live runs of 26 Oct. First decide the two matches the agents could not settle, then approve a packet. Nothing is sent; your clicks stay in this browser. (In the product, a decision goes into the agents' memory and the next run follows it: see \"After a reviewer decides\" on the project page.)" };
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

// GitHub Pages serves .md and .csv as downloads and has no directory index, so every packet file, digest and
// brief in the copied examples gets an HTML page next to it, each run's actions/ gets an index, and the
// report's links point at the HTML. The report also gets a bar back to the project page, this run's replay
// and the review screen. Only the static copy changes; examples/output stays as the runs wrote it.
const page = (title, body, back) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>:root{color-scheme:light dark}body{margin:0;font:16px/1.55 -apple-system,system-ui,sans-serif;background:#f7f7f5;color:#1d1d1f}main{max-width:860px;margin:0 auto;padding:28px 20px 60px}a{color:#1d4ed8}pre,code{font:14px/1.5 ui-monospace,Menlo,monospace}table{border-collapse:collapse;font-size:14px;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #ddd}.top{font-size:14px;margin-bottom:18px}blockquote{margin:6px 0;padding:4px 12px;border-left:3px solid #ccc;color:#555}@media (prefers-color-scheme:dark){body{background:#141414;color:#eee}a{color:#93c5fd}th,td{border-color:#333}blockquote{color:#aaa}}</style></head><body><main><p class="top">${back}</p>${body}</main></body></html>`;
const mdHtml = (src) => {
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/(^|\s)_([^_]+)_(?=\s|$|[.,])/g, "$1<i>$2</i>").replace(/\*([^*]+)\*/g, "<i>$1</i>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, h) => `<a href="${h.replace(/\.md$/, ".html").replace(/^\.\.\/actions\//, "../actions/").replace(/\.csv$/, ".html")}">${t}</a>`);
  const out = []; let list = false;
  for (const line of src.split("\n")) {
    if (/^\s*[-*] /.test(line)) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    const h = line.match(/^(#{1,4}) (.*)/);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (/^> /.test(line)) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
};
const csvRows = (text) => text.trim().split("\n").map((l) => (l.match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')).filter((_, i, a) => i < a.length - 1 || a.length === 1 || _ !== ""));
const exOut = `${out}/examples`;
if (existsSync(exOut)) for (const run of readdirSync(exOut)) {
  const dir = `${exOut}/${run}`;
  const back = `<a href="../../index.html">Project page</a> · <a href="report.html">Report of this run</a>`;
  if (existsSync(`${dir}/digest.md`)) writeFileSync(`${dir}/digest.html`, page(`Weekly digest · ${run}`, mdHtml(readFileSync(`${dir}/digest.md`, "utf8")), back));
  if (existsSync(`${dir}/briefs`)) for (const f of readdirSync(`${dir}/briefs`).filter((f) => f.endsWith(".md")))
    writeFileSync(`${dir}/briefs/${f.replace(/\.md$/, ".html")}`, page(f, mdHtml(readFileSync(`${dir}/briefs/${f}`, "utf8")), `<a href="../../../index.html">Project page</a> · <a href="../report.html">Report of this run</a>`));
  const cases = existsSync(`${dir}/actions`) ? readdirSync(`${dir}/actions`) : [];
  for (const c of cases) {
    const cd = `${dir}/actions/${c}`, cback = `<a href="../../../../index.html">Project page</a> · <a href="../../report.html#${esc(c)}">This case in the report</a> · <a href="../index.html">All action packets of this run</a>`;
    for (const f of readdirSync(cd)) {
      if (f.endsWith(".md")) writeFileSync(`${cd}/${f.replace(/\.md$/, ".html")}`, page(`${f} · ${c}`, mdHtml(readFileSync(`${cd}/${f}`, "utf8")), cback));
      if (f.endsWith(".csv")) { const r = csvRows(readFileSync(`${cd}/${f}`, "utf8")); writeFileSync(`${cd}/${f.replace(/\.csv$/, ".html")}`, page(`${f} · ${c}`, `<h1>${f.startsWith("fda-traceability") ? "FDA traceability records (FSMA 204 sortable spreadsheet)" : "Pull list"} · ${esc(c)}</h1>${f.startsWith("fda-traceability") ? "<p>One row per record we hold for the affected lots: the supplier's shipment into our distribution center (its ship notice) and the receipt at each store that still has stock (ERP; quantity on hand, since the ERP does not keep the quantity received). Each row names the query that produced it.</p>" : ""}<p><a href="${esc(f)}">Download ${esc(f)}</a></p><div style="overflow-x:auto"><table><thead><tr>${r[0].map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${r.slice(1).map((row) => `<tr>${row.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`, cback)); }
    }
  }
  if (cases.length) writeFileSync(`${dir}/actions/index.html`, page(`Action packets · ${run}`, `<h1>Action packets (drafts, not sent)</h1><ul>${cases.map((c) => { const fs = readdirSync(`${dir}/actions/${c}`).filter((f) => /\.(md|csv)$/.test(f)); return `<li><b>${esc(c)}</b>: ${fs.map((f) => `<a href="${esc(c)}/${esc(f.replace(/\.(md|csv)$/, ".html"))}">${esc(f.replace(/\.(md|csv)$/, ""))}</a>`).join(" · ")}</li>`; }).join("")}</ul>`, back));
  if (existsSync(`${dir}/report.html`)) {
    let r = readFileSync(`${dir}/report.html`, "utf8");
    r = r.replace(/href="digest\.md"/g, 'href="digest.html"').replace(/href="actions\/"/g, 'href="actions/index.html"')
      .replace(/href="(actions\/[^"]+)\.(md|csv)"/g, 'href="$1.html"');
    const nav = `<nav style="font-size:14px;margin:0 0 6px"><a href="../../index.html">Project page</a> · <a href="../../replay.html?run=${esc(run)}">Replay this run</a> · <a href="../../review.html">Review screen</a></nav>`;
    if (!r.includes("Replay this run")) r = r.replace("<header>", `<header>${nav}`);
    writeFileSync(`${dir}/report.html`, r);
  }
}
