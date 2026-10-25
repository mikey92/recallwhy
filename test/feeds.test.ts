import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStates, findUpcs, lotsFromCodeInfo, lotAppears } from "../src/feeds.ts";

test("parseStates reads codes, names and nationwide", () => {
  assert.deepEqual(parseStates("Domestic: AZ, CA, CO"), ["AZ", "CA", "CO"]);
  assert.equal(parseStates("Nationwide"), "nationwide");
  assert.deepEqual(parseStates("Alabama, West Virginia and Texas"), ["AL", "TX", "WV"]);
  assert.equal(parseStates(""), "unknown");
});

test("findUpcs normalises spaced UPCs and rejects bad check digits", () => {
  assert.deepEqual(findUpcs("Net Wt. 5.0 oz (142 g) UPC 0 87906-01018 0."), ["087906010180"]);
  // As printed in FDA H-1339-2026: the check digit is wrong, so the parser refuses it
  // (the Scout's digit sweep in Zetaris still matches it against our UPCs).
  assert.deepEqual(findUpcs("UPC 0 87906-01018 7."), []);
  assert.deepEqual(findUpcs("UPC 03600029145"), ["036000291452"]);
  assert.deepEqual(findUpcs("code 123456789013"), []);
});

test("findUpcs reads EAN-13, two-zero GTIN-14 and an 11-digit UPC missing its leading zero", () => {
  // As printed in FDA H-1275-2026 (Lidl) and H-1260-2026 (an import): EAN-13 that is not a UPC.
  assert.deepEqual(findUpcs("330 g (weight), UPC: 4056489125846."), ["4056489125846"]);
  assert.deepEqual(findUpcs("UPC: 4056489125847"), []); // bad check digit
  assert.deepEqual(findUpcs("GTIN 00087906010180"), ["087906010180"]);
  // As printed in FDA H-1114-2026: "83791520148" is UPC 083791520148 without its leading zero,
  // and also reads as an 11-digit UPC without its check digit; both forms are kept.
  assert.deepEqual(findUpcs("|| 83791520148, 26030070101").slice(0, 2), ["837915201488", "083791520148"]);
});

test("printedForms covers the ways a notice prints a UPC", async () => {
  const { printedForms } = await import("../scripts/upc.ts");
  assert.deepEqual(printedForms("073171003200"), ["073171003200", "07317100320", "73171003200"]);
  assert.deepEqual(printedForms("4056489125846"), ["4056489125846"]);
});

test("lotsFromCodeInfo keeps lot codes and drops dates and UPCs", () => {
  const a = lotsFromCodeInfo("Lot# 222, 223, 226, 230");
  assert.ok(a.includes("222") && a.includes("230"));
  const b = lotsFromCodeInfo("Best By 12/14/2026 (Lot 1) and Best By 12/12/2027 (Lot 2) Lots: NG2024121501, NG2025121301");
  assert.ok(b.includes("NG2024121501") && b.includes("NG2025121301"));
  assert.ok(!b.some((x) => x.includes("/")));
  assert.deepEqual(lotsFromCodeInfo("No lot codes."), []);
  assert.deepEqual(lotsFromCodeInfo("UPC: 850073852125 all best by dates on or before July 10, 2027."), []);
});

test("lotAppears needs the whole token", () => {
  assert.equal(lotAppears("TFMX181A04", "SYSCO LETTUCE TFMX181A04 7/19/2026"), true);
  assert.equal(lotAppears("181A0", "SYSCO LETTUCE TFMX181A04 7/19/2026"), false);
});
