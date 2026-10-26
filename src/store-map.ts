// "Where to pull": the run's pull lists on a map of the real store locations (data/real/stores.json,
// USDA SNAP Retailer Locator). Each store is a dot sized by the units to pull; red when the recall
// notice's own distribution list names the store's state (or says nationwide), amber when it does
// not — stock that travelled outside the notice's list is the case a distribution-only check misses.
// The same rows are printed as a table under the map, so the section reads without JavaScript.
import { existsSync, readFileSync } from "node:fs";

export interface MapStore { store_id: string; city: string; state: string; latitude: number; longitude: number }
export interface MapPoint { store_id: string; store: string; city: string; state: string; lat: number; lon: number; units: number; cases: { id: string; recall: string; units: number; inNotice: boolean }[] }
type Ev = { kind: string; about?: string; predicate?: string; value?: unknown };

/** "fda:H-1396-2026" → "H-1396-2026": the result's recall id carries the feed, the world-model entity a longer feed name. */
const num = (recall: string) => recall.replace(/^[^:]*:/, "");
/** How a recall is named on the page: FDA recall numbers read on their own (H-1355-2026); a CPSC number needs its feed (CPSC 27017). */
const recallName = (recall: string) => recall.startsWith("cpsc:") ? `CPSC ${num(recall)}` : num(recall);
const fmt = (n: number) => n.toLocaleString("en-US");
const count = (n: number, one: string, many: string) => `${fmt(n)} ${n === 1 ? one : many}`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A CSV row into fields (pull lists quote titles with commas). */
export function csvRow(line: string): string[] {
  const out: string[] = [];
  let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(f); f = ""; } else f += c;
  }
  out.push(f);
  return out;
}

/** Points per store from the run's pull lists; a recall's distribution states come from the Scout's world-model fact. */
export function storePoints(outDir: string, cases: { id: string; recall: string }[], evs: Ev[], stores: MapStore[]): MapPoint[] {
  const where = new Map(stores.map((s) => [s.store_id, s]));
  const dist = (recall: string) => {
    const e = [...evs].reverse().find((x) => x.kind === "world.write" && x.predicate === "notice_distribution_states" && x.about?.endsWith(`:${num(recall)}`));
    return e?.value;
  };
  const points = new Map<string, MapPoint>();
  for (const c of cases) {
    const f = `${outDir}/actions/${c.id}/pull-list.csv`;
    if (!existsSync(f)) continue;
    const [head, ...lines] = readFileSync(f, "utf8").trim().split("\n");
    const h = csvRow(head);
    const col = (r: string[], k: string) => r[h.indexOf(k)] ?? "";
    const states = dist(c.recall);
    for (const line of lines) {
      const r = csvRow(line);
      const s = where.get(col(r, "store_id"));
      if (!s) continue;
      const units = Number(col(r, "units_to_pull")) || 0;
      const p = points.get(s.store_id) ?? points.set(s.store_id, { store_id: s.store_id, store: col(r, "store"), city: s.city, state: s.state, lat: s.latitude, lon: s.longitude, units: 0, cases: [] }).get(s.store_id)!;
      p.units += units;
      const inNotice = states === "nationwide" || (Array.isArray(states) && states.includes(s.state));
      const k = p.cases.find((x) => x.id === c.id);
      if (k) k.units += units; else p.cases.push({ id: c.id, recall: c.recall, units, inNotice });
    }
  }
  return [...points.values()].sort((a, b) => b.units - a.units);
}

export function loadStores(file = "data/real/stores.json"): MapStore[] {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).stores as MapStore[]) : [];
}

/** d3.geoAlbersUsa's lower-48 projection (conic equal-area, parallels 29.5°/45.5°, rotate 96°, centre
 *  [-0.6°, 38.7°], scale 1300, translate [487.5, 305]): the projection data/geo/us-states.json was drawn with. */
export function albersUsa(lon: number, lat: number): [number, number] {
  const rad = Math.PI / 180, k = 1300;
  const s0 = Math.sin(29.5 * rad), n = (s0 + Math.sin(45.5 * rad)) / 2, c = 1 + s0 * (2 * n - s0), r0 = Math.sqrt(c) / n;
  const raw = (l: number, p: number) => { const r = Math.sqrt(c - 2 * n * Math.sin(p)) / n; return [r * Math.sin(l * n), r0 - r * Math.cos(l * n)]; };
  const [cx, cy] = raw(-0.6 * rad, 38.7 * rad);
  const [x, y] = raw((lon + 96) * rad, lat * rad);
  return [487.5 + (x - cx) * k, 305 - (y - cy) * k];
}

export function loadStatePaths(file = "data/geo/us-states.json"): Record<string, string> {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).states as Record<string, string>) : {};
}

export interface MapCase { id: string; recall: string; states: string[] | "nationwide" | "unknown" }

/** The recall's distribution states as the Scout recorded them in the world model. */
export function caseStates(cases: { id: string; recall: string }[], evs: Ev[]): MapCase[] {
  return cases.map((c) => {
    const e = [...evs].reverse().find((x) => x.kind === "world.write" && x.predicate === "notice_distribution_states" && x.about?.endsWith(`:${num(c.recall)}`));
    const v = e?.value;
    return { id: c.id, recall: c.recall, states: Array.isArray(v) ? (v as string[]) : v === "nationwide" ? "nationwide" : "unknown" };
  });
}

