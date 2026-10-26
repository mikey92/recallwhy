// Renders out/<run>/report.html from the run's own files: result.json, briefs/*.md
// and the trace. Nothing here computes or changes a verdict; it only displays.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { storeMapSection, storePoints, loadStores, caseStates, loadStatePaths } from "./store-map.ts";

interface Ev { seq: number; kind: string; agent: string; to?: string; text?: string; caseId?: string; code?: string; detail?: string; sqlId?: string; purpose?: string; engine?: string; rows?: number; ms?: number; model?: string; served_model?: string; output?: string; finding?: unknown; checks?: string[]; learned?: Learned[]; since?: string }
interface Learned { supplier?: string; transform?: string; rows?: number; sqlId?: string; proposedBy?: string }

/** One banner line: `kind` picks the chip colour, `text` is built only from fields of this case's trace events. */
export interface Highlight { kind: "map" | "human" | "audit" | "stats"; text: string }

/**
 * "What the agents did" for one case, derived from that case's trace slice alone. Every number and name is read
 * from an event (Cartographer `learned`, Auditor `checks`/critiques, Investigator messages, sql/llm counts);
 * nothing is hardcoded per case. Returns one to four lines; an empty slice gives none.
 */
export function whatTheAgentsDid(slice: Ev[]): Highlight[] {
  const out: Highlight[] = [];
  const msgs = slice.filter((e) => e.kind === "msg");
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];

  // 1. Map corrections the Cartographer made mid-case, each proven by SQL over every ship notice of that supplier.
  for (const m of msgs.filter((e) => e.agent === "Cartographer" && e.to === "Auditor")) {
    const shape = m.text?.match(/(SUP\d+) sends (\d+)-digit barcodes against our (\d+)-digit UPCs/);
    const all = m.text?.match(/holds for all (\d+) of its ship notices/);
    const learned = m.learned?.length ? m.learned : shape ? [{ supplier: shape[1], transform: undefined, rows: all ? Number(all[1]) : undefined }] : [];
    for (const l of learned) {
      const n = l.rows ?? (all ? Number(all[1]) : undefined);
      const proof = n !== undefined ? `proven by SQL on ${n}/${n} ship notices` : "proven by SQL";
      const digits = shape && shape[1] === l.supplier ? ` (${shape[2]}-digit barcodes vs our ${shape[3]}-digit UPCs)` : "";
      if (l.proposedBy || l.transform === "proposed") {
        const by = l.proposedBy ?? slice.find((e) => e.kind === "llm" && e.agent === "Cartographer" && /propose a barcode transform/.test(e.purpose ?? ""))?.served_model;
        out.push({ kind: "map", text: `Model-proposed transform for ${l.supplier ?? "a supplier"}${digits}${by ? `, by ${by.replace(/^[^:/]+:/, "")}` : ""} — ${proof}` });
      } else {
        out.push({ kind: "map", text: `Map corrected mid-run: ${l.supplier ?? "a supplier"}${l.transform ? ` ${l.transform}` : ""}${digits} — ${proof}` });
      }
    }
  }

  for (const m of msgs.filter((e) => e.agent === "Cartographer" && e.to === "Auditor")) {
    const w = m.text?.match(/written back to Zetaris as (\S+) and read back: ([^;.]+)/);
    const dq = m.text?.match(/Zetaris data-quality rule (\S+) on \S+: (\d+)\/(\d+) rows valid, (\d+) invalid/);
    if (w) out.push({ kind: "map", text: `Written back to Zetaris as ${w[1]}, read back in a separate query: ${w[2]}${dq ? `; Zetaris data-quality rule ${dq[1]}: ${dq[2]}/${dq[3]} valid` : ""}` });
  }

  // 2. Memory: a human's decision was followed, or an earlier run's decision reused.
  for (const m of msgs.filter((e) => e.agent === "Investigator")) {
    const h = m.text?.match(/following human decision (mem-\d+)/);
    if (h) out.push({ kind: "human", text: `Followed a human decision (${h[1]})` });
    const r = m.text?.match(/reusing decision (mem-\d+) from run:(\S+)/);
    if (r) out.push({ kind: "human", text: `Reused decision ${r[1]} from run ${r[2]}` });
  }

  // 3. The Auditor: objections and escalation, or the checks it passed (live notice re-read, numbers re-derived).
  const crit = slice.filter((e) => e.kind === "critique");
  const esc = slice.find((e) => e.kind === "escalate");
  const rounds = msgs.map((e) => e.text?.match(/escalated after (\d+) rounds/)?.[1]).find(Boolean);
  if (crit.length) {
    const codes = uniq(crit.map((e) => e.code).filter(Boolean)).join(", ");
    out.push({ kind: "audit", text: `Auditor blocked ${crit.length} claim${crit.length === 1 ? "" : "s"}${codes ? ` (${codes})` : ""}${esc ? ` → escalated to a human${rounds ? ` after ${rounds} rounds` : ""}` : ""}` });
  } else if (esc) out.push({ kind: "audit", text: "Escalated to a human" });
  const approved = msgs.filter((e) => e.agent === "Auditor" && /approved/.test(e.text ?? "")).at(-1);
  // An undecided pair passes the Auditor's checks but still goes to a person; say that, not "approved".
  const undecided = msgs.some((e) => e.agent === "Investigator" && /round \d+: needs-human/.test(e.text ?? ""));
  if (undecided && !crit.length && !esc) {
    const why = slice.map((e) => (e as Ev & { predicate?: string; value?: unknown }))
      .filter((e) => e.kind === "world.write" && e.predicate === "match_decision" && typeof e.value === "string")
      .map((e) => String(e.value).match(/unsure — (.+)$/)?.[1]).find(Boolean);
    out.push({ kind: "audit", text: `Undecided → sent to a reviewer${why ? `: ${why}` : ""}` });
  } else if (approved) {
    const checks = approved.checks ?? [];
    const extras = [
      checks.some((c) => /live notice/.test(c)) ? "live notice re-read" : "",
      checks.some((c) => /re-derived independently/.test(c)) ? "exposure re-derived independently" : "",
      checks.some((c) => /human decision .* respected/.test(c)) ? "human decision respected" : "",
    ].filter(Boolean);
    out.push({ kind: "audit", text: `Auditor approved after ${checks.length} check${checks.length === 1 ? "" : "s"}${extras.length ? ` (${extras.join(", ")})` : ""}` });
  }

  // 4. Work done: SQL queries by engine, model calls by served model.
  const sqls = slice.filter((e) => e.kind === "sql"), llms = slice.filter((e) => e.kind === "llm");
  const engines = uniq(sqls.map((e) => e.engine).filter(Boolean)).join("/");
  const models = uniq(llms.map((e) => e.served_model ?? e.model).filter(Boolean)).join(", ");
  const parts = [sqls.length ? `${sqls.length} SQL quer${sqls.length === 1 ? "y" : "ies"}${engines ? ` on ${engines}` : ""}` : "", llms.length ? `${llms.length} model call${llms.length === 1 ? "" : "s"}${models ? ` (${models})` : ""}` : "no model calls"].filter(Boolean);
  if (sqls.length || llms.length) out.push({ kind: "stats", text: parts.join(" · ") });

  return out.slice(0, 5);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
