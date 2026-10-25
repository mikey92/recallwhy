import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { barcodeMetrics, barcodePath, buildPairs, hideBarcodes, judgePair, makeCtx, metrics, stripUpcs } from "../eval/real-items.ts";
import { fdcTitle, gtinKey, pickNegatives, printedKeys, type RealItem, type RealNegative } from "../scripts/build-real-catalog.ts";
import type { Generator } from "../src/llm.ts";

const row = (recall_number: string, recalling_firm: string, product_description: string, code_info = "", event_id = recall_number) =>
  ({ recall_number, recalling_firm, product_description, code_info, event_id, reason_for_recall: "Salmonella", distribution_pattern: "CA, NV", report_date: "20260901", recall_initiation_date: "20260820" });

const item = (id: string, upc: string, recall_numbers: string[], title: string, brand = "D'Dioses Fruit Pops, Inc.", source: RealItem["source"] = "fdc"): RealItem =>
  ({ id, source, upc, title, brand, printedUpc: upc, recall_numbers });

const rows = [
  row("H-1166-2026", "D'Dioses Fruit Pops, Inc.", "Ice Pop, D'Dioses Nuez, 1 Bar (81.7 g), with UPC 827912008548"),
  row("H-1167-2026", "D'Dioses Fruit Pops, Inc.", "Ice Pop, D'Dioses Nuez, family pack", "UPC 8279120085480", "H-1166-2026"), // same event: not a negative
  row("H-1200-2026", "D'Dioses Fruit Pops, Inc.", "Ice Pop, D'Dioses Fresa (strawberry), 1 Bar, UPC 8 27912 00849 4"),
  row("H-1258-2026", "H & U Inc. dba Sun Noodle", "Sura Tanmen Hot and Sour Flavor Premium Japanese Noodles & Soup Base, UPC 085315054108 Item #05410"),
  row("H-1180-2026", "Green Jeeva LLC", "Organic Moringa Powder; 15kg/bag (bulk); Product code: GJ96"),
  row("H-1300-2026", "Nissin Foods (USA) Co.", "Hot and Spicy Ramen Noodles, 3 oz cup"),
];

test("gtinKey normalises every printed and catalog form of a barcode to one key", () => {
  assert.equal(gtinKey("00827912008548"), "827912008548", "GTIN-14 with packaging zeros");
  assert.equal(gtinKey("0827912008548"), "827912008548", "EAN-13 form of a UPC-A");
  assert.equal(gtinKey("8 27912-00854 8"), "827912008548", "printed with spaces and dashes");
  assert.equal(gtinKey("00175029"), "000000175029", "a GTIN-8 pads to 12");
  assert.equal(gtinKey("4056489125846"), "4056489125846", "a real EAN-13 keeps 13 digits");
  assert.ok(printedKeys("10827912008491").includes("827912008494"), "a GTIN-14 case code is also tried as the unit's barcode");
  assert.ok(printedKeys("82791200849").includes("827912008494"), "an 11-digit print gets its check digit");
});

test("fdcTitle appends the package weight only when the description names no size", () => {
  assert.equal(fdcTitle({ description: "POWDERED SUGAR", package_weight: "2 lbs/907 g" }), "POWDERED SUGAR 2 lbs");
  assert.equal(fdcTitle({ description: "LENTIL SOUP, 14.5 OZ.", package_weight: "14.5 oz" }), "LENTIL SOUP, 14.5 OZ.");
  assert.equal(fdcTitle({ description: "EGGS", package_weight: "" }), "EGGS");
});

