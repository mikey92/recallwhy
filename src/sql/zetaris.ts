import { randomUUID } from "node:crypto";
import type { Trace } from "../trace.ts";
import { sqlId, type SqlResult, type SqlRunner } from "./types.ts";

const TIMEOUT_MS = 120_000;
const DEFAULT_LIMIT = 5000;

// Only aggregate-style columns become numbers. Identifiers such as UPCs, lot codes and
// yyyymmdd dates stay strings even when they are all digits (leading zeros matter).
const NUMERIC_COL =
  /(^n$|^n_|_n$|_units$|_count$|units$|on_hand$|customers$|^stores$|^lots$)/i;

/** Convert numeric-looking strings in count/units columns. */
export function coerceNumericFields(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    const s = value.trim();
    if (s === "") {
      out[key] = value;
      continue;
    }
    const named = NUMERIC_COL.test(key);
    const numericLooking = /^-?\d+(\.\d+)?$/.test(s);
    if (named && numericLooking) {
      out[key] = Number(s);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface ZetarisOpts {
  baseUrl: string;
  username: string;
  password: string;
  orgId?: string;
  trace: Trace;
  limit?: number;
  fetchFn?: typeof fetch;
}

export class ZetarisRunner implements SqlRunner {
  readonly engine = "zetaris" as const;
  private baseUrl: string;
  private username: string;
  private password: string;
  private orgId: string | undefined;
  private idToken: string | undefined;
  private trace: Trace;
  private limit: number;
  private fetchFn: typeof fetch;

  constructor(opts: ZetarisOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.username = opts.username;
    this.password = opts.password;
    this.orgId = opts.orgId;
    this.trace = opts.trace;
    this.limit = opts.limit ?? DEFAULT_LIMIT;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async login(): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-ID": randomUUID(),
      },
      body: JSON.stringify({ username: this.username, password: this.password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const body = (await res.json()) as { msg?: string };
        if (body.msg) msg = body.msg;
      } catch {
        /* ignore */
      }
      throw new Error(`Zetaris login failed ${res.status}: ${msg}`);
    }
    const body = (await res.json()) as { idToken: string; orgId?: string };
    this.idToken = body.idToken;
    if (body.orgId) this.orgId = body.orgId;
  }

  private async ensureAuth(): Promise<void> {
    if (!this.idToken) await this.login();
  }

  private async runQuery(sql: string): Promise<{ headers: string[]; data: string[][]; timeUsed?: number }> {
    await this.ensureAuth();
    const doFetch = () =>
      this.fetchFn(`${this.baseUrl}/api/proxy/sql-editor/sqls/run-query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.idToken}`,
          "X-Org-ID": this.orgId ?? "",
          "X-Request-ID": randomUUID(),
        },
        body: JSON.stringify({ sql, limit: this.limit }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

    let res = await doFetch();
    if (res.status === 401) {
      await this.login();
      res = await doFetch();
    }
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const body = (await res.json()) as { msg?: string };
        if (body.msg) msg = body.msg;
      } catch {
        /* ignore */
      }
      throw new Error(`Zetaris query failed ${res.status}: ${msg}`);
    }
    return (await res.json()) as { headers: string[]; data: string[][]; total: number; timeUsed: number };
  }

  async run(sql: string, meta: { agent: string; purpose: string }): Promise<SqlResult> {
    const id = sqlId(sql);
    const t0 = Date.now();
    try {
      const raw = await this.runQuery(sql);
      const columns = raw.headers ?? [];
      const rows = (raw.data ?? []).map((cells) => {
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < columns.length; i++) {
          obj[columns[i]!] = cells[i];
        }
        return coerceNumericFields(obj);
      });
      const ms = Date.now() - t0;
      const result: SqlResult = { sqlId: id, engine: this.engine, columns, rows, ms };
      this.trace.emit("sql", meta.agent, {
        engine: this.engine,
        sqlId: id,
        purpose: meta.purpose,
        sql,
        rows: rows.length,
        ms,
      });
      return result;
    } catch (err) {
      const ms = Date.now() - t0;
      const error = err instanceof Error ? err.message : String(err);
      this.trace.emit("sql.error", meta.agent, {
        engine: this.engine,
        sqlId: id,
        purpose: meta.purpose,
        sql,
        rows: 0,
        ms,
        error,
      });
      throw err;
    }
  }

  async close(): Promise<void> {
    /* no persistent connection */
  }
}
