// Registers RecallWhy's sources in a Zetaris instance: the two live recall feeds
// (Lightning REST tables + schemastore views) and the two synthetic Postgres
// databases (JDBC datasources). Safe to re-run: "already exists" counts as done.
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { Trace } from "../src/trace.ts";
import { ZetarisRunner } from "../src/sql/zetaris.ts";

const env = loadConfig();
for (const k of ["ZETARIS_BASE_URL", "ZETARIS_USERNAME", "ZETARIS_PASSWORD"]) if (!env[k]) throw new Error(`${k} is not set (.env)`);
const trace = new Trace({ dir: "logs/setup", quiet: true });
const z = new ZetarisRunner({ baseUrl: env.ZETARIS_BASE_URL!, username: env.ZETARIS_USERNAME!, password: env.ZETARIS_PASSWORD!, orgId: env.ZETARIS_ORG_ID, trace });

const fill = (sql: string) => sql.replace(/\$\{(\w+)\}/g, (_, k) => { if (!env[k]) throw new Error(`${k} is not set (.env)`); return env[k]!; });
for (const file of ["sql/01_feeds.sql", "sql/02_retail_sources.sql"]) {
  const stmts = readFileSync(file, "utf8").split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  for (const stmt of stmts) {
    const label = stmt.replace(/\s+/g, " ").slice(0, 80);
    try { await z.run(fill(stmt), { agent: "Setup", purpose: label }); console.log(`ok       ${label}`); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already exists|already registered|duplicate/i.test(msg)) console.log(`exists   ${label}`);
      else { console.log(`FAILED   ${label}\n         ${msg.slice(0, 300)}`); process.exitCode = 1; }
    }
  }
}
for (const t of ["recallfeeds.fda_food", "recallfeeds.cpsc_recalls", "erp.skus", "erp.inventory", "erp.sales", "supplier_portal.ship_notices"]) {
  const r = await z.run(`SELECT COUNT(*) AS n FROM ${t}`, { agent: "Setup", purpose: `verify ${t}` });
  console.log(`${t.padEnd(30)} ${r.rows[0]?.n} rows`);
}
await z.close();