test("pickNegatives takes same-brand products that are a different product: other barcode, other words, never printed, other category first", () => {
  const pool = [
    { fdc_id: "1", brand_owner: "Kroger", brand_name: "KROGER", gtin_upc: "", branded_food_category: "Eggs", package_weight: "", description: "LARGE EGGS", key: "011110609038" },
    { fdc_id: "2", brand_owner: "Kroger", brand_name: "KROGER", gtin_upc: "", branded_food_category: "Eggs", package_weight: "", description: "Large Eggs", key: "011110609039" }, // same words, other case
    { fdc_id: "3", brand_owner: "Kroger", brand_name: "KROGER", gtin_upc: "", branded_food_category: "Eggs", package_weight: "", description: "JUMBO EGGS", key: "011110609052" }, // printed in a notice
    { fdc_id: "4", brand_owner: "Kroger", brand_name: "KROGER", gtin_upc: "", branded_food_category: "Milk", package_weight: "", description: "WHOLE MILK", key: "011110400000" },
    { fdc_id: "5", brand_owner: "Kroger", brand_name: "KROGER", gtin_upc: "", branded_food_category: "Eggs", package_weight: "", description: "LARGE BROWN EGGS", key: "011110609100" },
    { fdc_id: "6", brand_owner: "Kroger", brand_name: "KROGER", gtin_upc: "", branded_food_category: "Bread", package_weight: "", description: "LARGE WHITE BREAD", key: "011110500000" },
  ];
  const picked = pickNegatives({ key: "011110609038", description: "LARGE EGGS", category: "Eggs" }, pool, new Set(["011110609052"]));
  assert.deepEqual(picked.map((r) => r.fdc_id), ["6", "4"], "other categories first, the one sharing a word ahead of the one sharing none");
  assert.deepEqual(pickNegatives({ key: "011110609038", description: "LARGE EGGS", category: "Eggs" }, pool.slice(0, 3).concat(pool[4]), new Set(["011110609052"])).map((r) => r.fdc_id), ["5"], "same category only when there is nothing else");
});

test("stripUpcs removes every printed barcode form and leaves sizes and short numbers", () => {
  const t = stripUpcs("Ice Pop, 1 Bar (81.7 g), with UPC 827912008548 and UPC 8 27912 00849 4; GTIN 00827912008494; lot 2026A");
  assert.ok(!/\d{11,}/.test(t.replace(/[ \-]/g, "")), t);
  assert.ok(t.includes("81.7 g") && t.includes("1 Bar") && t.includes("lot 2026A"), t);
  assert.ok(!/UPC/.test(t), "the UPC label goes with the number");
});

const nuez = item("FDC-1", "827912008548", ["H-1166-2026"], "D'DIOSES NUEZ ICE POP 1 BAR");
const noodles = item("OFF-1", "085315054108", ["H-1258-2026"], "Sura Tanmen Noodles", "Sun Noodle", "off");
const sibling: RealNegative = { id: "FDC-9", upc: "827912008999", title: "D'DIOSES MANGO CHILI ICE POP", brand: "D'Dioses Fruit Pops, Inc.", fdcId: "9", forItem: "FDC-1" };
const siblingPrinted: RealNegative = { id: "FDC-8", upc: "827912008548", title: "D'DIOSES NUEZ PALETA", brand: "D'Dioses Fruit Pops, Inc.", fdcId: "8", forItem: "FDC-1" }; // a second record of the recalled barcode

test("buildPairs: one positive per printing notice, one other-notice negative per item (never the same event), same-brand negatives against the sibling's notices", () => {
  const pairs = buildPairs({ items: [nuez, noodles], negatives: [sibling, siblingPrinted] }, rows);
  const pos = pairs.filter((p) => p.kind === "positive");
  assert.deepEqual(pos.map((p) => `${p.item.id}@${p.recall.number}`).sort(), ["FDC-1@H-1166-2026", "FDC-1@H-1167-2026", "OFF-1@H-1258-2026"]);
  const other = pairs.filter((p) => p.kind === "other-notice");
  assert.equal(other.length, 2);
  assert.equal(other.find((p) => p.item.id === "FDC-1")!.recall.number, "H-1200-2026", "same firm, different variety is the hard negative");
  assert.equal(other.find((p) => p.item.id === "OFF-1")!.recall.number, "H-1300-2026", "best word overlap when the firm never recalled anything else");
  const same = pairs.filter((p) => p.kind === "same-brand");
  assert.deepEqual(same.map((p) => `${p.item.id}@${p.recall.number}`).sort(), ["FDC-9@H-1166-2026", "FDC-9@H-1167-2026"], "a sibling whose barcode a notice prints is not a negative there");
  assert.ok(pairs.every((p) => (p.kind === "positive") === (p.label === "same")));
  const hidden = hideBarcodes(pos[0].recall);
  assert.deepEqual(hidden.upcs, []);
  assert.ok(!/\d{11,}/.test(`${hidden.text} ${hidden.codeInfo}`.replace(/[ \-]/g, "")));
});

