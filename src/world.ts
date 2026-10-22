// Meterless World Model (mounted in src/engines/world-model) as the team's shared,
// provenance-carrying state. Agents write facts here as they find them; the
// Briefer reads ONLY what ContextBuilder assembles from here, never raw rows.
import { WorldModel, type Fact } from "./engines/world-model/index.ts";
import type { Trace } from "./trace.ts";

export interface Source { kind: string; by: string; ref?: string } // ref = sqlId, model call, memory id

export class World {
  readonly wm: WorldModel;
  constructor(private trace: Trace, dir = "state/world") {
    this.wm = new WorldModel({ namespace: "recallwhy", storage: "local", directory: dir });
  }

  async entity(type: string, system: string, id: string, name: string, attrs: Record<string, unknown>, src: Source): Promise<string> {
    const e = await this.wm.upsertEntity({ type, externalKey: { system, id }, name, attrs, source: this.prov(src) });
    return e.id;
  }

  async fact(about: string, predicate: string, value: unknown, src: Source, confidence = 0.9): Promise<Fact> {
    const f = await this.wm.assertFact({ about, predicate, value, confidence, source: this.prov(src) });
    this.trace.emit("world.write", src.by, { about, predicate, value, factId: f.id, sourceKind: src.kind, ref: src.ref });
    return f;
  }

  async link(from: string, type: string, to: string, src: Source): Promise<void> {
    await this.wm.relate({ from, type, to, source: this.prov(src) });
  }

  facts(about: string): Fact[] {
    return this.wm.view("facts").about(about).filter((f) => !f.supersededBy);
  }

  private prov(src: Source) {
    return { kind: src.kind, by: src.by, at: new Date().toISOString(), url: src.ref, runId: this.trace.runId };
  }
}

export interface Evidence { id: string; about: string; predicate: string; value: unknown; source: string }

/** ContextBuilderService: the bounded, cited view of a case that the Briefer is allowed to see. */
export function buildContext(world: World, ids: string[], agent: string, trace: Trace): { evidence: Evidence[]; text: string } {
  const evidence: Evidence[] = [];
  for (const id of ids) for (const f of world.facts(id)) {
    evidence.push({ id: `E${evidence.length + 1}`, about: id, predicate: f.predicate, value: f.value,
      source: `${f.source.kind}${f.source.url ? ` ${f.source.url}` : ""} by ${f.source.by}` });
  }
  // Plain-English lines ("[E12] our units on hand in affected lots: 379") read the same way to the
  // model that writes the brief and to the model that checks it.
  const text = evidence.map((e) => `[${e.id}] ${e.predicate.replace(/_/g, " ")}: ${typeof e.value === "string" ? e.value : JSON.stringify(e.value)}`).join("\n");
  trace.emit("world.context", agent, { entities: ids, evidenceCount: evidence.length });
  return { evidence, text };
}
