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
    await gen("x", { agent: "Investigator", purpose: "read lot codes fda:H-1-2026" });
    await gen("x", { agent: "Investigator", purpose: "judge NW-1 vs fda:H-1-2026" });
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(sent, ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-ultra-550b-a55b"]);
  assert.deepEqual(events.filter((e) => e.kind === "llm").map((e) => e.model), ["meterless:nvidia/nemotron-3.5-lightning-30b-a3b", "meterless:nvidia/nemotron-3-ultra-550b-a55b"]);
});

test("an unreachable Nightshift fails fast: no retries on a refused connection, and after 3 the run stops calling it", async () => {
  const { llmFromEnv, makeGenerator } = await import("../src/llm.ts");
  const cfg = llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t", LLM_RPM: "0" } as NodeJS.ProcessEnv);
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { calls++; throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:8088") }); }) as typeof fetch;
  const events: { kind: string; text?: string }[] = [];
  const trace = { runId: "r", emit: (kind: string, _a: string, d: { text?: string }) => events.push({ kind, ...d }) } as never;
  const gen = makeGenerator(cfg, trace);
  const t0 = Date.now();
  try {
    for (let i = 0; i < 5; i++) await assert.rejects(gen("x", { agent: "Investigator", purpose: "judge" }));
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls, 3);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(events.filter((e) => e.kind === "llm.retry").length, 0);
  assert.ok(events.some((e) => e.kind === "note" && /unreachable 3 times/.test(e.text ?? "")));
});

test("Scout Intent routing: every model task is classified; low-risk checked tasks go to the fast profile, the rest stay on the capable one", async () => {
  const { classify, profiles, route, INTENTS } = await import("../src/scout-intent.ts");
  const ps = profiles({ model: "nvidia/nemotron-3-ultra-550b-a55b", fastModel: "nvidia/nemotron-3.5-lightning-30b-a3b" });
  // Every purpose the agents use in the committed live traces maps to a known intent, and to the expected profile.
  const want: Record<string, string> = { "match.judge": "capable", "brief.check": "capable", "brief.write": "capable", "digest.write": "capable", "barcode.transform.propose": "capable", "lots.read": "fast" };
  const { readdirSync, readFileSync, existsSync } = await import("node:fs");
  let seen = 0;
  for (const d of readdirSync("examples/output").filter((d) => existsSync(`examples/output/${d}/trace.jsonl`))) {
    for (const l of readFileSync(`examples/output/${d}/trace.jsonl`, "utf8").trim().split("\n")) {
      const e = JSON.parse(l);
      if (e.kind !== "llm") continue;
      const i = classify(e.purpose);
      assert.notEqual(i.id, "other", e.purpose);
      assert.equal(route(i, ps).profile, want[i.id], e.purpose);
      seen++;
    }
  }
  assert.ok(seen > 40);
  assert.equal(INTENTS.length, Object.keys(want).length);
  assert.equal(classify("something new").risk, "high");
  assert.deepEqual(route(classify("read lot codes x"), ps).chain, ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-ultra-550b-a55b"]);
  assert.deepEqual(route(classify("judge a vs b"), ps).chain, ["nvidia/nemotron-3-ultra-550b-a55b"], "a high-risk task never falls back to a smaller model");
  assert.equal(route(classify("read lot codes x"), profiles({ model: "m" })).profile, "capable");
});

test("when the fast model fails, the profile's fallback runs the task and the trace says so; usage is recorded", async () => {
  const { llmFromEnv, makeGenerator } = await import("../src/llm.ts");
  const cfg = llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t", LLM_RPM: "0" } as NodeJS.ProcessEnv);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: { body: string }) => {
    const m = JSON.parse(init.body).model;
    if (/lightning/.test(m)) return new Response("model not available", { status: 404 });
    return new Response(JSON.stringify({ model: m, usage: { prompt_tokens: 120, completion_tokens: 8 }, choices: [{ message: { content: "[\"L1\"]" } }] }), { status: 200 });
  }) as typeof fetch;
  const events: { kind: string; [k: string]: unknown }[] = [];
  const trace = { runId: "r", emit: (kind: string, _a: string, d: object) => events.push({ kind, ...d }) } as never;
  try {
    assert.equal(await makeGenerator(cfg, trace)("x", { agent: "Investigator", purpose: "read lot codes fda:H-1-2026" }), '["L1"]');
  } finally { globalThis.fetch = realFetch; }
  const routes = events.filter((e) => e.kind === "route");
  assert.equal(routes[0].intent, "lots.read");
  assert.equal(routes[0].profile, "fast");
  assert.match(String(routes[1].reason), /fallback/);
  const llm = events.filter((e) => e.kind === "llm");
  assert.match(String(llm[0].output), /^ERROR/);
  assert.deepEqual(llm[1].usage, { prompt: 120, completion: 8 });
});

test("Scout Intent: a high-risk answer served by another model than the one requested is not used; a low-risk one is recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-llm-"));
  const trace = new Trace({ dir, quiet: true, runId: "llm-elsewhere" });
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ model: "some/smaller-model", choices: [{ message: { content: "SAME: x" } }] }), { status: 200 })) as typeof fetch;
  try {
    const gen = makeGenerator(llmFromEnv({ METERLESS_RUNTIME_TOKEN: "t", LLM_RPM: "0", METERLESS_FAST_MODEL: "" }), trace);
    await assert.rejects(gen("q", { purpose: "judge NW-1 vs fda:H-1", agent: "Investigator" }), /served by some\/smaller-model/);
    assert.equal(await gen("q", { purpose: "read lot codes fda:H-1", agent: "Investigator" }), "SAME: x");
  } finally { globalThis.fetch = real; }
  const evs = readFileSync(trace.file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "route" && (e.data?.served_elsewhere ?? e.served_elsewhere));
  assert.equal(evs.length, 2);
});