test("judgePair runs decide → audit → revise with a fake judge, and the judge never sees a barcode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-real-"));
  try {
    const prompts: string[] = [];
    const grounded: Generator = async (prompt) => { prompts.push(prompt); return prompt.includes("D'Dioses Nuez") ? "SAME: Ice Pop, D'Dioses Nuez" : prompt.includes("Fresa") ? "DIFFERENT: Ice Pop, D'Dioses Fresa" : "DIFFERENT: Organic Moringa Powder"; };
    const ctx = makeCtx(grounded, dir, "test:fake");
    const pairs = buildPairs({ items: [nuez], negatives: [sibling] }, rows.filter((r) => r.recall_number !== "H-1167-2026"));
    const out = [];
    for (const p of pairs) out.push(await judgePair(ctx, p));
    assert.ok(prompts.length >= pairs.length);
    for (const p of prompts) { assert.ok(!/\d{11,}/.test(p.replace(/[ \-]/g, "")), "barcode leaked into the prompt"); assert.ok(!/UPC 0?827912008548/.test(p)); assert.ok(!p.includes("| UPC "), "our item carries no UPC"); }
    const pos = out.find((r) => r.kind === "positive")!;
    assert.equal(pos.first, "same"); assert.equal(pos.final, "same"); assert.equal(pos.rounds, 1);
    const m = metrics(out, "final");
    assert.equal(m.caught, 1); assert.equal(m.falseAlarms, 0);
    assert.equal(out.filter((r) => r.kind === "same-brand").length, 1);

    // A judge that says SAME with words the notice never uses: the Auditor sends it back twice, then a reviewer gets it.
    const liar: Generator = async () => "SAME: Chocolate Fudge Bar";
    const ctx2 = makeCtx(liar, dir + "-2", "test:liar");
    const r = await judgePair(ctx2, pairs.find((p) => p.kind === "positive")!);
    assert.equal(r.first, "same"); assert.equal(r.final, "unsure"); assert.equal(r.rounds, 3);
    assert.ok(r.critiques.includes("ungrounded-quote"));
    assert.equal(metrics([r], "first").caught, 1); assert.equal(metrics([r], "final").toHuman, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(dir + "-2", { recursive: true, force: true }); }
});

test("barcodePath settles a printed barcode by rule without a model call, leaves unprintable forms to text, and never matches a negative", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rw-barcode-"));
  try {
    let calls = 0;
    const ctx = makeCtx(async () => { calls++; return "UNSURE: should not be asked"; }, dir, "test:none");
    const ean = item("OFF-2", "4056489125846", ["H-1275-2026"], "Aprikosenkekse 330 g", "Lidl", "off");
    const pairs = buildPairs({ items: [nuez, noodles, ean], negatives: [sibling] }, rows.concat(row("H-1275-2026", "Lidl US TRADING", "ERIDANOUS Shortbread Cookies, EAN 4056489125846")));
    const b = await barcodePath(ctx, pairs);
    assert.equal(calls, 0, "the barcode path asks no model");
    const m = barcodeMetrics(b);
    assert.equal(m.positives, 4);
    assert.equal(m.settledByUpcRule, 2, "the first Nuez notice and the noodles print a valid UPC-A");
    assert.equal(m.settledAndAuditorDigitsAgree, 2);
    assert.equal(m.leftToText, 2, "a 13-digit print that is not a UPC-A with a leading zero, and a real EAN-13, are not barcode candidates (feeds.findUpcs)");
    assert.equal(m.negativesSettledSame, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
