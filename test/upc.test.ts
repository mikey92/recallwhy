import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gtin12CheckDigit, isValidUpc } from "../scripts/upc.ts";

describe("gtin12CheckDigit", () => {
  it("computes the classic UPC example 03600029145 → 2", () => {
    assert.equal(gtin12CheckDigit("03600029145"), "2");
  });

  it("rejects non-11-digit input", () => {
    assert.throws(() => gtin12CheckDigit("123"), /11 digits/);
  });
});

describe("isValidUpc", () => {
  it("accepts a valid 12-digit UPC", () => {
    assert.equal(isValidUpc("036000291452"), true);
  });

  it("rejects wrong check digit", () => {
    assert.equal(isValidUpc("036000291451"), false);
  });

  it("rejects non-12-digit strings", () => {
    assert.equal(isValidUpc("03600029145"), false);
    assert.equal(isValidUpc("abc"), false);
    assert.equal(isValidUpc(""), false);
  });
});
