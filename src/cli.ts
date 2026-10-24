#!/usr/bin/env -S npx tsx
// recallwhy run [--since YYYY-MM-DD] [--only H-1361-2026,27024] [--limit N]
// recallwhy decide <recall-id> <sku> same|not-this [--note "..."]
// recallwhy queue
import { loadConfig } from "./config.ts";
import { decide, reviewQueue, runOnce } from "./app.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const env = loadConfig();

async function main() {
  const cmd = args[0] ?? "run";
  if (cmd === "decide") {
    const [, recallId, sku, verdict] = args;
    if (!recallId || !sku || !["same", "not-this"].includes(verdict)) throw new Error('usage: decide <recall-id> <sku> same|not-this [--note "..."]');
    const { recall } = decide(recallId, sku, verdict as "same" | "not-this", flag("note"));
    console.log(`stored: ${sku} ${verdict} for ${recall} (high trust; used on the next run)`);
    return;
  }
  if (cmd === "queue") {
    const q = reviewQueue() as { caseId: string; recall: string; skus: { sku: string; title: string; verdict: string; why: string }[]; open: string[] }[];
    if (args.includes("--json")) { console.log(JSON.stringify(q, null, 2)); return; }
    if (!q.length) console.log("review queue is empty");
    for (const c of q) {
      console.log(`${c.caseId}  (${c.recall})`);
      for (const s of c.skus) console.log(`  ${s.sku} ${s.title}: ${s.verdict} — ${s.why.slice(0, 100)}`);
      for (const o of c.open) console.log(`  Auditor objection: ${o}`);
    }
    return;
  }
  const r = await runOnce(env, { since: flag("since") ?? "2026-09-15", only: flag("only")?.split(","), limit: flag("limit") ? Number(flag("limit")) : undefined });
  console.log(`\n${r.cases.length} case(s) from ${r.scanned} recalls → ${r.outDir}/report.md\ntrace: ${r.trace}`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
