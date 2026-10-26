// Runs SQL against Zetaris one statement at a time and prints each result (first rows, row count, ms).
// Statements are separated by ";" at the end of a line; "--" comment lines are dropped.
//   npx tsx scripts/zetaris-sql.ts <file.sql> [--rows 10]      or   npx tsx scripts/zetaris-sql.ts -e "SHOW DATASOURCES"
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { Trace } from "../src/trace.ts";
import { ZetarisRunner } from "../src/sql/zetaris.ts";
import { splitSql } from "../src/sql/split.ts";

const args = process.argv.slice(2);
const flag = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const show = Number(flag("rows") ?? 10);
const inline = args[0] === "-e" ? args[1] : undefined;
const text = inline ?? readFileSync(args[0], "utf8");
const stmts = splitSql(text);

const env = loadConfig();
const trace = new Trace({ dir: "logs/setup", quiet: true });
const z = new ZetarisRunner({ baseUrl: env.ZETARIS_BASE_URL!, username: env.ZETARIS_USERNAME!, password: env.ZETARIS_PASSWORD!, orgId: env.ZETARIS_ORG_ID, trace });
let failed = 0;
for (const stmt of stmts) {
  const label = stmt.replace(/\s+/g, " ").slice(0, 110);
  try {
    const r = await z.run(stmt, { agent: "Setup", purpose: label });
    console.log(`ok   ${r.ms}ms ${r.rows.length} row(s)  ${label}`);
    for (const row of r.rows.slice(0, show)) console.log("     ", JSON.stringify(row).slice(0, 300));
  } catch (e) {
    failed++;
    console.log(`FAIL ${label}\n      ${(e instanceof Error ? e.message : String(e)).slice(0, 400)}`);
  }
}
await z.close();
process.exitCode = failed ? 1 : 0;
