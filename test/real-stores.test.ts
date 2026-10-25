import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { csvLine, pickStores, STORE_STATES } from "../scripts/build-real-stores.ts";

const row = (id: string, state: string, city: string, extra: Record<string, string> = {}) => ({
  "Record ID": id, "Store Name": `Shop ${id}`, "Store Type": "Supermarket", "Street Number": "1", "Street Name": "MAIN ST",
  City: city, State: state, "Zip Code": "8611", County: "SOME", Latitude: "40.1", Longitude: "-74.1", "Authorization Date": "1/1/2020", "End Date": "", ...extra,
});

test("csvLine keeps quoted commas", () => {
  assert.deepEqual(csvLine('1,"T&R Wilburn, Llc",Supermarket'), ["1", "T&R Wilburn, Llc", "Supermarket"]);
});

test("pickStores takes two active supermarkets per state in different cities, padded ZIPs", () => {
  const rows = STORE_STATES.flatMap((s) => [row(`${s}1`, s, "ALPHA"), row(`${s}2`, s, "ALPHA"), row(`${s}3`, s, "BETA TOWN"), row(`${s}4`, s, "GAMMA", { "End Date": "1/1/2021" })]);
  const out = pickStores(rows, 7);
  assert.equal(out.length, 24);
  for (const s of STORE_STATES) {
    const mine = out.filter((x) => x.state === s);
    assert.deepEqual(mine.map((x) => x.city).sort(), ["Alpha", "Beta Town"]);
    assert.ok(mine.every((x) => x.snapRecordId !== `${s}4`), "closed stores are skipped");
  }
  assert.equal(out[0].zip, "08611");
  assert.deepEqual(pickStores(rows, 7), out, "the pick is reproducible");
});

test("the committed stores are the generator's stores, with no business name in the ERP", () => {
  const real = JSON.parse(readFileSync("data/real/stores.json", "utf8")).stores as { store_id: string; city: string; state: string; snapStoreName: string }[];
  const csv = readFileSync("data/synthetic/stores.csv", "utf8").trim().split("\n").slice(1).map(csvLine);
  assert.equal(real.length, 24);
  assert.deepEqual(csv.map((r) => [r[0], r[2], r[3]]), real.map((s) => [s.store_id, s.city, s.state]));
  const erp = readFileSync("data/synthetic/stores.csv", "utf8").toLowerCase();
  for (const s of real) assert.ok(!erp.includes(s.snapStoreName.toLowerCase().replace(/\s+\d+$/, "").slice(0, 12)) || /northwind/.test(s.snapStoreName.toLowerCase()), `ERP names ${s.snapStoreName}`);
});
