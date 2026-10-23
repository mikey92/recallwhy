// Renders out/<run>/report.html from the run's own files: result.json, briefs/*.md
// and the trace. Nothing here computes or changes a verdict; it only displays.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

interface Ev { seq: number; kind: string; agent: string; to?: string; text?: string; caseId?: string; code?: string; detail?: string; sqlId?: string; purpose?: string; engine?: string; rows?: number; ms?: number; model?: string; served_model?: string; output?: string; finding?: unknown }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function md(src: string): string {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*([^*]+)\*/g, "<i>$1</i>").replace(/_(run [^_]+|why-paragraph[^_]+)_/g, "<i>$1</i>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>').replace(/\[(E\d+)\]/g, '<span class="cite">$1</span>');
  const out: string[] = []; let list = false;
  for (const line of src.split("\n")) {
    if (/^- /.test(line)) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(line.slice(2))}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    if (/^# /.test(line)) out.push(`<h2>${inline(line.slice(2))}</h2>`);
    else if (/^## /.test(line)) out.push(`<h3>${inline(line.slice(3))}</h3>`);
    else if (/^> /.test(line)) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push("</ul>");
  return out.join("\n");
}

const COLOR: Record<string, string> = { "act-now": "#c0392b", notify: "#d35400", "needs-human": "#8e44ad", "no-exposure": "#2c7a7b", "not-ours": "#6b7280" };

export function renderReport(outDir: string): string {
  const res = JSON.parse(readFileSync(`${outDir}/result.json`, "utf8"));
  const traceFile = `logs/trace-${res.runId}.jsonl`;
  const evs: Ev[] = existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const order = ["act-now", "notify", "needs-human", "no-exposure", "not-ours"];
  const cases = [...res.cases].sort((a: { verdict: string }, b: { verdict: string }) => order.indexOf(a.verdict) - order.indexOf(b.verdict));
  // Trace slice per case: events between the Investigator opening it and the Briefer finishing it.
  const slices = new Map<string, Ev[]>();
  let cur: string | undefined;
  for (const e of evs) {
    const m = e.kind === "msg" && e.agent === "Investigator" && e.text?.match(/^opening (\S+):/);
    if (m) cur = m[1].replace(/:$/, "");
    if (cur) (slices.get(cur) ?? slices.set(cur, []).get(cur)!).push(e);
  }
  const line = (e: Ev) => {
    if (e.kind === "msg") return `<div class="ev msg a-${e.agent}"><b>${e.agent}</b> → ${esc(e.to ?? "")}: ${esc(e.text ?? "")}</div>`;
    if (e.kind === "critique") return `<div class="ev crit"><b>Auditor objection</b> ${esc(e.code ?? "")}: ${esc(e.detail ?? "")}</div>`;
    if (e.kind === "sql") return `<div class="ev sql"><b>${e.agent}</b> SQL <code>${e.sqlId}</code> [${e.engine}] ${esc(e.purpose ?? "")} — ${e.rows} rows, ${e.ms} ms</div>`;
    if (e.kind === "llm") return `<div class="ev llm"><b>${e.agent}</b> ${esc(e.served_model ? `${e.model} ⇒ ${e.served_model}` : (e.model ?? ""))}: ${esc(e.purpose ?? "")} → <i>${esc(String(e.output ?? "").slice(0, 140))}</i></div>`;
    if (e.kind === "memory.read" || e.kind === "memory.write") return `<div class="ev mem"><b>${e.agent}</b> H-MEM ${e.kind.split(".")[1]}</div>`;
    if (e.kind === "escalate") return `<div class="ev crit"><b>Escalated to human</b></div>`;
    return "";
  };
  const counts = cases.reduce((a: Record<string, number>, c: { verdict: string }) => ((a[c.verdict] = (a[c.verdict] ?? 0) + 1), a), {});
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RecallWhy run ${esc(res.runId)}</title><style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1f;--mute:#6b7280;--line:#e5e5e0}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--ink:#eee;--mute:#9aa0a6;--line:#333}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif}
header{padding:28px 32px 8px}h1{margin:0;font-size:26px}.sub{color:var(--mute)}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.chip{padding:4px 10px;border-radius:99px;color:#fff;font-weight:600;font-size:13px}
main{padding:8px 32px 40px;display:grid;gap:18px}
.case{background:var(--card);border:1px solid var(--line);border-left:6px solid;border-radius:10px;display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr)}
.brief{padding:6px 22px 14px}.brief h2{font-size:18px;margin:14px 0 4px}.brief h3{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:16px 0 4px}
blockquote{margin:6px 0;padding:4px 10px;border-left:3px solid var(--line);color:var(--mute)}
.cite{font-size:11px;background:#2563eb22;color:#2563eb;border-radius:4px;padding:0 4px}
.trace{border-left:1px solid var(--line);padding:12px 14px;font-size:12.5px;max-height:620px;overflow:auto}
.ev{padding:3px 0;border-bottom:1px dashed var(--line)}.crit{color:#b91c1c}.sql{color:var(--mute)}.llm{color:#15803d}.mem{color:#7c3aed}
code{font-size:12px}ul{margin:4px 0;padding-left:20px}
@media (max-width:820px){.case{grid-template-columns:1fr}.trace{border-left:0;border-top:1px solid var(--line)}main,header{padding-left:16px;padding-right:16px}}
</style></head><body><header><h1>RecallWhy</h1>
<div class="sub">Run ${esc(res.runId)} · engine <b>${esc(res.engine)}</b>${res.engine === "duckdb-sample" ? " (SAMPLE — Zetaris not used)" : ""} · model <b>${esc(res.model)}</b> · ${res.scanned} recalls since ${esc(res.since)} → ${cases.length} cases</div>
<div class="chips">${Object.entries(counts).map(([k, v]) => `<span class="chip" style="background:${COLOR[k]}">${k} ${v}</span>`).join("")}</div></header><main>
${cases.map((c: { id: string; verdict: string }) => `<section class="case" style="border-left-color:${COLOR[c.verdict]}"><div class="brief">${md(readFileSync(`${outDir}/briefs/${c.id}.md`, "utf8"))}</div>
<div class="trace"><b>How the agents got here</b>${(slices.get(c.id) ?? []).map(line).join("")}</div></section>`).join("\n")}
</main></body></html>`;
  writeFileSync(`${outDir}/report.html`, html);
  return `${outDir}/report.html`;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(renderReport(process.argv[2]));
