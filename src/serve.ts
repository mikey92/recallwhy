// Local viewer: streams a run's trace as it happens and links to finished reports.
//   npm run view   →  http://127.0.0.1:8899
// Read-only: it only reads logs/ and out/; it never runs agents or changes results.
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";

const PORT = Number(process.env.VIEW_PORT ?? 8899);
const runs = () => readdirSync("logs").filter((f) => /^trace-.*\.jsonl$/.test(f)).map((f) => f.slice(6, -6))
  .sort((a, b) => statSync(`logs/trace-${b}.jsonl`).mtimeMs - statSync(`logs/trace-${a}.jsonl`).mtimeMs);

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/api/runs") return json(res, runs().slice(0, 30).map((r) => ({ run: r, report: existsSync(`out/${r}/report.html`) })));
  if (url.pathname === "/api/trace") {
    const run = url.searchParams.get("run") ?? runs()[0];
    const after = Number(url.searchParams.get("after") ?? 0);
    const f = `logs/trace-${run}.jsonl`;
    if (!run || !/^[\w-]+$/.test(run) || !existsSync(f)) return json(res, { run, events: [] });
    const events = readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.seq > after)
      .map(({ prompt, sql, ...e }) => ({ ...e, sql: typeof sql === "string" ? sql.replace(/\s+/g, " ").slice(0, 400) : undefined }));
    return json(res, { run, events, done: events.some((e) => e.kind === "run.end"), report: existsSync(`out/${run}/report.html`) });
  }
  if (url.pathname.startsWith("/out/")) {
    const p = normalize(join(".", decodeURIComponent(url.pathname)));
    if (!p.startsWith("out/") || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": p.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain; charset=utf-8" });
    return res.end(readFileSync(p));
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(PAGE);
}).listen(PORT, "127.0.0.1", () => console.log(`RecallWhy viewer on http://127.0.0.1:${PORT}`));

function json(res: import("node:http").ServerResponse, v: unknown) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); }

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RecallWhy live</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--ink:#e8e8ea;--mute:#8b90a0;--line:#262a34}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,system-ui,sans-serif}
header{display:flex;align-items:center;gap:14px;padding:14px 20px;border-bottom:1px solid var(--line)}
h1{font-size:19px;margin:0}select{background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:4px}
.stat{color:var(--mute)}.stat b{color:var(--ink)}a{color:#60a5fa}
main{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:12px 20px}
.lane{background:var(--card);border:1px solid var(--line);border-radius:10px;display:flex;flex-direction:column;height:calc(100vh - 150px)}
.lane h2{margin:0;padding:10px 12px;font-size:14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}
.lane .feed{overflow:auto;padding:6px 10px;flex:1}
.ev{padding:5px 0;border-bottom:1px dashed var(--line);font-size:12.5px;animation:in .4s}
@keyframes in{from{background:#facc1533}to{background:transparent}}
.k{font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--mute)}
.sql .k{color:#38bdf8}.llm .k{color:#4ade80}.crit{color:#fca5a5}.crit .k{color:#f87171}.mem .k{color:#c084fc}.world .k{color:#fbbf24}.msg b{color:#fff}
.Scout h2{color:#22d3ee}.Investigator h2{color:#facc15}.Auditor h2{color:#e879f9}.Briefer h2{color:#4ade80}
footer{padding:0 20px 10px;color:var(--mute);font-size:12px}
@media (max-width:900px){main{grid-template-columns:1fr 1fr}.lane{height:50vh}}
</style></head><body>
<header><h1>RecallWhy</h1><select id="run"></select><span class="stat" id="stat"></span><span id="rep"></span></header>
<main>${["Scout", "Investigator", "Auditor", "Briefer"].map((a) => `<section class="lane ${a}"><h2>${a}<span class="k" id="n-${a}">0</span></h2><div class="feed" id="f-${a}"></div></section>`).join("")}</main>
<footer>Streaming logs/trace-&lt;run&gt;.jsonl as the agents write it. Every line here is an event the code emitted.</footer>
<script>
const $=(s)=>document.querySelector(s);let run=null,after=0,counts={},stats={sql:0,llm:0,crit:0,cases:0};
const esc=(s)=>String(s??"").replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"})[c]);
function render(e){const lane=["Scout","Investigator","Auditor","Briefer"].includes(e.agent)?e.agent:(e.kind==="escalate"?"Auditor":null);if(!lane)return;
 let cls="",k=e.kind,body="";
 if(e.kind==="msg"){cls="msg";body="→ <b>"+esc(e.to)+"</b> "+esc(e.text);if(/^opening /.test(e.text))stats.cases++}
 else if(e.kind==="sql"){cls="sql";stats.sql++;body="["+esc(e.engine)+"] "+esc(e.purpose)+" · "+e.rows+" rows · "+e.ms+" ms <span class='k'>"+esc(e.sqlId)+"</span>"}
 else if(e.kind==="llm"){cls="llm";stats.llm++;body=(e.served_model?"<b>"+esc(e.served_model)+"</b> ":esc(e.model||"")+" ")+esc(e.purpose)+" → <i>"+esc(String(e.output).slice(0,160))+"</i>"}
 else if(e.kind==="critique"){cls="crit";stats.crit++;body=esc(e.code)+": "+esc(e.detail)}
 else if(e.kind.startsWith("memory")){cls="mem";body=e.kind==="memory.write"?esc(e.text):"query "+esc(e.query)+" → "+(e.hits||[]).length+" hit(s)"}
 else if(e.kind.startsWith("world")){cls="world";body=e.kind==="world.context"?"context: "+e.evidenceCount+" evidence items":esc(e.predicate)+" = "+esc(JSON.stringify(e.value)).slice(0,90)}
 else if(e.kind==="escalate"){cls="crit";body="escalated "+esc(e.caseId)+" to human review"}
 else body=esc(e.text??e.summary??"");
 const d=document.createElement("div");d.className="ev "+cls;d.innerHTML="<span class='k'>"+k+"</span> "+body;const f=$("#f-"+lane);f.appendChild(d);f.scrollTop=f.scrollHeight;
 counts[lane]=(counts[lane]||0)+1;$("#n-"+lane).textContent=counts[lane];}
async function poll(){if(!run)return;const r=await (await fetch("/api/trace?run="+run+"&after="+after)).json();for(const e of r.events){render(e);after=e.seq}
 $("#stat").innerHTML="cases <b>"+stats.cases+"</b> · SQL <b>"+stats.sql+"</b> · model calls <b>"+stats.llm+"</b> · Auditor objections <b>"+stats.crit+"</b>"+(r.done?" · <b>done</b>":"");
 if(r.report)$("#rep").innerHTML="<a href='/out/"+run+"/report.html' target=_blank>report →</a>";}
async function init(){const rs=await (await fetch("/api/runs")).json();$("#run").innerHTML=rs.map(r=>"<option>"+r.run+"</option>").join("");run=new URLSearchParams(location.search).get("run")||rs[0]?.run;$("#run").value=run;
 $("#run").onchange=()=>{location.search="?run="+$("#run").value};setInterval(poll,700);poll();}
init();
</script></body></html>`;
