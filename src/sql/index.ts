import type { Trace } from "../trace.ts";
import { DuckSampleRunner, sampleCapturedAt } from "./duck.ts";
import type { SqlRunner } from "./types.ts";
import { ZetarisRunner } from "./zetaris.ts";

function zetarisCredentialsMissing(env: NodeJS.ProcessEnv): boolean {
  return !env.ZETARIS_BASE_URL?.trim() || !env.ZETARIS_USERNAME?.trim() || !env.ZETARIS_PASSWORD?.trim();
}

async function sampleRunner(trace: Trace): Promise<SqlRunner> {
  console.warn(`SAMPLE MODE: local DuckDB stand-in over sample/ snapshots captured ${sampleCapturedAt()}; Zetaris is NOT used`);
  const runner = new DuckSampleRunner({ trace });
  await runner.ready;
  return runner;
}

/**
 * Build the SQL runner for this process. Sample mode when asked or when Zetaris creds are missing.
 * If Zetaris is configured but does not answer, the run falls back to sample mode and says so in
 * the trace (set ZETARIS_FALLBACK=false to fail instead).
 */
export async function makeRunner(env: NodeJS.ProcessEnv, trace: Trace): Promise<SqlRunner> {
  if (env.SAMPLE_MODE === "true" || zetarisCredentialsMissing(env)) return sampleRunner(trace);
  const runner = new ZetarisRunner({
    baseUrl: env.ZETARIS_BASE_URL!,
    username: env.ZETARIS_USERNAME!,
    password: env.ZETARIS_PASSWORD!,
    orgId: env.ZETARIS_ORG_ID,
    trace,
  });
  try {
    await runner.run("SHOW DATASOURCES", { agent: "Orchestrator", purpose: "check Zetaris is reachable" });
    return runner;
  } catch (e) {
    if (env.ZETARIS_FALLBACK === "false") throw e;
    const reason = e instanceof Error ? e.message : String(e);
    trace.emit("note", "Orchestrator", { text: `Zetaris did not answer (${reason}); falling back to sample mode for this run` });
    await runner.close();
    return sampleRunner(trace);
  }
}

export type { SqlResult, SqlRunner } from "./types.ts";
export { sqlId } from "./types.ts";
export { coerceNumericFields, ZetarisRunner } from "./zetaris.ts";
export { toDuckDialect, DuckSampleRunner } from "./duck.ts";
