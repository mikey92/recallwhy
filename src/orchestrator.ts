// Orchestrator: routes each case through Investigator ⇄ Auditor (max 2 revisions),
// escalates what the Auditor still blocks, records decisions in H-MEM and the
// finding in the World Model, then asks the Briefer for the brief.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { audit } from "./agents/auditor.ts";
import { brief, type Brief } from "./agents/briefer.ts";
import { say, type AgentContext } from "./agents/context.ts";
import { investigate, revise, type Finding } from "./agents/investigator.ts";
import { scout, type Case } from "./agents/scout.ts";
import { chart } from "./agents/cartographer.ts";
import { renderReport } from "./report-html.ts";

const MAX_REVISIONS = 2;

export interface RunResult { runId: string; scanned: number; cases: { id: string; recall: string; verdict: Finding["verdict"]; rounds: number; whyBy: string }[]; outDir: string }

export async function run(ctx: AgentContext, opts: { since: string; only?: string[]; limit?: number }): Promise<RunResult> {
  ctx.trace.emit("run.start", "Orchestrator", { since: opts.since, only: opts.only, engine: ctx.sql.engine, model: ctx.model });
  ctx.map ??= await chart(ctx);
  const { cases, scanned } = await scout(ctx, opts);
  const todo = opts.limit ? cases.slice(0, opts.limit) : cases;
  if (todo.length < cases.length) say(ctx, "Orchestrator", "Scout", `limiting this run to ${todo.length} of ${cases.length} cases`);
  const outDir = `out/${ctx.trace.runId}`;
  mkdirSync(`${outDir}/briefs`, { recursive: true });
  const results: RunResult["cases"] = [];
  const briefs: Brief[] = [];
  for (const k of todo) {
    const { finding, open } = await adjudicate(ctx, k);
    if (finding.verdict !== "needs-human") unqueue(ctx, k.id); // settled now (e.g. by a reviewer's decision)
    const entities = await record(ctx, k, finding);
    const b = await brief(ctx, k, finding, entities, open);
    writeFileSync(`${outDir}/briefs/${k.id}.md`, b.markdown);
    briefs.push(b);
    results.push({ id: k.id, recall: k.recall.id, verdict: finding.verdict, rounds: finding.round, whyBy: b.whyBy });
  }
  writeFileSync(`${outDir}/report.md`, report(ctx, opts.since, scanned, results));
  writeFileSync(`${outDir}/result.json`, JSON.stringify({ runId: ctx.trace.runId, engine: ctx.sql.engine, model: ctx.model, since: opts.since, scanned, cases: results }, null, 2));
  try { renderReport(outDir); } catch (e) { ctx.trace.emit("note", "Orchestrator", { text: `report.html not written: ${(e as Error).message}` }); }
  ctx.trace.emit("run.end", "Orchestrator", { scanned, cases: results.length, verdicts: count(results.map((r) => r.verdict)), outDir });
  return { runId: ctx.trace.runId, scanned, cases: results, outDir };
}

export async function adjudicate(ctx: AgentContext, k: Case): Promise<{ finding: Finding; open: string[]; openSkus: string[] }> {
  let f = await investigate(ctx, k);
  for (;;) {
    const a = await audit(ctx, k, f);
    if (a.ok) {
      // Approved, but nobody could decide a pair (no model, or the judge was unsure): that is the reviewer's too.
      if (f.verdict === "needs-human") queue(ctx, k, f, f.decisions.filter((d) => d.verdict === "unsure").map((d) => `${d.sku} undecided: ${d.why}`));
      return { finding: f, open: [], openSkus: [] };
    }
    if (f.round > MAX_REVISIONS) {
      const open = a.critiques.map((c) => c.detail);
      f = { ...f, verdict: "needs-human" };
      ctx.trace.emit("escalate", "Orchestrator", { caseId: k.id, open });
      say(ctx, "Orchestrator", "Human", `${k.id}: escalated after ${f.round} rounds — ${open.join("; ")}`.slice(0, 400));
      queue(ctx, k, f, open);
      return { finding: f, open, openSkus: a.critiques.flatMap((c) => (c.sku ? [c.sku] : [])) };
    }
    f = await revise(ctx, k, f, a.critiques);
  }
}

