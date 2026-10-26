/**
 * Splits a SQL file into the statements Zetaris takes one at a time: ";" at the end of a line ends a
 * statement and "--" comment lines are dropped. A `COMPILE USL ... DDL` statement is one statement with
 * every `CREATE TABLE` that follows it (Zetaris compiles the whole model at once), so those parts are
 * joined back onto it.
 */
export function splitSql(text: string): string[] {
  const parts = text.split(/;\s*\n|;\s*$/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  const out: string[] = [];
  let inUsl = false;
  for (const p of parts) {
    if (/^COMPILE\s+USL\b/i.test(p)) { out.push(p); inUsl = true; continue; }
    if (inUsl && /^CREATE\s+TABLE\b/i.test(p)) { out[out.length - 1] += ";\n" + p; continue; }
    inUsl = false;
    out.push(p);
  }
  return out;
}
