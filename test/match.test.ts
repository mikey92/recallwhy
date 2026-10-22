import { test } from "node:test";
import assert from "node:assert/strict";
import { candidates, designatorConflict, designators, grounded, indexCatalog, type Sku } from "../src/match.ts";
import type { Recall } from "../src/feeds.ts";

const recall = (p: Partial<Recall>): Recall => ({ id: "fda:X", feed: "fda_food", number: "X", date: "2026-10-01", reported: "2026-10-01", firm: "Acme Foods", title: "", text: "", reason: "", codeInfo: "", upcs: [], models: [], states: "unknown", ...p });
const sku = (p: Partial<Sku>): Sku => ({ sku: "NW-1", upc: "", title: "", brand: "", department: "Grocery", supplier_id: "SUP001", ...p });

test("designators skip sizes and years", () => {
  assert.deepEqual([...designators("Widget A100 16oz 5lb 2026")], ["a100"]);
});

test("a UPC printed in the notice makes a upc candidate", () => {
  const ix = indexCatalog([sku({ upc: "087906010187", title: "SPROUT MIX 5OZ", brand: "Everything Sprouts" })]);
  const c = candidates(recall({ upcs: ["087906010187"] }), ix);
  assert.equal(c[0]?.basis, "upc");
});

test("a text candidate needs the brand up front and a shared product word", () => {
  const skus = [sku({ sku: "NW-1", title: "CRUNCHY PROTEIN SPROUT MIX 5OZ", brand: "Everything Sprouts" }), sku({ sku: "NW-2", title: "PAPER TOWELS 6CT", brand: "Everything Sprouts" })];
  const r = recall({ firm: "Everything Sprouts, LLC", text: "Everything Sprouts Crunchy Protein Sprout Mix, Net Wt. 5.0 oz" });
  const c = candidates(r, indexCatalog(skus));
  assert.deepEqual(c.map((x) => x.sku.sku), ["NW-1"]);
  assert.equal(c[0].basis, "text");
});

test("grounded accepts copied words and rejects invented ones", () => {
  const r = recall({ text: "Saint Francis Apizza Frozen Pepperoni Pizza, Net Weight: 17 oz." });
  assert.equal(grounded("Frozen Pepperoni Pizza 17OZ", r), true);
  assert.equal(grounded("Frozen Cheese Pizza", r), false);
});

test("designatorConflict spots different model numbers", () => {
  const c = { sku: sku({ title: "HEATER MODEL A100" }), basis: "text" as const, evidence: "", brandWords: [], kindWords: [] };
  assert.ok(designatorConflict(c, recall({ text: "This recall involves heater model B200." })));
  assert.equal(designatorConflict(c, recall({ text: "This recall involves heater model A100." })), undefined);
});
