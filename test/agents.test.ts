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

test("a dismissal that quotes another size or count of our line goes to a reviewer; another flavour stays dismissed", () => {
  // Real misses from eval/REAL.md: a different egg count, a one-word item title.
  assert.equal(dismissalSameLine("large eggs 18 pcs", "Brookshire's", "Brookshire's farm fresh, Large 12 Eggs, Net Wt 24 oz"), true);
  assert.equal(dismissalSameLine("Pico", "Whole Foods", "Pico De Gallo Mild"), true);
  // Another flavour or product of the same brand stays dismissed.
  assert.equal(dismissalSameLine("Mango Pico De Gallo", "Taylor Farms", "Hot Pico De Gallo"), false);
  assert.equal(dismissalSameLine("Mixed Berry Date-Sweetened Chocolate", "Spring & Mulberry", "Spring & Mulberry Mango Chili Date-Sweetened Chocolate"), false);
  assert.equal(dismissalSameLine("COBB SALAD WITH TURKEY & BACON", "Wal-Mart Stores, Inc.", "MARKETSIDE ICEBERG SALAD 10/24 oz"), false);
  assert.equal(dismissalSameLine("Large Organic", "Kroger", "Kroger Large 12 Eggs"), false, "descriptive words alone are not a product");
});

test("a brief may not say the notice names our lots when it names none", async () => {
  const { saysNoticeNamesLots } = await import("../src/agents/briefer.ts");
  assert.equal(saysNoticeNamesLots("Our inventory holds all lots named in the notice, 639 units in 8 stores [E9]."), true);
  assert.equal(saysNoticeNamesLots("The notice lists lot 720106 [E3], and we hold that exact lot [E9]."), true);
  assert.equal(saysNoticeNamesLots("The notice does not limit the recall to specific lots, so all 639 units we hold are affected [E9]."), false);
  assert.equal(saysNoticeNamesLots("Our inventory matches the recalled product and, because the notice names no lot codes, every lot we hold is treated as affected [E6]."), false);
  assert.equal(saysNoticeNamesLots("The notice does not list any lots, so every lot counts [E7]."), false);
  assert.equal(saysNoticeNamesLots("Decathlon recalled the bicycles because the fork can break [E4]; we hold 639 units in 8 stores [E9]."), false);
});
