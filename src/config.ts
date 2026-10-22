import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Tiny .env loader. Merges file values under process.env (env wins). Never prints values. */
export function loadConfig(envPath = resolve(process.cwd(), ".env")): NodeJS.ProcessEnv {
  const fromFile: Record<string, string> = {};
  if (existsSync(envPath)) {
    const text = readFileSync(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      fromFile[key] = val;
    }
  }
  return { ...fromFile, ...process.env };
}
