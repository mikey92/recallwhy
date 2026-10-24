import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmFromEnv, makeGenerator } from "../src/llm.ts";
import { Trace } from "../src/trace.ts";

test("Meterless Nightshift is the default provider", () => {
  const cfg = llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t" });
  assert.equal(cfg.provider, "meterless");
  assert.equal(cfg.baseUrl, "http://127.0.0.1:8088/v1");
  assert.equal(cfg.model, "nvidia/nemotron-3-ultra-550b-a55b", "a named Nemotron model, not meterless/auto, which may route elsewhere");
  assert.equal(llmFromEnv({ LLM_PROVIDER: "ollama" }).provider, "ollama");
});

test("Nightshift calls carry the app headers and the trace records the model that answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-llm-"));
  const trace = new Trace({ dir, quiet: true, runId: "llm-test" });
  const seen: { url: string; headers: Record<string, string>; body: { model: string } }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ model: "nvidia/nemotron-3-super-120b-a12b", choices: [{ message: { content: "<think>x</think>SAME: pizza" } }], meterless: { receipt_id: "r-1" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const gen = makeGenerator(llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t", METERLESS_MODEL: "nvidia/nemotron-3-super-120b-a12b" }), trace);
    assert.equal(await gen("q", { purpose: "judge", agent: "Investigator" }), "SAME: pizza");
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(seen[0].url, "http://127.0.0.1:8088/v1/chat/completions");
  assert.equal(seen[0].headers["meterless-app"], "recallwhy");
  assert.equal(seen[0].headers["meterless-scope"], "user");
  assert.equal(seen[0].body.model, "nvidia/nemotron-3-super-120b-a12b");
  const ev = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.kind === "llm");
  assert.equal(ev.data?.served_model ?? ev.served_model, "nvidia/nemotron-3-super-120b-a12b");
  assert.ok(!readFileSync(trace.file, "utf8").includes("Bearer"), "the token never reaches the trace");
});
