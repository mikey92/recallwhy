import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderReport, whatTheAgentsDid } from "../src/report-html.ts";

const EX = "examples/output";
const load = (name: string) => readFileSync(`${EX}/${name}/trace.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const slice = (evs: ReturnType<typeof load>, caseId: string) => {
  const i = evs.findIndex((e) => e.kind === "msg" && e.agent === "Investigator" && e.text?.startsWith(`opening ${caseId}:`));
  const j = evs.findIndex((e, k) => k > i && e.kind === "msg" && e.agent === "Investigator" && /^opening /.test(e.text ?? ""));
  return evs.slice(i, j === -1 ? undefined : j);
};

describe("whatTheAgentsDid", () => {
  it("is empty for an empty slice", () => assert.deepEqual(whatTheAgentsDid([]), []));

  it("reads the SUP028 map correction, the Zetaris write-back, the live-notice check and the counts from example_1", () => {
    const hs = whatTheAgentsDid(slice(load("example_1"), "case-fda-H-1396-2026"));
    const texts = hs.map((h) => h.text);
    assert.ok(texts.some((t) => t.startsWith("Map corrected mid-run: SUP028 no-check-digit") && t.includes("391/391 ship notices")), texts.join(" | "));
    assert.ok(texts.some((t) => t.startsWith("Written back to Zetaris as reconciled.ship_notice_item_keys") && t.includes("SUP028 391/391")), texts.join(" | "));
    assert.ok(texts.some((t) => /^Auditor approved after \d+ checks \(live notice re-read, exposure re-derived independently\)$/.test(t)), texts.join(" | "));
    assert.ok(texts.some((t) => /^\d+ SQL queries on zetaris · \d+ model calls \(nvidia\/nemotron-3-ultra-550b-a55b\)$/.test(t)), texts.join(" | "));
    assert.ok(hs.length <= 4);
  });

  it("reports the Auditor's objections and the escalation", () => {
    const texts = whatTheAgentsDid(slice(load("example_3"), "case-fda-H-1099-2026")).map((h) => h.text);
    assert.ok(texts.includes("Auditor blocked 3 claims (dismissal-names-our-item) → escalated to a human after 3 rounds"), texts.join(" | "));
    assert.ok(!texts.some((t) => t.startsWith("Auditor approved")));
  });

  it("reports the human decisions followed on the next run", () => {
    const texts = whatTheAgentsDid(slice(load("example_3_after_human_decision"), "case-fda-H-1099-2026")).map((h) => h.text);
    assert.ok(texts.filter((t) => /^Followed a human decision \(mem-\d+\)$/.test(t)).length === 2, texts.join(" | "));
  });

  it("reports the model-proposed SUP010 transform", () => {
    const texts = whatTheAgentsDid(slice(load("example_2"), "case-fda-H-1362-2026")).map((h) => h.text);
    assert.ok(texts.some((t) => t.startsWith("Model-proposed transform for SUP010") && t.includes("193/193 ship notices")), texts.join(" | "));
  });

  it("says 'no model calls' in sample mode", () => {
    const texts = whatTheAgentsDid(slice(load("example_1_sample_mode"), "case-fda-H-1396-2026")).map((h) => h.text);
    assert.ok(texts.some((t) => /SQL queries on duckdb-sample · no model calls$/.test(t)), texts.join(" | "));
  });
});

describe("renderReport", () => {
  it("renders from an explicit trace path and puts the banner at the top of each case", () => {
    const api = JSON.parse(readFileSync(`${EX}/example_2.json`, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "recallwhy-report-"));
    mkdirSync(`${dir}/briefs`);
    writeFileSync(`${dir}/result.json`, JSON.stringify({ runId: api.runId, engine: api.engine, model: api.model, scanned: api.scanned, cases: api.cases }));
    for (const [id, md] of Object.entries(api.briefs)) writeFileSync(`${dir}/briefs/${id}.md`, md as string);
    const html = readFileSync(renderReport(dir, `${EX}/example_2/trace.jsonl`), "utf8");
    assert.equal((html.match(/class="did"/g) ?? []).length, api.cases.length);
    assert.ok(html.includes("since 2026-07-01"), "since falls back to the trace's run.start");
    assert.ok(/<section class="case"[^>]*><div class="did">/.test(html));
    assert.ok(html.includes("Model-proposed transform for SUP010"));
  });
});
