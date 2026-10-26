import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFolder, parseCsv } from "../src/data-contract.ts";

test("the committed synthetic data meets the data contract", () => {
  const r = checkFolder("data/synthetic");
  assert.deepEqual(r.violations, []);
  assert.equal(r.rows["ship_notices.csv"], 14705);
});

test("a folder that breaks the contract is reported rule by rule", () => {
  const d = mkdtempSync(join(tmpdir(), "rw-contract-"));
  try {
    cpSync("data/synthetic", d, { recursive: true });
    rmSync(join(d, "suppliers.csv"));
    const inv = readFileSync(join(d, "inventory.csv"), "utf8").split("\n");
    const cols = inv[1].split(",");
    inv.push(inv[1]); // duplicate key
    inv.push([cols[0], cols[1], "LOTX", "-3", "2026-01-01"].join(",")); // negative stock
    inv.push(["S999", cols[1], "LOTY", "two", "yesterday"].join(",")); // unknown store, bad int and date
    writeFileSync(join(d, "inventory.csv"), inv.filter(Boolean).join("\n") + "\n");
    const rules = checkFolder(d).violations.map((v) => `${v.file}: ${v.rule}`);
    for (const want of ["suppliers.csv: file is missing", "inventory.csv: key (store_id, sku, lot_code) is unique", "inventory.csv: on_hand_not_negative",
      "inventory.csv: on_hand is a whole number", "inventory.csv: received_on is a date (yyyy-mm-dd)", "inventory.csv: store_id must exist in stores.csv"])
      assert.ok(rules.includes(want), `${want} in ${rules.join(" | ")}`);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("parseCsv keeps quoted commas and doubled quotes", () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n'), { headers: ["a", "b"], rows: [["x, y", 'say "hi"']] });
});
