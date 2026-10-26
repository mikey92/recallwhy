import { test } from "node:test";
import assert from "node:assert/strict";
import { prompt, parse } from "../eval/one-prompt.ts";

test("one-prompt baseline: every candidate is in the prompt, and an unparsed verdict counts as unsure", () => {
  const k = { id: "c", recallEntity: "", recall: { id: "fda:H-1", firm: "F", text: "Salsa Verde", reason: "Salmonella", codeInfo: "LOT1", upcs: ["030223075639"] },
    candidates: [{ sku: { sku: "NW-1", upc: "030223075639", brand: "B", title: "Salsa Verde" } }, { sku: { sku: "NW-2", upc: "", brand: "B", title: "Salsa Roja" } }] } as never;
  const p = prompt(k);
  assert.match(p, /NW-1 \| UPC 030223075639/); assert.match(p, /NW-2 \| UPC \(none\)/); assert.match(p, /030223075639/);
  const v = parse("NW-1 SAME\nNW-2: maybe", ["NW-1", "NW-2", "NW-3"]);
  assert.deepEqual([...v.values()], ["same", "unsure", "unsure"]);
  assert.equal(parse("nw-2 - not", ["NW-2"]).get("NW-2"), "not-this");
});