function md(src: string): string {
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*([^*]+)\*/g, "<i>$1</i>").replace(/_(run [^_]+|why-paragraph[^_]+)_/g, "<i>$1</i>")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
    // A brief links its packet files relative to briefs/; the report sits one level up.
    .replace(/\[([^\]]+)\]\(\.\.\/(actions\/[\w.:-]+\/[\w.-]+)\)/g, '<a href="$2">$1</a>').replace(/\[(E\d+)\]/g, '<span class="cite">$1</span>');
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

const COLOR: Record<string, string> = { "act-now": "#c0392b", notify: "#c2410c", "needs-human": "#8e44ad", "no-exposure": "#2c7a7b", "not-ours": "#6b7280" };

/** The brief's evidence list folds under its heading (open on the first case): the brief reads first, the citations stay one click away. */
function foldEvidence(html: string, open: boolean): string {
  const at = html.indexOf("<h3>Evidence</h3>");
  if (at < 0) return html;
  const n = (html.slice(at).match(/<li>/g) ?? []).length;
  return `${html.slice(0, at)}<details class="ev-list"${open ? " open" : ""}><summary><h3>Evidence (${n} cited facts)</h3></summary>${html.slice(at + "<h3>Evidence</h3>".length)}</details>`;
}

/** What the Cartographer found before any case: its messages and the facts it wrote, as recorded in the trace. */
function sourceMap(evs: Ev[]): string {
  const carto = evs.filter((e) => e.agent === "Cartographer");
  if (!carto.length) return "";
  const msgs = carto.filter((e) => e.kind === "msg").map((e) => `<li>→ ${esc(e.to ?? "")}: ${esc(e.text ?? "")}</li>`).join("");
  const facts = carto.filter((e) => e.kind === "world.write").map((e) => {
    const f = e as Ev & { about?: string; predicate?: string; value?: unknown; ref?: string };
    return `<li><code>${esc(String(f.about ?? "").replace(/^[^:]+:[^:]+:/, ""))}</code> ${esc(String(f.predicate ?? "").replace(/_/g, " "))}: <b>${esc(typeof f.value === "string" ? f.value : JSON.stringify(f.value))}</b>${f.ref ? ` <span class="sql">(${esc(f.ref)})</span>` : ""}</li>`;
  }).join("");
  const sqls = carto.filter((e) => e.kind === "sql").length;
  return `<section class="map"><details class="srcmap"><summary>Source map: how the Cartographer read the four sources (${sqls} catalog and profiling queries)</summary><ul>${msgs}</ul><ul>${facts}</ul></details></section>`;
}

