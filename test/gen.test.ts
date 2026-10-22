import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  brandFromCpscName,
  brandFromFdaFirm,
  cpscRetailerTitle,
  fdaRetailerTitle,
} from "../scripts/gen-synthetic.ts";

describe("brandFromFdaFirm", () => {
  it("strips LLC and title-cases Everything Sprouts, LLC", () => {
    assert.equal(brandFromFdaFirm("Everything Sprouts, LLC"), "Everything Sprouts");
  });

  it("strips Inc., Corp, Company and similar legal suffixes", () => {
    assert.equal(brandFromFdaFirm("Acme Foods, Inc."), "Acme Foods");
    assert.equal(brandFromFdaFirm("Northwind Mercantile Corporation"), "Northwind Mercantile");
    assert.equal(brandFromFdaFirm("Riverdale Co."), "Riverdale");
    assert.equal(brandFromFdaFirm("Oak Farms L.L.C."), "Oak Farms");
  });
});

describe("fdaRetailerTitle", () => {
  it("builds CRUNCHY PROTEIN SPROUT MIX 5OZ from the Everything Sprouts description", () => {
    const brand = "Everything Sprouts";
    const desc =
      "Everything Sprouts Crunchy Protein Sprout Mix, containing Alfalfa Fenugreek, Cabbage, Mung, Adzuki, Lentils, Green Pea, Net Wt. 5.0 oz (142 g) UPC 0 87906-01018 7.  everythingsprouts.com";
    const title = fdaRetailerTitle(desc, brand);
    assert.equal(title, "CRUNCHY PROTEIN SPROUT MIX 5OZ");
    assert.ok(!title.includes("..."));
    assert.ok(title.length <= 48);
  });

  it("never includes ellipsis and stays within 48 chars", () => {
    const brand = "Long Brand Name Foods";
    const desc =
      "Long Brand Name Foods Extra Special Premium Artisan Sourdough Multigrain Loaf packed in plastic bag Net Wt. 16 oz";
    const title = fdaRetailerTitle(desc, brand);
    assert.ok(!title.includes("..."));
    assert.ok(title.length <= 48);
  });
});

describe("brandFromCpscName", () => {
  it("prefers manufacturer then importer then distributor, stripping suffixes", () => {
    assert.equal(
      brandFromCpscName({
        Title: "Widget Co Recalls Widgets",
        Manufacturers: [{ Name: "Acme Toys, Inc." }],
        Importers: [{ Name: "Other Import LLC" }],
      }),
      "Acme Toys",
    );
    assert.equal(
      brandFromCpscName({
        Title: "Widget Co Recalls Widgets",
        Manufacturers: [],
        Importers: [{ Name: "3M Company, of St. Paul, Minnesota" }],
      }),
      "3M",
    );
    assert.equal(
      brandFromCpscName({
        Title: "Brightlite Recalls Night Lights Due to Fire Hazard",
        Manufacturers: [],
        Importers: [],
        Distributors: [{ Name: "Brightlite Corp" }],
      }),
      "Brightlite",
    );
  });

  it("falls back to the first word of Title when no company names exist", () => {
    assert.equal(
      brandFromCpscName({
        Title: "Brightlite Recalls Night Lights Due to Fire Hazard",
        Manufacturers: [],
        Importers: [],
        Distributors: [],
      }),
      "Brightlite",
    );
  });
});

describe("cpscRetailerTitle", () => {
  it("uppercases product name without brand words and appends a short model", () => {
    const title = cpscRetailerTitle(
      {
        Title: "Acme Toys Recalls Wooden Blocks",
        Products: [{ Name: "Acme Wooden Building Blocks Set", Model: "WB-100" }],
      },
      "Acme Toys",
      true,
    );
    assert.equal(title, "WOODEN BUILDING BLOCKS SET WB-100");
    assert.ok(!title.includes("..."));
    assert.ok(title.length <= 48);
  });

  it("omits model when includeModel is false or model is N/A", () => {
    assert.equal(
      cpscRetailerTitle(
        {
          Title: "Acme Toys Recalls Wooden Blocks",
          Products: [{ Name: "Acme Wooden Building Blocks Set", Model: "WB-100" }],
        },
        "Acme Toys",
        false,
      ),
      "WOODEN BUILDING BLOCKS SET",
    );
    assert.equal(
      cpscRetailerTitle(
        {
          Title: "Acme Toys Recalls Wooden Blocks",
          Products: [{ Name: "Acme Wooden Building Blocks Set", Model: "N/A" }],
        },
        "Acme Toys",
        true,
      ),
      "WOODEN BUILDING BLOCKS SET",
    );
  });
});
