import { test } from "node:test";
import assert from "node:assert/strict";
import { auditBrief } from "../src/agents/auditor.ts";
import { parseJudge } from "../src/agents/investigator.ts";

const evidence = "[E1] case on_hand_units = 383  (source: zetaris q-1)\n[E2] case stores_with_stock = 9  (source: zetaris q-1)";
const ids = new Set(["E1", "E2"]);

test("auditBrief accepts a cited paragraph with known numbers", () => {
  assert.deepEqual(auditBrief("We hold 383 units [E1] in 9 stores [E2].", ids, evidence), []);
});
test("auditBrief rejects missing citations, unknown ids and new numbers", () => {
  assert.ok(auditBrief("We hold 383 units.", ids, evidence).some((p) => p.includes("cites no evidence")));
  assert.ok(auditBrief("We hold 383 units [E7].", ids, evidence).some((p) => p.includes("E7")));
  assert.ok(auditBrief("We hold 500 units [E1].", ids, evidence).some((p) => p.includes("500")));
  assert.ok(auditBrief("We hold units in twelve stores [E2].", ids, evidence).some((p) => p.includes("twelve")));
});

test("parseJudge reads the judge's one-line answers", () => {
  assert.deepEqual(parseJudge("SAME: Frozen Pepperoni Pizza"), { label: "SAME", quote: "Frozen Pepperoni Pizza" });
  assert.equal(parseJudge("**DIFFERENT** - salsa roja")?.label, "DIFFERENT");
  assert.equal(parseJudge("UNSURE: no size given")?.label, "UNSURE");
  assert.equal(parseJudge("SAME")?.label, "SAME");
  assert.equal(parseJudge("I think maybe"), undefined);
});

import { redact } from "../src/trace.ts";
test("traces redact passwords in SQL and secret-named fields", () => {
  const r = redact({ sql: `CREATE DATASOURCE erp OPTIONS (username "u", password "hunter2")`, apiKey: "abc" });
  assert.ok(!JSON.stringify(r).includes("hunter2"));
  assert.equal(r.apiKey, "***");
});

import { dismissalNamesItem, dismissalSameLine, sizes } from "../src/agents/auditor.ts";
test("sizes normalises package sizes from labels and notices", () => {
  assert.deepEqual(sizes("PICO DE GALLO 7OZ"), ["7oz"]);
  assert.deepEqual(sizes("Net Wt: 10 oz. Keep Refrigerated"), ["10oz"]);
  assert.ok(sizes("SALAD 4/5# bag").includes("5lb"));
  assert.deepEqual(sizes("Net Wt. 5.0 oz (142 g)"), ["5oz", "142g"]);
});

test("a dismissal whose quote names every product word of our item is caught", () => {
  assert.equal(dismissalNamesItem("VITASIA ASIAN STYLE WOK SPICE 1.58OZ", "Lidl US Trading", "VITASIA ASIAN STYLE WOK SPICE MIX NET WT 1.58 OZ (45g)"), true);
  assert.equal(dismissalNamesItem("AMANA THROUGH THE WALL (TTW) AIR", "Daikin Comfort Technologies", "Amana Through the Wall (TTW) air conditioners or heat pumps"), true);
  assert.equal(dismissalNamesItem("WHOLE FOODS SPICY GUACAMOLE DIP", "WFM Purchasing", "Whole Foods Pomegranate Guacamole Dip"), false);
  assert.equal(dismissalNamesItem("RAISINS 15OZ", "Lehi Valley Trading", "Chocolate Covered Raisins"), false, "one product word is too little to overrule the judge");
});

test("a dismissal that quotes another size or variety of our line goes to a reviewer", () => {
  // Real misses from eval/REAL.md: a different egg count, a different pack of the same mix.
  assert.equal(dismissalSameLine("large eggs 18 pcs", "Brookshire's", "Brookshire's farm fresh, Large 12 Eggs, Net Wt 24 oz"), true);
  assert.equal(dismissalSameLine("Authentic Pounded Yam 32 oz", "(unknown)", "OLA-OLA Pounded Yam (Iyan) IYANINSTANT"), true);
  assert.equal(dismissalSameLine("Pico", "Whole Foods", "Pico De Gallo Mild"), true);
  // A different product of the same brand, or the same firm's other line, stays dismissed.
  assert.equal(dismissalSameLine("COBB SALAD WITH TURKEY & BACON", "Wal-Mart Stores, Inc.", "MARKETSIDE ICEBERG SALAD 10/24 oz"), false);
  assert.equal(dismissalSameLine("Pumpernickel Bagel", "Boichik", "OLA-OLA POUNDED GROUNDNUTS"), false);
  assert.equal(dismissalSameLine("Large Organic", "Kroger", "Kroger Large 12 Eggs"), false, "descriptive words alone are not a product");
});
