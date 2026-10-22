// H-MEM (Meterless engine, mounted in src/engines/hmem) as the team's case memory.
// What goes in: every adjudication the team makes (agent, medium trust) and every
// human decision (high trust). What comes out: prior decisions on the same
// recall/SKU pair (exact, by tag) and similar past cases (fuzzy, by retrieval).
import { HMEM, type MemoryRecord } from "./engines/hmem/index.ts";
import type { Trace } from "./trace.ts";

export interface Decision { recallId: string; sku: string; verdict: "same" | "not-this" | "unsure"; reason: string; by: "agent" | "human"; runId: string }

export class CaseMemory {
  readonly hmem: HMEM;
  constructor(private trace: Trace, dir = "state/hmem") {
    this.hmem = new HMEM({ persistDir: dir, actor: "recallwhy" });
  }

  record(d: Decision, agent: string): MemoryRecord {
    const rec = this.hmem.add({
      content: `${d.by === "human" ? "Human reviewer" : "Agents"} decided ${d.sku} is ${d.verdict === "same" ? "COVERED by" : d.verdict === "not-this" ? "NOT covered by" : "UNCLEAR for"} recall ${d.recallId}: ${d.reason}`,
      type: "factual", layer: d.by === "human" ? "long_term" : "working",
      tags: [`recall:${d.recallId}`, `sku:${d.sku}`, `verdict:${d.verdict}`, `by:${d.by}`],
      confidence: d.by === "human" ? 0.95 : 0.6,
      source: d.by === "human" ? "human-review" : `run:${d.runId}`,
      provenance: { origin: d.by === "human" ? "user_correction" : "model_response", learnedAt: Date.now(), label: d.by === "human" ? "recallwhy decide" : `${agent} in run ${d.runId}`, refs: [d.recallId, d.sku] },
    });
    this.trace.emit("memory.write", agent, { memoryId: rec.id, text: rec.content, confidence: rec.confidence });
    return rec;
  }

  /** Exact prior decisions for a recall/SKU pair, human first, newest first. */
  priorDecisions(recallId: string, sku: string, agent: string): MemoryRecord[] {
    const hits = this.hmem.store.all().filter((m) => m.tags.includes(`recall:${recallId}`) && m.tags.includes(`sku:${sku}`) && !m.supersededBy)
      .sort((a, b) => Number(b.tags.includes("by:human")) - Number(a.tags.includes("by:human")) || b.timestamp - a.timestamp);
    this.trace.emit("memory.read", agent, { query: `recall:${recallId} sku:${sku}`, hits: hits.map((h) => ({ id: h.id, text: h.content, confidence: h.confidence })) });
    return hits;
  }

  /** Similar past cases (other recalls, same firm or product words) — context for the judge. */
  similar(query: string, agent: string, topN = 3): MemoryRecord[] {
    const r = this.hmem.query(query, { topN });
    const hits = r.memories.map((m) => m.memory);
    this.trace.emit("memory.read", agent, { query, strategy: r.trace.strategy, hits: hits.map((h) => ({ id: h.id, text: h.content, relevance: r.trace.scores[h.id] })) });
    return hits;
  }
}
