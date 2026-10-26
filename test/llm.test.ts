import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { llmFromEnv, makeGenerator, makePacer } from "../src/llm.ts";
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

test("hosted NVIDIA models are paced to 4 calls a minute unless LLM_RPM says otherwise", () => {
  assert.equal(llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t" }).rpm, 4);
  assert.equal(llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t", LLM_RPM: "0" }).rpm, 0);
  assert.equal(llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t", LLM_RPM: "10" }).rpm, 10);
  assert.equal(llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t", METERLESS_MODEL: "meterless/auto" }).rpm, 0);
  assert.equal(llmFromEnv({ LLM_PROVIDER: "ollama" }).rpm, 0);
});

test("the pacer lets a burst through, then spaces calls evenly", async () => {
  let now = 0;
  const waits: number[] = [];
  const pace = makePacer(4, { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } });
  for (let i = 0; i < 6; i++) await pace();
  assert.deepEqual(waits, [15_000, 15_000], "4 at once, then one every 15 s");
  now += 60_000;
  waits.length = 0;
  for (let i = 0; i < 4; i++) await pace();
  assert.deepEqual(waits, [], "a quiet minute refills the bucket");
});

test("narrow checked tasks go to the small Nemotron; the judge stays on the main model; the trace names each", async () => {
  const { llmFromEnv, makeGenerator } = await import("../src/llm.ts");
  const cfg = llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t", LLM_RPM: "0" } as NodeJS.ProcessEnv);
  assert.equal(cfg.model, "nvidia/nemotron-3-ultra-550b-a55b");
  assert.equal(cfg.fastModel, "nvidia/nemotron-3.5-lightning-30b-a3b");
  assert.equal(llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t", METERLESS_FAST_MODEL: "" } as NodeJS.ProcessEnv).fastModel, undefined);
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: { body: string }) => { const m = JSON.parse(init.body).model; sent.push(m); return new Response(JSON.stringify({ model: m, choices: [{ message: { content: "ok" } }] }), { status: 200 }); }) as typeof fetch;
  const events: { kind: string; model?: string }[] = [];
  const trace = { runId: "r", emit: (kind: string, _a: string, d: { model?: string }) => events.push({ kind, ...d }) } as never;
  try {
    const gen = makeGenerator(cfg, trace);
    await gen("x", { agent: "Investigator", purpose: "read lot codes", tier: "fast" });
    await gen("x", { agent: "Investigator", purpose: "judge" });
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(sent, ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-ultra-550b-a55b"]);
  assert.deepEqual(events.filter((e) => e.kind === "llm").map((e) => e.model), ["meterless:nvidia/nemotron-3.5-lightning-30b-a3b", "meterless:nvidia/nemotron-3-ultra-550b-a55b"]);
});
