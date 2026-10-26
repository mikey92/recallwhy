// Time from a recall notice to its action packet, per case, read from the committed live traces
// (examples/output/*/trace.jsonl; the sample-mode run is left out). A case starts when the Investigator opens it
// and ends when its packet is drafted (or its brief is ready when there is no packet). Also splits each case's
// time into model calls and the rest (SQL, checks), from the same events.
//   npx tsx eval/latency.ts   → eval/results/latency.json and a summary on stdout
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

interface Ev { t: string; seq: number; kind: string; agent: string; text?: string; ms?: number; caseId?: string; purpose?: string }
const ex = "examples/output";
const cases: { run: string; caseId: string; seconds: number; modelSeconds: number; sqlSeconds: number; packet: boolean }[] = [];
for (const d of readdirSync(ex).filter((d) => existsSync(`${ex}/${d}/trace.jsonl`) && !/sample_mode/.test(d))) {
  const evs: Ev[] = readFileSync(`${ex}/${d}/trace.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  let cur: { id: string; t0: number; model: number; sql: number } | undefined;
  const close = (t: number, packet: boolean) => { if (cur) cases.push({ run: d, caseId: cur.id, seconds: (t - cur.t0) / 1000, modelSeconds: cur.model / 1000, sqlSeconds: cur.sql / 1000, packet }); cur = undefined; };
  for (const e of evs) {
    const t = Date.parse(e.t);
    const open = e.kind === "msg" && e.agent === "Investigator" && e.text?.match(/^opening (\S+):/);
    if (open) { if (cur) close(t, false); cur = { id: open[1], t0: t, model: 0, sql: 0 }; continue; }
    if (!cur) continue;
    if (e.kind === "llm") cur.model += e.ms ?? 0;
    if (e.kind === "sql") cur.sql += e.ms ?? 0;
    if (e.kind === "msg" && e.agent === "Orchestrator" && e.text?.startsWith(`${cur.id}: action packet drafted`)) close(t, true);
    else if (e.kind === "msg" && e.agent === "Briefer" && e.text?.startsWith(`${cur.id}: brief ready`) && !/act-now|notify/.test(e.text)) close(t, false);
  }
}
const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? (b[Math.floor((b.length - 1) / 2)] + b[Math.ceil((b.length - 1) / 2)]) / 2 : 0; };
const withPacket = cases.filter((c) => c.packet);
const out = {
  note: "Seconds from the Investigator opening a case to its action packet (after the Cartographer's map and the Scout's sweep, which run once per run), in the committed live example runs (Zetaris + Nemotron via Meterless Nightshift, paced at 4 model calls a minute).",
  casesWithPacket: withPacket.length,
  medianSeconds: med(withPacket.map((c) => c.seconds)),
  minSeconds: Math.min(...withPacket.map((c) => c.seconds)),
  maxSeconds: Math.max(...withPacket.map((c) => c.seconds)),
  medianModelSeconds: med(withPacket.map((c) => c.modelSeconds)),
  medianSqlSeconds: med(withPacket.map((c) => c.sqlSeconds)),
  cases: cases.map((c) => ({ ...c, seconds: Math.round(c.seconds * 10) / 10, modelSeconds: Math.round(c.modelSeconds * 10) / 10, sqlSeconds: Math.round(c.sqlSeconds * 10) / 10 })),
};
writeFileSync("eval/results/latency.json", JSON.stringify(out, null, 2) + "\n");
console.log(`case opened → action packet: median ${out.medianSeconds.toFixed(1)} s over ${out.casesWithPacket} cases (min ${out.minSeconds.toFixed(1)}, max ${out.maxSeconds.toFixed(1)}); model time median ${out.medianModelSeconds.toFixed(1)} s, SQL ${out.medianSqlSeconds.toFixed(1)} s (up to ${Math.max(...withPacket.map((c) => c.sqlSeconds)).toFixed(1)} s when a Zetaris data-quality run falls inside the case)`);
