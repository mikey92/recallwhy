import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { albersUsa, loadStatePaths, loadStores, storePoints, caseStates, storeMapSection } from "../src/store-map.ts";

// Even-odd point-in-polygon over every ring of a state's SVG path.
function inside(d: string, [x, y]: [number, number]): boolean {
  let hit = false;
  for (const ring of d.split("Z").filter(Boolean)) {
    const pts = ring.replace(/^M/, "").split("L").map((p) => p.split(",").map(Number));
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

// Coastal stores (Seattle on Puget Sound) can sit a few pixels off the simplified outline.
const near = (d: string, [x, y]: [number, number], px: number) => d.replace(/[MZ]/g, "L").split("L").filter(Boolean).some((p) => { const [a, b] = p.split(",").map(Number); return Math.hypot(a - x, b - y) <= px; });

test("every real store projects inside (or within 6 px of) its own state on the map", () => {
  const paths = loadStatePaths();
  const stores = loadStores();
  assert.equal(stores.length, 24);
  for (const s of stores) {
    const xy = albersUsa(s.longitude, s.latitude);
    assert.ok(inside(paths[s.state], xy) || near(paths[s.state], xy, 6), `${s.store_id} ${s.city}, ${s.state}`);
  }
});

test("the map marks a store outside the notice's distribution states", () => {
  const dir = mkdtempSync(`${tmpdir()}/rw-map-`);
  mkdirSync(`${dir}/actions/case-1`, { recursive: true });
  writeFileSync(`${dir}/actions/case-1/pull-list.csv`, 'store_id,store,city,state,sku,upc,item,lot_code,units_to_pull\nS005,Northwind #005 Seattle,Seattle,WA,NW-1,1,"Salsa, mild",L1,7\nS023,Northwind #023 Buford,Buford,GA,NW-1,1,"Salsa, mild",L1,3\n');
  const cases = [{ id: "case-1", recall: "fda:H-1-2026" }];
  const evs = [{ kind: "world.write", about: "recall:fda_food:H-1-2026", predicate: "notice_distribution_states", value: ["GA", "FL"] }];
  const pts = storePoints(dir, cases, evs, loadStores());
  assert.deepEqual(pts.map((p) => [p.store_id, p.units, p.cases[0].inNotice]), [["S005", 7, false], ["S023", 3, true]]);
  const html = storeMapSection(pts, caseStates(cases, evs), loadStatePaths());
  assert.match(html, /Where to pull: 10 units in 2 stores/);
  assert.match(html, /data-st="GA" class="st-named"/);
  assert.match(html, /data-st="WA" class="st"/);
  assert.match(html, /data-s="S005"[^>]*class="d-out"/);
  assert.equal(storeMapSection([], [], {}), "");
});
