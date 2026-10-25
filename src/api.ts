// Programmatic entry point for judges and scripts.
//   npm run api            → http://127.0.0.1:8000 (HOST=0.0.0.0 in the container)
//   curl -X POST localhost:8000/run -H 'Content-Type: application/json' -d @examples/input/example_1.json
// POST /run {since, only?, limit?} → JSON: verdict per case, briefs, trace path. One run at a time.
// GET /runs/<runId>/trace → the run's JSONL trace; GET /runs/<runId>/report → its HTML report.
// GET /queue → cases escalated to a human; POST /decide {recall, sku, verdict, note?} → store a reviewer's decision.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { decide, inQueue, reviewQueue, runOnce } from "./app.ts";

const PORT = Number(process.env.PORT ?? 8000);
// Local by default; the container sets HOST=0.0.0.0. With API_TOKEN set, every POST needs "Authorization: Bearer <token>".
const HOST = process.env.HOST ?? "127.0.0.1";
const TOKEN = process.env.API_TOKEN;
const MAX_BODY = 64 * 1024;
let busy = false;

async function body(req: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) throw new Error("too large"); chunks.push(c as Buffer); }
  return Buffer.concat(chunks).toString("utf8");
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const send = (code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body, null, 2)); };
  if (req.method === "GET" && url.pathname === "/health") return send(200, { ok: true, busy });
  // The files a run wrote, so a judge running the container can read them without a volume mount.
  const file = url.pathname.match(/^\/runs\/([\w-]+)\/(trace|report)$/);
  if (req.method === "GET" && file) {
    const [, id, kind] = file;
    const path = kind === "trace" ? `logs/trace-${id}.jsonl` : `out/${id}/report.html`;
    if (!existsSync(path)) return send(404, { error: `no ${kind} for run ${id}` });
    res.writeHead(200, { "Content-Type": kind === "trace" ? "application/x-ndjson" : "text/html; charset=utf-8" });
    return void res.end(readFileSync(path));
  }
  if (req.method === "GET" && url.pathname === "/queue") return send(200, reviewQueue());
  if (req.method === "POST") {
    if (TOKEN && req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "missing or wrong API token" });
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return send(415, { error: "send Content-Type: application/json" });
    if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) return send(413, { error: "body too large" });
  }
  if (req.method === "POST" && url.pathname === "/decide") {
    let d: { recall?: unknown; sku?: unknown; verdict?: unknown; note?: unknown };
    try { d = JSON.parse(await body(req) || "{}"); } catch (e) { return (e as Error).message === "too large" ? send(413, { error: "body too large" }) : send(400, { error: "body must be JSON" }); }
    if (typeof d.recall !== "string" || typeof d.sku !== "string" || (d.verdict !== "same" && d.verdict !== "not-this"))
      return send(400, { error: 'body must be {"recall": "H-1407-2026", "sku": "NW-100005", "verdict": "same" | "not-this", "note"?: "..."}' });
    // Only pairs the agents escalated can be decided here, so the API cannot plant decisions on arbitrary recalls.
    if (!inQueue(d.recall, d.sku)) return send(409, { error: `${d.sku} for ${d.recall} is not in the review queue (GET /queue)` });
    return send(200, { stored: true, ...decide(d.recall, d.sku, d.verdict, typeof d.note === "string" ? d.note.slice(0, 300) : undefined), usedOn: "the next POST /run" });
  }
  if (req.method !== "POST" || url.pathname !== "/run") return send(404, { error: "use POST /run, GET /runs/<runId>/trace, GET /runs/<runId>/report, GET /queue, POST /decide or GET /health" });
  if (busy) return send(409, { error: "a run is already in progress; try again when it finishes" });
  let input: { since?: string; only?: string[]; limit?: number };
  try {
    const text = await body(req);
    input = text ? JSON.parse(text) : {};
  } catch (e) {
    if ((e as Error).message === "too large") return send(413, { error: "body too large" });
    return send(400, { error: "body must be JSON like {\"since\":\"2026-09-15\",\"limit\":5}" });
  }
  if (input.since && !/^\d{4}-\d{2}-\d{2}$/.test(input.since)) return send(400, { error: "since must be YYYY-MM-DD" });
  if (input.only && (!Array.isArray(input.only) || input.only.some((x) => typeof x !== "string"))) return send(400, { error: "only must be a list of recall numbers" });
  if (input.limit !== undefined && !(Number.isInteger(input.limit) && input.limit > 0 && input.limit <= 50)) return send(400, { error: "limit must be an integer 1-50" });
  busy = true;
  try {
    const r = await runOnce(loadConfig(), { since: input.since ?? "2026-09-15", only: input.only, limit: input.limit ?? 5 });
    send(200, r);
  } catch (e) {
    send(500, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    busy = false;
  }
}

// A bad request or a half-written file must not take the server down.
createServer((req, res) => { handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) res.writeHead(500); res.end(); }); }).listen(PORT, HOST, () => console.log(`RecallWhy API on http://${HOST}:${PORT}  (POST /run, GET /health)`));
