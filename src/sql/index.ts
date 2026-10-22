import type { Trace } from "../trace.ts";
import { DuckSampleRunner, sampleCapturedAt } from "./duck.ts";
import type { SqlRunner } from "./types.ts";
import { ZetarisRunner } from "./zetaris.ts";

function zetarisCredentialsMissing(env: NodeJS.ProcessEnv): boolean {
  return !env.ZETARIS_BASE_URL?.trim() || !env.ZETARIS_USERNAME?.trim() || !env.ZETARIS_PASSWORD?.trim();
}

/** Build the SQL runner for this process. Sample mode when asked or when Zetaris creds are missing. */
export async function makeRunner(env: NodeJS.ProcessEnv, trace: Trace): Promise<SqlRunner> {
  if (env.SAMPLE_MODE === "true" || zetarisCredentialsMissing(env)) {
    const captured = sampleCapturedAt();
    console.warn(
      `SAMPLE MODE: local DuckDB stand-in over sample/ snapshots captured ${captured}; Zetaris is NOT used`,
    );
    const runner = new DuckSampleRunner({ trace });
    await runner.ready;
    return runner;
  }
  return new ZetarisRunner({
    baseUrl: env.ZETARIS_BASE_URL!,
    username: env.ZETARIS_USERNAME!,
    password: env.ZETARIS_PASSWORD!,
    orgId: env.ZETARIS_ORG_ID,
    trace,
  });
}

export type { SqlResult, SqlRunner } from "./types.ts";
export { sqlId } from "./types.ts";
export { coerceNumericFields, ZetarisRunner } from "./zetaris.ts";
export { toDuckDialect, DuckSampleRunner } from "./duck.ts";