/** The report's title line: what the safety manager has to act on. */
function headline(cases: { verdict: string }[]): string {
  const on = cases.filter((c) => c.verdict === "act-now" || c.verdict === "notify").length, review = cases.filter((c) => c.verdict === "needs-human").length;
  const parts = [on ? `${on} recall${on === 1 ? "" : "s"} on our shelves` : "no recall on our shelves", ...(review ? [`${review} for a person to decide`] : [])];
  return parts.join(", ");
}

/** `tracePath` overrides the default logs/trace-<runId>.jsonl, e.g. to re-render a committed example from its own trace. */
export function renderReport(outDir: string, tracePath?: string): string {
  const res = JSON.parse(readFileSync(`${outDir}/result.json`, "utf8"));
  const traceFile = tracePath ?? `logs/trace-${res.runId}.jsonl`;
  const evs: Ev[] = existsSync(traceFile) ? readFileSync(traceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  const since = res.since ?? evs.find((e) => e.kind === "run.start")?.since ?? "";
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
  // Banner at the top of each case card: one chip per highlight, spanning both columns; empty when the trace has nothing.
  const banner = (slice: Ev[]) => {
    const hs = whatTheAgentsDid(slice);
    return hs.length ? `<div class="did"><span class="did-h">What the agents did</span>${hs.map((h) => `<span class="hl hl-${h.kind}">${esc(h.text)}</span>`).join("")}</div>` : "";
  };
  const counts = cases.reduce((a: Record<string, number>, c: { verdict: string }) => ((a[c.verdict] = (a[c.verdict] ?? 0) + 1), a), {});
  // One-screen summary for the safety manager, summed from the facts the agents wrote (last value per case).
  const points = storePoints(outDir, cases, evs, loadStores());
  const summary = () => {
    const last = new Map<string, unknown>();
    for (const e of evs as (Ev & { about?: string; predicate?: string; value?: unknown })[]) if (e.kind === "world.write" && e.about?.startsWith("case:") && e.predicate?.startsWith("our_")) last.set(`${e.about.replace(/^case:[^:]+:/, "")}|${e.predicate}`, e.value);
    const acting = cases.filter((c: { verdict: string }) => c.verdict === "act-now" || c.verdict === "notify");
    const sum = (pred: string) => acting.reduce((n: number, c: { id: string }) => n + (Number(last.get(`${c.id}|${pred}`)) || 0), 0);
    const tiles = [
      [sum("our_units_on_hand_in_affected_lots"), "units to pull from shelves"],
      [points.length, points.length === 1 ? "store to pull from" : "stores to pull from"],
      [sum("our_loyalty_customers_who_bought_affected_lots"), "customers to notify (at most)"],
      [cases.filter((c: { verdict: string }) => c.verdict === "needs-human").length, "cases waiting for a reviewer"],
    ] as const;
    return `<div class="tiles">${tiles.map(([n, l]) => `<div class="tile"><b data-n="${n}">${Number(n).toLocaleString("en-US")}</b><span>${l}</span></div>`).join("")}</div>`;
  };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RecallWhy run ${esc(res.runId)}</title><style>
:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--ink:#1d1d1f;--mute:#6b7280;--line:#e5e5e0;--link:#1d4ed8}a{color:var(--link)}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--ink:#eee;--mute:#9aa0a6;--line:#333;--link:#93c5fd}.usmap .d-in{fill:#fca5a5}.usmap .st-named{fill:#5b1a1a}.out{color:#fbbf24}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif}
header{padding:28px 32px 8px}h1{margin:0;font-size:26px}.sub{color:var(--mute)}
.warn{margin:12px 0 0;padding:8px 12px;border-radius:8px;background:#fef3c7;color:#92400e;font-size:14px}@media (prefers-color-scheme:dark){.warn{background:#78350f55;color:#fcd34d}}
.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:16px 0 4px}.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px}.tile b{display:block;font-size:28px;line-height:1.1}.tile span{color:var(--mute);font-size:13px}
@media (max-width:640px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.chip{padding:4px 10px;border-radius:99px;color:#fff;font-weight:600;font-size:13px}
main{padding:8px 32px 40px;display:grid;grid-template-columns:minmax(0,1fr);gap:18px}
.brief,.map,.trace{min-width:0;overflow-wrap:anywhere}a.chip{text-decoration:none}
.case{background:var(--card);border:1px solid var(--line);border-left:6px solid;border-radius:10px;display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr)}
.brief{padding:6px 22px 14px}.brief h2{font-size:18px;margin:14px 0 4px}.brief h3{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:16px 0 4px}
blockquote{margin:6px 0;padding:4px 10px;border-left:3px solid var(--line);color:var(--mute)}
.cite{font-size:12px;background:#2563eb22;color:#1d4ed8;border-radius:4px;padding:0 4px}
.trace{border-left:1px solid var(--line);padding:12px 14px;font-size:12.5px;max-height:620px;overflow:auto}
.map{background:var(--card);border:1px solid var(--line);border-left:6px solid #0e7490;border-radius:10px;padding:12px 22px}.map h2{font-size:18px;margin:6px 0}.map li{margin:4px 0}
.ev{padding:3px 0;border-bottom:1px dashed var(--line)}.crit{color:#b91c1c}.sql{color:var(--mute)}.llm{color:#15803d}.mem{color:#7c3aed}
code{font-size:12px}ul{margin:4px 0;padding-left:20px}
.storemap{border-left-color:#b91c1c}.pulls{width:100%;border-collapse:collapse;font-size:13px}.pulls th,.pulls td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);vertical-align:top}.pulls .n{text-align:right;font-variant-numeric:tabular-nums}.out{color:#b45309;font-size:12px}
.usmap{width:100%;height:auto;max-height:440px;margin:6px 0}.usmap .st{fill:var(--line);stroke:var(--card);stroke-width:1}.usmap .st-named{fill:#fca5a5;stroke:var(--card);stroke-width:1}
.usmap circle{stroke:#fff;stroke-width:1.5;fill-opacity:.85}.usmap .d-in{fill:#b91c1c}.usmap .d-out{fill:#d97706}
.pick select{max-width:100%;min-height:32px}.ev-list summary,.trace summary{cursor:pointer}.ev-list summary h3{display:inline}.trace summary{padding:2px 0 6px}.srcmap summary{cursor:pointer;font-weight:600;font-size:16px;padding:6px 0}
.k{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle}.k-in{background:#b91c1c}.k-out{background:#d97706}.pick{display:block;margin:8px 0 0;font-size:13px;color:var(--mute)}
@media (prefers-color-scheme:dark){.usmap .st-named{fill:#7f1d1d}}
/* "What the agents did": chips across the top of a case card, one per highlight read from that case's trace. */
.did{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:10px 22px;border-bottom:1px solid var(--line);font-size:13px;min-width:0}
.did-h{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);font-weight:600;margin-right:4px}
.hl{padding:3px 9px;border-radius:7px;border:1px solid transparent;overflow-wrap:anywhere;line-height:1.35}
.hl-map{background:#0e749018;color:#0e7490;border-color:#0e749033}.hl-human{background:#7c3aed18;color:#6d28d9;border-color:#7c3aed33}
.hl-audit{background:#c2410c14;color:#9a3412;border-color:#c2410c33}.hl-stats{background:transparent;color:var(--mute);border-color:var(--line)}
@media (prefers-color-scheme:dark){.crit{color:#f87171}.mem{color:#c084fc}.llm{color:#4ade80}.cite{color:#93c5fd;background:#2563eb44}
.hl-map{color:#67e8f9;background:#0e749033}.hl-human{color:#d8b4fe;background:#7c3aed33}.hl-audit{color:#fdba74;background:#c2410c2e}}
/* Motion: the header fades in, the source map and cases rise in one after another (stagger). Ease-out, short; off with reduced motion. */
@keyframes fade{from{opacity:0}}@keyframes rise{from{opacity:0;transform:translateY(10px)}}
header{animation:fade .5s cubic-bezier(.2,.7,.2,1) both}
.map,.case{animation:rise .45s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(min(var(--i,0),8) * 70ms + 120ms)}
@media (prefers-reduced-motion:reduce){header,.map,.case{animation:none}}
@media print{header,.map,.case{animation:none}}
@media (max-width:820px){.case{grid-template-columns:1fr}.trace{border-left:0;border-top:1px solid var(--line)}main,header{padding-left:16px;padding-right:16px}.did{padding:8px 14px}.brief{padding-left:14px;padding-right:14px}}
</style></head><body><header><h1>RecallWhy · ${headline(cases)}</h1>
<div class="sub">${res.scanned} recalls since ${esc(since)} → ${cases.length} cases on our catalog · <small>run ${esc(res.runId)} · engine <b>${esc(res.engine)}</b>${res.engine === "duckdb-sample" ? " (SAMPLE — Zetaris not used)" : ""} · model <b>${esc(res.model)}</b></small></div>
${evs.filter((e) => e.kind === "msg" && /^WARNING: live feed/.test(e.text ?? "")).map((e) => `<div class="warn">${esc(e.text ?? "")}</div>`).join("")}
${summary()}
<div class="sub">${existsSync(`${outDir}/digest.md`) ? `<a href="digest.md">Weekly digest</a>` : ""}${existsSync(`${outDir}/actions`) ? ` · Action packets (drafts, not sent): ${readdirSync(`${outDir}/actions`).length} — pull lists, supplier requests and customer notices in <a href="actions/">actions/</a>` : ""}</div>
<div class="chips">${Object.entries(counts).map(([k, v]) => `<a class="chip" href="#v-${k}" style="background:${COLOR[k]}">${k} <span data-n="${v}">${v}</span></a>`).join("")}</div></header><main>
${storeMapSection(points, caseStates(cases, evs), loadStatePaths())}
${cases.map((c: { id: string; verdict: string }, i: number) => `<section class="case" style="--i:${i + 1};border-left-color:${COLOR[c.verdict]}"${i === cases.findIndex((x: { verdict: string }) => x.verdict === c.verdict) ? ` id="v-${c.verdict}"` : ""}>${banner(slices.get(c.id) ?? [])}<div class="brief"><a id="${esc(c.id)}"></a>${foldEvidence(md(readFileSync(`${outDir}/briefs/${c.id}.md`, "utf8")), i === 0)}</div>
<div class="trace"><details${i === 0 ? " open" : ""}><summary><b>How the agents got here</b> (${(slices.get(c.id) ?? []).map(line).filter(Boolean).length} steps)</summary>${(slices.get(c.id) ?? []).map(line).join("")}</details></div></section>`).join("\n")}
${sourceMap(evs)}
</main>
</body></html>`;
  writeFileSync(`${outDir}/report.html`, html);
  return `${outDir}/report.html`;
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(renderReport(process.argv[2], process.argv[3]));
