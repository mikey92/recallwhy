// Briefer: writes the action brief from the World Model context only. The "why"
// paragraph comes from the model and must survive the Auditor's brief check;
// actions and caveats are computed from the cited evidence.
import { buildContext } from "../world.ts";
import { auditBrief } from "./auditor.ts";
import { say, type AgentContext } from "./context.ts";
import type { Finding } from "./investigator.ts";
import type { Case } from "./scout.ts";

const HEAD: Record<Finding["verdict"], string> = {
  "act-now": "ACT NOW — recalled stock is on our shelves",
  notify: "NOTIFY — we sold affected units; none left on hand",
  "no-exposure": "NO EXPOSURE — we carry the product, but not the recalled lots",
  "not-ours": "NOT OURS — candidates checked and ruled out",
  "needs-human": "NEEDS HUMAN REVIEW — evidence not strong enough to decide",
};

export interface Brief { caseId: string; verdict: Finding["verdict"]; markdown: string; whyBy: "model" | "template"; attempts: number }

export async function brief(ctx: AgentContext, k: Case, f: Finding, entities: string[], openCritiques: string[] = []): Promise<Brief> {
  const { evidence, text } = buildContext(ctx.world, entities, "Briefer", ctx.trace);
  const ids = new Set(evidence.map((e) => e.id));
  const cite = (pred: string) => evidence.filter((e) => e.predicate === pred).map((e) => `[${e.id}]`).slice(0, 2).join("");

  let why = "";
  let whyBy: Brief["whyBy"] = "template";
  let feedback = "";
  let attempts = 0;
  // "Not ours" and "needs human" briefs only restate the decisions, so they use the template,
  // and so does every brief when no model is configured.
  const drafted = !ctx.model.startsWith("none:") && (f.verdict === "act-now" || f.verdict === "notify" || f.verdict === "no-exposure");
  // A match a reviewer decided is not a confirmed match; the paragraph must say who decided it.
  const byHuman = f.decisions.filter((d) => d.decidedBy === "human-memory" && d.verdict === "same").map((d) => d.sku);
  for (; attempts < 3 && drafted; ) {
    attempts++;
    const out = await ctx.gen(
      [`Write 2-4 sentences for a retail safety manager explaining WHY the verdict below is correct.`,
        `Verdict: ${HEAD[f.verdict]}`, `Use ONLY these facts. After every claim put the evidence id in brackets, like [E3]. Do not state any number that is not in the facts; write numbers as digits. Keep the recall notice's statements (firm, product, reason, codes) apart from our own data (stores, units, customers) — never say the notice states something about our stores. No headings, no lists.`,
        byHuman.length ? `The match for ${byHuman.join(", ")} was decided by a human reviewer, not confirmed by the data: say that a reviewer decided it, and do not call it confirmed or verified.` : "",
        "", "FACTS:", text, feedback ? `\nYour previous draft was rejected: ${feedback}. Fix exactly that.` : ""].join("\n"),
      { agent: "Briefer", purpose: `why-paragraph ${k.id} (attempt ${attempts})`, maxTokens: 260 }).catch(() => "");
    const problems = out ? auditBrief(out, ids, text) : ["empty answer"];
    if (out && byHuman.length && /\b(confirm(s|ed)?|verif(y|ies|ied)|corresponds exactly)\b[^.]*\b(match|product|SKU)\b|\b(match|product|SKU)\b[^.]*\b(confirm(s|ed)?|verified)\b/i.test(out) && !/reviewer/i.test(out))
      problems.push(`the match for ${byHuman.join(", ")} was a reviewer's decision; say so instead of calling it confirmed`);
    if (!problems.length) {
      // Lexical checks passed; the Auditor also asks the model whether each sentence is
      // supported by the facts it cites (a separate call, not the Briefer's own prompt).
      const verdict = await ctx.gen(
        [`FACTS:`, text, "", `DRAFT:`, out, "",
          "Check every sentence of the DRAFT against the FACTS it cites in brackets. Facts named notice_* come from the recall notice; facts named our_* come from our own systems. Paraphrase and plain conclusions drawn directly from the facts are fine. A sentence is unsupported only if it adds information the cited facts do not contain (for example a state, a person, a confirmation, or a notice statement about our stores).",
          "A sentence that restates a cited fact in other words is supported. Do not object to wording, tone, or a recommended action that follows from the facts.",
          "Answer exactly OK if every sentence is supported. Otherwise answer UNSUPPORTED: <the first unsupported claim, quoted>."].join("\n"),
        { agent: "Auditor", purpose: `check brief support ${k.id}`, maxTokens: 120 }).catch(() => "OK");
      if (/^\W*UNSUPPORTED/i.test(verdict)) problems.push(verdict.replace(/^\W*UNSUPPORTED\W*/i, "unsupported claim: ").slice(0, 240));
    }
    if (!problems.length) { why = out.trim(); whyBy = "model"; ctx.trace.emit("note", "Auditor", { text: `brief for ${k.id} passes evidence check` }); break; }
    feedback = problems.slice(0, 4).join("; ");
    ctx.trace.emit("critique", "Auditor", { caseId: k.id, code: "brief-unsupported", detail: feedback });
    say(ctx, "Auditor", "Briefer", `brief for ${k.id} rejected: ${feedback}`);
  }
  if (!why) why = templateWhy(f, cite);

  const n = f.numbers;
  const actions: string[] = [];
  if (f.verdict === "act-now" && n) {
    actions.push(`Pull lots ${n.affectedLots.slice(0, 8).join(", ")}${n.affectedLots.length > 8 ? "…" : ""} from ${n.storesWithStock} store(s): ${f.stores.slice(0, 6).map((s) => `${s.store_id} (${s.on_hand})`).join(", ")} ${cite("our_units_on_hand_in_affected_lots")}`);
  }
  if (n && n.unitsSoldSince > 0) actions.push(`Send recall notice to loyalty customers who bought affected lots since ${k.recall.date}: at most ${n.loyaltyCustomers} ${cite("our_loyalty_customers_who_bought_affected_lots")}`);
  if (n && (f.verdict === "act-now" || f.verdict === "notify")) actions.push(`Contact ${n.supplier ?? "the supplier"} for credit and replacement ${cite("our_supplier_for_this_sku")}`);
  if (f.verdict === "no-exposure") actions.push(`No pull needed. Keep the notice on file; re-run if new lots arrive ${cite("our_lots_named_in_notice")}`);
  if (f.verdict === "needs-human") actions.push(`Review in the queue: \`npm run decide -- ${k.recall.id} <sku> same|not-this --note "..."\`. The decision is stored in memory and used on the next run.`);

  const caveats: string[] = ["Retailer stock, sales, lots and ship notices are synthetic (Northwind Mercantile, generated for this demo); food items are real products with real barcodes (USDA FoodData Central, Open Food Facts)."];
  if (n?.lotRule === "all-lots") caveats.push("The notice lists no lot codes we could verify, so every lot of the SKU is treated as affected.");
  if (n?.outsideDistribution.length) caveats.push(`Stores in ${n.outsideDistribution.join(", ")} hold stock although the notice's distribution list does not name those states — product can travel through distributors, so this is not a clearance.`);
  if (n && n.loyaltyCustomers) caveats.push("Customer count sums weekly distinct counts, so it is an upper bound.");
  for (const c of openCritiques) caveats.push(`Open Auditor objection: ${c}`);

  const md = [
    `# ${HEAD[f.verdict]}`, "", `**${k.recall.id}** · ${k.recall.firm} · ${k.recall.date}${k.recall.url ? ` · [notice](${k.recall.url})` : ""}`, "",
    `> ${k.recall.title.slice(0, 200)}`, "", "## Why", why, "",
    "## What we matched", ...f.decisions.map((d) => `- \`${d.sku}\` ${d.title} — **${d.verdict}** (${d.decidedBy}, ${d.basis}): ${d.why}`), "",
    ...(actions.length ? ["## Actions", ...actions.map((a) => `- ${a}`), ""] : []),
    "## Caveats", ...caveats.map((c) => `- ${c}`), "",
    "## Evidence", ...evidence.map((e) => `- [${e.id}] ${e.predicate}: ${JSON.stringify(e.value).slice(0, 160)} — *${e.source}*`), "",
    `_why-paragraph written by ${whyBy === "model" ? `${ctx.model} and checked by the Auditor` : attempts ? `template (${attempts} model draft(s) failed the evidence check)` : !drafted && ctx.model.startsWith("none:") ? "template (no model configured)" : "template (this verdict only restates the decisions)"}; run ${ctx.trace.runId}_`,
  ].join("\n");
  ctx.trace.emit("brief", "Briefer", { caseId: k.id, verdict: f.verdict, whyBy, attempts });
  say(ctx, "Briefer", "Orchestrator", `${k.id}: brief ready (${f.verdict}, why by ${whyBy})`);
  return { caseId: k.id, verdict: f.verdict, markdown: md, whyBy, attempts };
}

function templateWhy(f: Finding, cite: (p: string) => string): string {
  const same = f.decisions.filter((d) => d.verdict === "same");
  if (f.verdict === "not-ours") return `Every candidate was ruled out: ${f.decisions.map((d) => `${d.sku} (${d.why})`).join("; ")} ${cite("match_decision")}.`;
  if (f.verdict === "needs-human") return `The team could not settle this: ${f.decisions.map((d) => `${d.sku} ${d.verdict} — ${d.why}`).join("; ")} ${cite("match_decision")}.`;
  const n = f.numbers!;
  return `${same.map((d) => `${d.sku} matches the notice because ${d.why}`).join("; ")} ${cite("match_decision")}. ` +
    `${n.lotRule === "listed-lots" ? `Our lots ${n.affectedLots.join(", ")} appear in the notice's lot list` : n.lotRule === "all-lots" ? "The notice does not limit the recall to specific lots" : "None of our lots appear in the notice's lot list"} ${cite("our_lots_named_in_notice")}. ` +
    `${n.onHandUnits} units are on hand in ${n.storesWithStock} store(s) ${cite("our_units_on_hand_in_affected_lots")} and ${n.unitsSoldSince} were sold since the recall began ${cite("our_units_sold_since_recall_date")}.`;
}