/** The report section: an inline SVG map (no network needed) plus the same rows as a table. Empty when nothing is to be pulled. */
export function storeMapSection(points: MapPoint[], mapCases: MapCase[], paths: Record<string, string>): string {
  if (!points.length) return "";
  const unitsOf = (id: string) => points.reduce((n, p) => n + (p.cases.find((k) => k.id === id)?.units ?? 0), 0);
  const acting = mapCases.filter((c) => unitsOf(c.id) > 0).sort((a, b) => unitsOf(b.id) - unitsOf(a.id));
  const outside = points.filter((p) => p.cases.some((c) => !c.inNotice));
  const total = points.reduce((n, p) => n + p.units, 0);
  const listed = (c: MapCase) => new Set(c.states === "nationwide" ? Object.keys(paths) : Array.isArray(c.states) ? c.states : []);
  // The map opens on the recall with the most units to pull; the picker switches recall.
  const first = acting[0];
  const named = first ? listed(first) : new Set<string>();
  const max = Math.max(...points.map((p) => p.units));
  const dot = (p: MapPoint) => {
    const [x, y] = albersUsa(p.lon, p.lat);
    const mine = first && p.cases.find((c) => c.id === first.id);
    return `<circle data-s="${p.store_id}" data-u="${p.units}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(5 + 13 * Math.sqrt((mine ? mine.units : p.units) / max)).toFixed(1)}" class="${mine && !mine.inNotice ? "d-out" : "d-in"}"${first && !mine ? ' style="display:none"' : ""}><title>${esc(p.store)} — ${esc(p.city)}, ${p.state}: ${count(p.units, "unit", "units")} to pull\n${p.cases.map((c) => `${recallName(c.recall)}: ${c.units}${c.inNotice ? "" : " (state not in the notice's list)"}`).join("\n")}</title></circle>`;
  };
  const svg = `<svg viewBox="0 0 975 610" role="img" aria-label="Map of the stores holding recalled lots" class="usmap">${Object.entries(paths).map(([st, d]) => `<path data-st="${st}" class="${named.has(st) ? "st-named" : "st"}" d="${d}"><title>${st}</title></path>`).join("")}${points.map(dot).join("")}</svg>`;
  const rows = points.map((p) => `<tr><td>${esc(p.store)}</td><td>${esc(p.city)}, ${p.state}</td><td class="n">${fmt(p.units)}</td><td>${p.cases.map((c) => `<a href="#${esc(c.id)}">${esc(recallName(c.recall))}</a> ${c.units}${c.inNotice ? "" : ` <span class="out">state not in the notice's list</span>`}`).join("<br>")}</td></tr>`).join("");
  const data = JSON.stringify(acting.map((c) => ({ id: c.id, st: c.states, s: Object.fromEntries(points.flatMap((p) => p.cases.filter((k) => k.id === c.id).map((k) => [p.store_id, [k.units, k.inNotice]]))) }))).replace(/</g, "\\u003c");
  const opt = (c: MapCase) => { const n = points.filter((p) => p.cases.some((k) => k.id === c.id && !k.inNotice)).length;
    return `<option value="${esc(c.id)}">${esc(recallName(c.recall))} — ${count(unitsOf(c.id), "unit", "units")}${n ? `, ${count(n, "store", "stores")} outside the notice's states` : ""}</option>`; };
  return `<section class="map storemap"><h2>Where to pull: ${count(total, "unit", "units")} in ${count(points.length, "store", "stores")}</h2>
<div class="sub">Store locations are real SNAP-authorized supermarkets (USDA FNS Retailer Locator); units come from the run's pull lists. Shaded states: the selected recall notice's own distribution list. <span class="k k-in"></span> store in a listed state · <span class="k k-out"></span> store in a state the notice does not list — the stock got there anyway, so checking the distribution list alone would miss it (${count(outside.length, "store", "stores")} in this run).</div>
<label class="pick">Recall <select id="mapcase">${acting.map(opt).join("")}<option value="">all ${acting.length} recalls (no shading)</option></select></label>
${svg}
<table class="pulls"><thead><tr><th>Store</th><th>Location</th><th>Units</th><th>Recall: units</th></tr></thead><tbody>${rows}</tbody></table>
<script>(() => { const D = ${data}; const sel = document.getElementById("mapcase"); if (!sel) return;
const paths = [...document.querySelectorAll(".usmap path")], dots = [...document.querySelectorAll(".usmap circle")];
const max = Math.max(...dots.map((d) => Number(d.dataset.u)));
sel.addEventListener("change", () => { const c = D.find((x) => x.id === sel.value);
  const named = new Set(!c ? [] : c.st === "nationwide" ? paths.map((p) => p.dataset.st) : Array.isArray(c.st) ? c.st : []);
  for (const p of paths) p.setAttribute("class", named.has(p.dataset.st) ? "st-named" : "st");
  for (const d of dots) { const k = c ? c.s[d.dataset.s] : [Number(d.dataset.u), true];
    d.style.display = k ? "" : "none"; if (!k) continue;
    d.setAttribute("r", (5 + 13 * Math.sqrt(k[0] / max)).toFixed(1)); d.setAttribute("class", k[1] ? "d-in" : "d-out"); }
}); })();</script></section>`;
}
