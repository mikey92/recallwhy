// Builds data/geo/us-states.json: one SVG path per state, from us-atlas states-albers-10m (ISC licence,
// derived from the US Census Bureau's cartographic boundary files), already projected with
// d3.geoAlbersUsa() at scale 1300, translate [487.5, 305] into a 975×610 box. Points closer than
// 1.2 px are dropped and coordinates rounded to whole pixels to keep the file small. src/store-map.ts projects store coordinates the
// same way, so stores land in their states.
//   npx tsx scripts/build-us-map.ts <path to us-atlas/states-albers-10m.json> <path to topojson-client.js>
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { US } from "../src/feeds.ts";

const [atlas, client] = process.argv.slice(2);
const topojson = createRequire(import.meta.url)(client);
const topo = JSON.parse(readFileSync(atlas, "utf8"));
const fc = topojson.feature(topo, topo.objects.states);
// Drops points within 1.2 px of the last kept one (the map is drawn at most ~1000 px wide).
const ring = (r: number[][]) => {
  const kept: number[][] = [];
  for (const p of r) { const q = kept[kept.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= 1.2) kept.push(p); }
  return kept.length < 3 ? "" : "M" + kept.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).join("L") + "Z";
};
const states: Record<string, string> = {};
for (const f of fc.features) {
  const code = US[String(f.properties.name).toLowerCase()];
  if (!code) continue;
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  states[code] = polys.flatMap((p: number[][][]) => p.map(ring)).join("");
}
writeFileSync("data/geo/us-states.json", JSON.stringify({ source: "us-atlas 3.0.1 states-albers-10m (ISC licence, Mike Bostock; from US Census Bureau cartographic boundary files), projected with d3.geoAlbersUsa scale 1300 translate [487.5,305]", width: 975, height: 610, states }) + "\n");
console.log(Object.keys(states).length, "states");
