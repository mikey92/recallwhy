import { createHash } from "node:crypto";

export interface SqlResult {
  sqlId: string;
  engine: "zetaris" | "duckdb-sample";
  columns: string[];
  rows: Record<string, unknown>[];
  ms: number;
}

export interface SqlRunner {
  engine: SqlResult["engine"];
  run(sql: string, meta: { agent: string; purpose: string }): Promise<SqlResult>;
  close(): Promise<void>;
}

/** Same SQL always → same id. Normalise by trimming and collapsing whitespace. */
export function sqlId(sql: string): string {
  const normalised = sql.trim().replace(/\s+/g, " ");
  const hex = createHash("sha256").update(normalised).digest("hex").slice(0, 10);
  return `q-${hex}`;
}
