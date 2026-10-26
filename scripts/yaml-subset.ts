// A small YAML subset parser, enough for the Scout eval harness's evals/config/thresholds.yaml: comments,
// block mappings nested by indentation, block sequences, flow mappings `{ a: 1 }`, flow sequences `[a, b]`,
// and plain or quoted scalars (numbers, true/false, null, strings). Anything outside that subset throws,
// so a threshold can never be dropped silently. scripts/yaml-hooks.mjs resolves the runner's
// `import { parse } from "yaml"` to this file, so the upstream runner runs unchanged without the npm package.

type Value = unknown;

function stripComment(line: string): string {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(s: string): Value {
  const t = s.trim();
  if (t === "") return null;
  if (/^(null|~)$/.test(t)) return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^".*"$/.test(t)) return JSON.parse(t);
  if (/^'.*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  if (/^[&*!|>%@`]/.test(t)) throw new Error(`yaml-subset: unsupported scalar ${JSON.stringify(t)}`);
  return t;
}

/** Parse one flow value (`{...}`, `[...]` or a scalar) starting at s[i]; returns the value and the next index. */
function flow(s: string, i: number, stop: string): [Value, number] {
  while (s[i] === " ") i++;
  if (s[i] === "{" || s[i] === "[") {
    const obj = s[i] === "{";
    const out: Record<string, Value> | Value[] = obj ? {} : [];
    i++;
    for (;;) {
      while (s[i] === " ") i++;
      if (s[i] === (obj ? "}" : "]")) return [out, i + 1];
      if (i >= s.length) throw new Error("yaml-subset: unterminated flow collection");
      if (obj) {
        const colon = s.indexOf(":", i);
        if (colon < 0) throw new Error("yaml-subset: flow mapping entry without ':'");
        const key = String(scalar(s.slice(i, colon)));
        const [v, j] = flow(s, colon + 1, ",}");
        (out as Record<string, Value>)[key] = v;
        i = j;
      } else {
        const [v, j] = flow(s, i, ",]");
        (out as Value[]).push(v);
        i = j;
      }
      while (s[i] === " ") i++;
      if (s[i] === ",") i++;
    }
  }
  let j = i, q: string | null = null;
  for (; j < s.length; j++) {
    const c = s[j];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (stop.includes(c)) break;
  }
  return [scalar(s.slice(i, j)), j];
}

function inline(s: string): Value {
  const t = s.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    const [v, j] = flow(t, 0, "");
    if (t.slice(j).trim()) throw new Error(`yaml-subset: trailing text after flow value: ${t.slice(j)}`);
    return v;
  }
  return scalar(t);
}

export function parse(src: string): Value {
  const lines = src.split(/\r?\n/).map(stripComment).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim() !== "" && l.trim() !== "---");
  for (const l of lines) if (/^\s*\t/.test(l)) throw new Error("yaml-subset: tab indentation");
  let p = 0;
  const indent = (l: string) => l.length - l.trimStart().length;

  function block(ind: number): Value {
    if (p >= lines.length) return null;
    if (lines[p].trimStart().startsWith("- ") || lines[p].trim() === "-") {
      const arr: Value[] = [];
      while (p < lines.length && indent(lines[p]) === ind && lines[p].trimStart().startsWith("-")) {
        const rest = lines[p].trimStart().slice(1).trim();
        p++;
        if (rest === "") arr.push(p < lines.length && indent(lines[p]) > ind ? block(indent(lines[p])) : null);
        else if (/^[^{["'][^:]*:(\s|$)/.test(rest)) throw new Error("yaml-subset: block mapping inside a sequence item is not supported");
        else arr.push(inline(rest));
      }
      return arr;
    }
    const obj: Record<string, Value> = {};
    while (p < lines.length && indent(lines[p]) === ind) {
      const line = lines[p].trim();
      const m = line.match(/^("[^"]*"|'[^']*'|[^:{}[\],#]+?)\s*:(\s+(.*))?$/);
      if (!m) throw new Error(`yaml-subset: cannot parse line ${JSON.stringify(line)}`);
      const key = String(scalar(m[1]));
      p++;
      if (m[3] !== undefined && m[3] !== "") obj[key] = inline(m[3]);
      else obj[key] = p < lines.length && indent(lines[p]) > ind ? block(indent(lines[p])) : null;
    }
    if (p < lines.length && indent(lines[p]) > ind) throw new Error(`yaml-subset: unexpected indentation at ${JSON.stringify(lines[p])}`);
    return obj;
  }

  const v = block(lines.length ? indent(lines[0]) : 0);
  if (p < lines.length) throw new Error(`yaml-subset: could not parse from ${JSON.stringify(lines[p])}`);
  return v;
}