async function record(ctx: AgentContext, k: Case, f: Finding): Promise<string[]> {
  const caseEntity = await ctx.world.entity("case", "recallwhy", k.id, `${k.recall.id} case`, { recall: k.recall.id }, { kind: "agent", by: "Orchestrator" });
  await ctx.world.link(caseEntity, "about", k.recallEntity, { kind: "agent", by: "Orchestrator" });
  for (const d of f.decisions) {
    await ctx.world.fact(caseEntity, "match_decision", `${d.sku} ${d.title}: ${d.verdict} — ${d.why}`, { kind: d.decidedBy === "judge" ? "model" : d.decidedBy.endsWith("memory") ? "h-mem" : "rule", by: "Investigator", ref: d.memoryId }, d.decidedBy === "judge" ? 0.7 : 0.95);
    // An escalated case is the reviewer's to decide, and an UNSURE call is no answer: neither is remembered as the agents'.
    if ((d.decidedBy === "rule" || d.decidedBy === "judge") && f.verdict !== "needs-human" && d.verdict !== "unsure") ctx.memory.record({ recallId: k.recall.id, sku: d.sku, verdict: d.verdict, reason: d.why, by: "agent", runId: ctx.trace.runId, title: d.title, firm: k.recall.firm }, "Investigator");
  }
  const n = f.numbers;
  if (n) {
    const src = (ref?: string) => ({ kind: ctx.sql.engine, by: "Investigator", ref });
    await ctx.world.fact(caseEntity, "our_lots_named_in_notice", n.affectedLots.length ? n.affectedLots : `none (${n.lotRule})`, src(n.sql.inventory));
    await ctx.world.fact(caseEntity, "lot_rule", n.lotRule, { kind: "agent", by: "Investigator" });
    await ctx.world.fact(caseEntity, "our_stores_holding_affected_lots", n.storesWithStock, src(n.sql.inventory));
    await ctx.world.fact(caseEntity, "our_units_on_hand_in_affected_lots", n.onHandUnits, src(n.sql.inventory));
    await ctx.world.fact(caseEntity, "our_units_sold_since_recall_date", n.unitsSoldSince, src(n.sql.sales));
    await ctx.world.fact(caseEntity, "our_loyalty_customers_who_bought_affected_lots", n.loyaltyCustomers, src(n.sql.sales));
    if (n.supplier) await ctx.world.fact(caseEntity, "our_supplier_for_this_sku", n.supplier, src(n.sql.shipNotices));
    if (f.stores.length) await ctx.world.fact(caseEntity, "our_stores_with_units_on_hand", f.stores.slice(0, 8).map((s) => `${s.store_id} ${s.state}: ${s.on_hand}`), src(n.sql.inventory));
  }
  await ctx.world.fact(caseEntity, "verdict", f.verdict, { kind: "agent", by: "Auditor" });
  return [k.recallEntity, caseEntity];
}

function unqueue(ctx: AgentContext, caseId: string) {
  const file = ctx.queueFile ?? "state/review-queue.json";
  if (!existsSync(file)) return;
  const q = JSON.parse(readFileSync(file, "utf8")) as { caseId: string }[];
  if (q.some((c) => c.caseId === caseId)) writeFileSync(file, JSON.stringify(q.filter((c) => c.caseId !== caseId), null, 2));
}

function queue(ctx: AgentContext, k: Case, f: Finding, open: string[]) {
  const file = ctx.queueFile ?? "state/review-queue.json";
  mkdirSync(dirname(file), { recursive: true });
  // One entry per case: a re-run replaces the old one.
  const q = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []).filter((c: { caseId: string }) => c.caseId !== k.id);
  const cand = (sku: string) => k.candidates.find((c) => c.sku.sku === sku)?.sku;
  q.push({ caseId: k.id, recall: k.recall.id, firm: k.recall.firm, date: k.recall.date, notice: k.recall.text.slice(0, 600), runId: ctx.trace.runId,
    skus: f.decisions.map((d) => ({ sku: d.sku, title: d.title, upc: cand(d.sku)?.upc ?? "", vendor: cand(d.sku)?.brand ?? "", verdict: d.verdict, why: d.why })), open, at: new Date().toISOString() });
  writeFileSync(file, JSON.stringify(q, null, 2));
}

const count = (xs: string[]) => xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {});

function report(ctx: AgentContext, since: string, scanned: number, rs: RunResult["cases"]): string {
  const order = ["act-now", "notify", "needs-human", "no-exposure", "not-ours"];
  const sorted = [...rs].sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict));
  return [`# RecallWhy run ${ctx.trace.runId}`, "",
    `Engine: **${ctx.sql.engine}**${ctx.sql.engine === "duckdb-sample" ? " (SAMPLE MODE — local stand-in, Zetaris not used)" : ""} · Model: **${ctx.model}** · Recalls since ${since}: **${scanned}** scanned, **${rs.length}** touch our catalog`, "",
    "| Verdict | Count |", "|---|---|", ...Object.entries(count(rs.map((r) => r.verdict))).map(([k, v]) => `| ${k} | ${v} |`), "",
    "| Case | Recall | Verdict | Audit rounds | Why written by |", "|---|---|---|---|---|",
    ...sorted.map((r) => `| [${r.id}](briefs/${r.id}.md) | ${r.recall} | ${r.verdict} | ${r.rounds} | ${r.whyBy} |`), "",
    `Trace: \`${ctx.trace.file}\``].join("\n");
}
