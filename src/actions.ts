// Action packet: what the safety team does next, as files a person can hand on. For every case with
// recalled stock or sales it writes, under out/<run>/actions/<case>/:
//   pull-list.csv       one row per store × lot to pull, with the store's name and city
//   supplier-request.md a credit/replacement request citing the supplier's own ship notices
//   customer-notice.md  the notice text for loyalty customers who bought affected lots (count only)
//   store-status.csv   every store that holds or sold the item: PULL (affected lot on hand), NOTIFY (affected lot
//                       sold since the recall, none left), CLEAR (only lots the notice does not list, named as
//                       evidence), HOLD (stock whose lot is unknown); see storeStatus
//   fda-traceability.csv FDA recalls only: our receiving records for the affected lots in the shape of the FSMA 204
//                       receiving key data elements, sortable by lot and date (see fsmaSheet)
//   packet.json         the SQL ids behind every file, and whether the totals reconcile
// Nothing is sent. Every row comes from its own federated query, and the packet is withheld when its
// on-hand total does not equal the number the Auditor already re-derived.
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { inList, lit, say, type AgentContext } from "./agents/context.ts";
import { Trace } from "./trace.ts";
import { issueContract, verifyContract, ContractRefused } from "./contract.ts";
import type { Finding } from "./agents/investigator.ts";
import type { Case } from "./agents/scout.ts";

export interface PullRow { store_id: string; store: string; city: string; state: string; sku: string; upc: string; title: string; lot_code: string; on_hand: number; received_on?: string }
export interface ShipRow { asn_id: string; supplier_id: string; supplier: string; contact_role: string; sku: string; lot_code: string; shipped_on: string; units: number; dc_state: string }
export interface Packet {
  caseId: string; recall: string; firm: string; product: string; verdict: Finding["verdict"]; dir: string; status: "draft" | "withheld";
  stores: number; pullUnits: number; auditedUnits: number; shipNotices: number; customers: number;
  sql: { pullList: string; shipNotices: string }; reason?: string; files: string[];
  /** Stores by status (PULL, NOTIFY, CLEAR, HOLD), from store-status.csv. */
  storeStatus?: Record<string, number>;
  /** Our items in the pull list (title), for the review screen. */
  items?: string[];
}

/** Our item titles from a packet's pull-list.csv (column "item"), for packets written before `items` existed. */
export function itemsFromPullList(csvText: string): string[] {
  const rows = csvText.trim().split("\n").slice(1).map((l) => l.match(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) ?? []);
  return [...new Set(rows.map((r) => r[6]).filter(Boolean))];
}

const csv = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));

export async function actionPacket(ctx: AgentContext, k: Case, f: Finding, outDir: string): Promise<Packet | undefined> {
  const n = f.numbers;
  if (!n || !(f.verdict === "act-now" || f.verdict === "notify") || !n.affectedLots.length) return undefined;
  const skus = f.decisions.filter((d) => d.verdict === "same").map((d) => d.sku);
  const pull = await ctx.sql.run(
    `SELECT i.store_id, st.name AS store, st.city, st.state, i.sku, s.upc, s.title, i.lot_code, SUM(i.on_hand) AS on_hand, MIN(i.received_on) AS received_on
     FROM erp.inventory i JOIN erp.stores st ON st.store_id = i.store_id JOIN erp.skus s ON s.sku = i.sku
     WHERE i.sku IN (${inList(skus)}) AND i.lot_code IN (${inList(n.affectedLots)}) AND i.on_hand > 0
     GROUP BY i.store_id, st.name, st.city, st.state, i.sku, s.upc, s.title, i.lot_code ORDER BY i.store_id, i.lot_code`,
    { agent: "Orchestrator", purpose: `pull list for ${k.id}: stores × lots with stock` });
  const ship = await ctx.sql.run(
    `SELECT a.asn_id, a.supplier_id, p.name AS supplier, p.contact_role, a.sku, a.lot_code, a.shipped_on, a.units, a.dc_state
     FROM supplier_portal.ship_notices a JOIN supplier_portal.suppliers p ON p.supplier_id = a.supplier_id
     WHERE a.sku IN (${inList(skus)}) AND a.lot_code IN (${inList(n.affectedLots)}) ORDER BY a.shipped_on, a.asn_id`,
    { agent: "Orchestrator", purpose: `supplier ship notices for the affected lots of ${k.id}` });
  const rows: PullRow[] = pull.rows.map((r) => ({ store_id: String(r.store_id), store: String(r.store), city: String(r.city), state: String(r.state), sku: String(r.sku), upc: String(r.upc ?? ""), title: String(r.title), lot_code: String(r.lot_code), on_hand: Number(r.on_hand), received_on: r.received_on == null ? "" : String(r.received_on).slice(0, 10) }));
  const asns: ShipRow[] = ship.rows.map((r) => ({ asn_id: String(r.asn_id), supplier_id: String(r.supplier_id), supplier: String(r.supplier), contact_role: String(r.contact_role), sku: String(r.sku), lot_code: String(r.lot_code), shipped_on: String(r.shipped_on).slice(0, 10), units: Number(r.units), dc_state: String(r.dc_state) }));
  const pullUnits = rows.reduce((a, r) => a + r.on_hand, 0);
  const dir = `${outDir}/actions/${k.id}`;
  const packet: Packet = { caseId: k.id, recall: k.recall.id, firm: k.recall.firm, product: k.recall.title.slice(0, 140), verdict: f.verdict, dir, status: "draft", stores: new Set(rows.map((r) => r.store_id)).size, pullUnits, auditedUnits: n.onHandUnits,
    shipNotices: asns.length, customers: n.loyaltyCustomers, sql: { pullList: pull.sqlId, shipNotices: ship.sqlId }, files: [] };
  mkdirSync(dir, { recursive: true });
  // The pull list must add up to the on-hand number the Auditor re-derived with its own SQL.
  if (pullUnits !== n.onHandUnits) {
    packet.status = "withheld";
    packet.reason = `pull list sums to ${pullUnits} units (${pull.sqlId}) but the audited on-hand is ${n.onHandUnits}`;
    writeFileSync(`${dir}/packet.json`, JSON.stringify(packet, null, 2));
    ctx.trace.emit("critique", "Auditor", { caseId: k.id, code: "packet-mismatch", detail: packet.reason });
    say(ctx, "Auditor", "Orchestrator", `${k.id}: action packet withheld — ${packet.reason}`);
    return packet;
  }

  if (rows.length) {
    writeFileSync(`${dir}/pull-list.csv`, [["store_id", "store", "city", "state", "sku", "upc", "item", "lot_code", "units_to_pull"].join(","),
      ...rows.map((r) => [r.store_id, r.store, r.city, r.state, r.sku, r.upc, r.title, r.lot_code, r.on_hand].map(csv).join(","))].join("\n") + "\n");
    packet.files.push("pull-list.csv");
  }
  const items = [...new Map(rows.map((r) => [r.sku, `${r.sku} ${r.title}${r.upc ? ` (UPC ${r.upc})` : ""}`])).values()];
  packet.items = [...new Set(rows.map((r) => r.title))];
  const itemLines = items.length ? items : f.decisions.filter((d) => d.verdict === "same").map((d) => `${d.sku} ${d.title}`);
  const suppliers = [...new Map(asns.map((a) => [a.supplier_id, a])).values()];
  for (const s of suppliers.length ? suppliers : [undefined]) {
    const mine = asns.filter((a) => !s || a.supplier_id === s.supplier_id);
    const md = [
      `# DRAFT — not sent`, "",
      `**To:** ${s ? `${s.supplier} (${s.supplier_id}), ${s.contact_role}` : n.supplier ?? "the supplier"}`,
      `**Re:** ${k.recall.id} (${k.recall.firm}) — credit and replacement for recalled lots`, "",
      `The recall notice ${k.recall.id}${k.recall.date ? ` (initiated ${k.recall.date})` : ""} covers product we received from you:`, "",
      ...itemLines.map((i) => `- ${i}`), "",
      `Your ship notices for the affected lots (${ship.sqlId}):`, "",
      "| ASN | SKU | Lot | Shipped | Units | DC |", "|---|---|---|---|---|---|",
      ...mine.map((a) => `| ${a.asn_id} | ${a.sku} | ${a.lot_code} | ${a.shipped_on} | ${a.units} | ${a.dc_state} |`), "",
      `We are pulling ${pullUnits} unit(s) from ${packet.stores} store(s)${n.unitsSoldSince ? `; ${n.unitsSoldSince} unit(s) were sold since the recall began` : ""}. Please confirm credit for the shipped units and whether replacement stock is from unaffected lots.`, "",
      `_Prepared by RecallWhy run ${ctx.trace.runId}. Review before sending._`,
    ].join("\n");
    const name = `supplier-request${suppliers.length > 1 && s ? `-${s.supplier_id}` : ""}.md`;
    writeFileSync(`${dir}/${name}`, md + "\n");
    packet.files.push(name);
  }
  const st = await storeStatusQuery(ctx, k, skus, n);
  const pullFromStatus = st.rows.filter((x) => x.status === "PULL").reduce((a, x) => a + x.affectedOnHand, 0);
  if (st.rows.length && pullFromStatus !== pullUnits) {
    ctx.trace.emit("critique", "Auditor", { caseId: k.id, code: "packet-mismatch", detail: `store status PULL rows sum to ${pullFromStatus} units, the pull list to ${pullUnits}; store-status.csv withheld` });
  } else if (st.rows.length) {
    writeFileSync(`${dir}/store-status.csv`, st.csv);
    packet.files.push("store-status.csv");
    packet.storeStatus = st.counts;
  }
  if (k.recall.feed === "fda_food" && (rows.length || asns.length)) {
    writeFileSync(`${dir}/fda-traceability.csv`, fsmaSheet(k, rows, asns, { pull: pull.sqlId, ship: ship.sqlId }));
    packet.files.push("fda-traceability.csv");
  }
  if (n.loyaltyCustomers > 0) {
    const md = [
      `# DRAFT — not sent`, "",
      `**Recipients:** loyalty customers who bought affected lots since ${k.recall.date || "the recall date"} — at most ${n.loyaltyCustomers} (a count; RecallWhy holds no identities, the loyalty system resolves them)`, "",
      `**Subject:** Recall of a product you bought at Northwind`, "",
      `You bought a product that ${k.recall.firm} has recalled (${k.recall.id}).`, "",
      ...itemLines.map((i) => `- ${i.replace(/^NW-\d+ /, "")}`),
      `- Lot code${n.affectedLots.length > 1 ? "s" : ""}: ${n.affectedLots.join(", ")}`, "",
      `Reason given in the recall notice: "${k.recall.reason.trim().slice(0, 400)}"`, "",
      // A consumer product's remedy (refund, repair, replacement) is set by the firm in the CPSC notice; a food is returned or thrown away.
      k.recall.feed === "cpsc"
        ? `Please stop using it. The remedy the firm offers is in the recall notice${k.recall.url ? ` (${k.recall.url})` : ""}; you can also bring it to any Northwind store and we will help. Your receipt is not needed.`
        : `Please do not use it. Return it to any Northwind store for a full refund, or dispose of it. Your receipt is not needed.`, "",
      `_Prepared by RecallWhy run ${ctx.trace.runId}. Review before sending._`,
    ].join("\n");
    writeFileSync(`${dir}/customer-notice.md`, md + "\n");
    packet.files.push("customer-notice.md");
  }
  writeFileSync(`${dir}/packet.json`, JSON.stringify(packet, null, 2));
  ctx.trace.emit("packet", "Orchestrator", { caseId: k.id, status: packet.status, stores: packet.stores, pullUnits, shipNotices: asns.length, customers: n.loyaltyCustomers, files: packet.files, sql: packet.sql });
  say(ctx, "Orchestrator", "Human", `${k.id}: action packet drafted — pull ${pullUnits} unit(s) in ${packet.stores} store(s), ${asns.length} ship notice(s) cited for the supplier${n.loyaltyCustomers ? `, notice for at most ${n.loyaltyCustomers} customer(s)` : ""} (not sent)`);
  return packet;
}

/** A person approves a drafted packet: the approval is recorded next to it, with who and when. Nothing is sent. */
export type StoreStatus = "PULL" | "NOTIFY" | "CLEAR" | "HOLD";
export interface StoreLot { store_id: string; store: string; city: string; state: string; lot_code: string; on_hand: number; sold: number }
export const STORE_COLUMNS = ["store_id", "store", "city", "state", "status", "affected_units_on_hand", "other_units_on_hand", "lots_on_hand", "affected_units_sold_since_recall", "evidence"];

/**
 * One status per store that holds the matched item or sold an affected lot since the recall. CLEAR needs positive
 * evidence: the notice lists its lots (lotRule "listed-lots") and every lot the store holds is outside that list,
 * named in the row. A lot code we cannot read (empty) is never cleared: HOLD. Pure, so it is tested without SQL.
 */
export function storeStatus(rows: StoreLot[], affectedLots: string[], lotRule: string): { store: StoreLot; status: StoreStatus; affectedOnHand: number; otherOnHand: number; lots: string[]; sold: number; evidence: string }[] {
  const aff = new Set(affectedLots.map((l) => l.toUpperCase()));
  const by = new Map<string, StoreLot[]>();
  for (const r of rows) (by.get(r.store_id) ?? by.set(r.store_id, []).get(r.store_id)!).push(r);
  return [...by.values()].map((lots) => {
    const isAff = (l: StoreLot) => aff.has(l.lot_code.toUpperCase());
    const affectedOnHand = lots.filter(isAff).reduce((a, l) => a + l.on_hand, 0);
    const unknown = lots.filter((l) => !l.lot_code.trim() && l.on_hand > 0).reduce((a, l) => a + l.on_hand, 0);
    const otherOnHand = lots.filter((l) => !isAff(l)).reduce((a, l) => a + l.on_hand, 0);
    const sold = lots.filter(isAff).reduce((a, l) => a + l.sold, 0);
    const held = [...new Set(lots.filter((l) => l.on_hand > 0).map((l) => l.lot_code || "(no lot code)"))].sort();
    let status: StoreStatus, evidence: string;
    if (affectedOnHand > 0) { status = "PULL"; evidence = `holds recalled lot(s) ${[...new Set(lots.filter((l) => isAff(l) && l.on_hand > 0).map((l) => l.lot_code))].join(", ")}`; }
    else if (unknown > 0) { status = "HOLD"; evidence = `${unknown} unit(s) with no readable lot code: cannot be cleared`; }
    else if (sold > 0) { status = "NOTIFY"; evidence = `sold ${sold} unit(s) of recalled lots since the recall, none left on hand`; }
    else if (otherOnHand > 0 && lotRule === "listed-lots") { status = "CLEAR"; evidence = `holds only lot(s) ${held.join(", ")}, none of which the notice lists (${affectedLots.join(", ")})`; }
    else { status = "HOLD"; evidence = lotRule === "listed-lots" ? "no stock and no sale of recalled lots" : "the notice lists no lots we can match: every lot counts as recalled"; }
    return { store: lots[0], status, affectedOnHand, otherOnHand, lots: held, sold, evidence };
  }).sort((a, b) => ["PULL", "NOTIFY", "HOLD", "CLEAR"].indexOf(a.status) - ["PULL", "NOTIFY", "HOLD", "CLEAR"].indexOf(b.status) || b.affectedOnHand - a.affectedOnHand || a.store.store_id.localeCompare(b.store.store_id));
}

async function storeStatusQuery(ctx: AgentContext, k: Case, skus: string[], n: NonNullable<Finding["numbers"]>) {
  const inv = await ctx.sql.run(
    `SELECT i.store_id, st.name AS store, st.city, st.state, i.lot_code, SUM(i.on_hand) AS on_hand
     FROM erp.inventory i JOIN erp.stores st ON st.store_id = i.store_id
     WHERE i.sku IN (${inList(skus)}) GROUP BY i.store_id, st.name, st.city, st.state, i.lot_code`,
    { agent: "Orchestrator", purpose: `store status for ${k.id}: every lot of the item on hand, by store` });
  const sold = n.affectedLots.length ? await ctx.sql.run(
    `SELECT s.store_id, st.name AS store, st.city, st.state, s.lot_code, SUM(s.units) AS units
     FROM erp.sales s JOIN erp.stores st ON st.store_id = s.store_id
     WHERE s.sku IN (${inList(skus)}) AND s.lot_code IN (${inList(n.affectedLots)}) AND s.sold_on >= CAST(${lit(k.recall.date || "2026-01-01")} AS DATE)
     GROUP BY s.store_id, st.name, st.city, st.state, s.lot_code`,
    { agent: "Orchestrator", purpose: `store status for ${k.id}: recalled lots sold since the recall, by store` }) : undefined;
  const key = (r: Record<string, unknown>) => `${r.store_id}|${r.lot_code ?? ""}`;
  const lots = new Map<string, StoreLot>();
  for (const r of inv.rows) lots.set(key(r), { store_id: String(r.store_id), store: String(r.store), city: String(r.city), state: String(r.state), lot_code: String(r.lot_code ?? ""), on_hand: Number(r.on_hand), sold: 0 });
  for (const r of sold?.rows ?? []) { const l = lots.get(key(r)) ?? { store_id: String(r.store_id), store: String(r.store), city: String(r.city), state: String(r.state), lot_code: String(r.lot_code ?? ""), on_hand: 0, sold: 0 }; l.sold += Number(r.units); lots.set(key(r), l); }
  const res = storeStatus([...lots.values()].filter((l) => l.on_hand > 0 || l.sold > 0), n.affectedLots, n.lotRule);
  const sqlIds = [inv.sqlId, sold?.sqlId].filter(Boolean).join(" ");
  const csvText = [STORE_COLUMNS.join(","), ...res.map((x) => [x.store.store_id, x.store.store, x.store.city, x.store.state, x.status, x.affectedOnHand, x.otherOnHand, x.lots.join(" "), x.sold, `${x.evidence} (${sqlIds})`].map((v) => csv(v)).join(","))].join("\n") + "\n";
  const counts = Object.fromEntries((["PULL", "NOTIFY", "HOLD", "CLEAR"] as const).map((s) => [s, res.filter((x) => x.status === s).length]));
  return { rows: res, csv: csvText, counts };
}

export const FSMA_COLUMNS = ["traceability_lot_code", "product_description", "upc", "quantity", "unit_of_measure", "quantity_note", "event", "receiving_location", "immediate_previous_source", "traceability_lot_code_source", "date", "date_note", "reference_document", "recall", "sql_id"];

/**
 * Our receiving records for the affected lots, one row per record, in the shape of the FSMA 204 receiving key data
 * elements (21 CFR 1.1345) and sortable by lot and date, the form the FDA asks for within 24 hours (1.1455(c)(3)).
 * The rule covers foods on the Food Traceability List; this sheet is drafted for every FDA recall and a person
 * decides whether it applies. Two kinds of rows, both receipts by us: at a distribution center, from the supplier's
 * ship notice (we hold its ship date, not the date the DC received it), and at a store that still has stock, from
 * the ERP (first received date; the ERP keeps the quantity on hand, not the quantity received, so a store that
 * received a lot and sold it all has no row). The supplier stands in as the lot code source: the notices do not
 * say who assigned the code. Every row names the query that produced it; addresses are not in our data.
 */
export function fsmaSheet(k: Pick<Case, "recall">, rows: PullRow[], asns: ShipRow[], sql: { pull: string; ship: string }): string {
  const titles = new Map(rows.map((r) => [r.sku, { title: r.title, upc: r.upc }]));
  const source = new Map(asns.map((a) => [`${a.sku}|${a.lot_code}`, `${a.supplier} (${a.supplier_id})`]));
  const recs = [
    ...asns.map((a) => [a.lot_code, titles.get(a.sku)?.title ?? a.sku, titles.get(a.sku)?.upc ?? "", a.units, "each", "units shipped to us", "receiving (our distribution center)", `Northwind DC, ${a.dc_state}`, `${a.supplier} (${a.supplier_id})`, `${a.supplier} (${a.supplier_id})`, a.shipped_on, "ship date on the supplier's notice", `ship notice ${a.asn_id}`, k.recall.id, sql.ship]),
    ...rows.map((r) => [r.lot_code, r.title, r.upc, r.on_hand, "each", "on hand now (received quantity not in the ERP)", "receiving (store)", `${r.store} (${r.store_id}), ${r.city}, ${r.state}`, "Northwind distribution center", source.get(`${r.sku}|${r.lot_code}`) ?? "not in our ship notices", r.received_on ?? "", "first received at the store (ERP)", "ERP inventory", k.recall.id, sql.pull]),
  ].sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[10]).localeCompare(String(b[10])));
  return [FSMA_COLUMNS.join(","), ...recs.map((r) => r.map((v) => csv(v as string | number)).join(","))].join("\n") + "\n";
}

export function approvePacket(runId: string, caseId: string, by: string, note = ""): { ok: boolean; reason?: string; file?: string } {
  if (!/^[\w-]+$/.test(runId) || !/^[\w.:-]+$/.test(caseId) || caseId.includes("..")) return { ok: false, reason: "bad run or case id" };
  const dir = `out/${runId}/actions/${caseId}`;
  if (!existsSync(`${dir}/packet.json`)) return { ok: false, reason: "no packet for this run and case" };
  const p = JSON.parse(readFileSync(`${dir}/packet.json`, "utf8")) as Packet;
  if (p.status !== "draft") return { ok: false, reason: `packet is ${p.status}` };
  // Scout Intent: a high-risk contract that carries the person's approval, verified before it is recorded.
  const who = by.trim().slice(0, 80);
  const at = new Date().toISOString();
  const trace = new Trace({ dir: "logs/approvals", quiet: true, runId: `approve-${runId}-${caseId}`.slice(0, 120) });
  const capability = `packet.approve:${runId}/${caseId}`;
  const contract = issueContract(trace, { intent: "packet.approve", parameters: { runId, caseId, files: p.files, pullUnits: p.pullUnits, stores: p.stores }, capabilities: [capability], risk: "high", surface: "review",
    approvals: who ? [{ kind: "operator-review", by: who, at, decision: "approve" }] : [] });
  try { verifyContract(trace, contract, capability, "Human"); }
  catch (e) { return { ok: false, reason: e instanceof ContractRefused && e.reason === "approval-missing" ? "an approval needs the approver's name" : (e as Error).message }; }
  const file = `${dir}/approval.json`;
  writeFileSync(file, JSON.stringify({ runId, caseId, by: who, note: note.slice(0, 500), at, files: p.files, sent: false, contract }, null, 2));
  return { ok: true, file };
}

/** Packets of the most recent run that drafted any, with their approval if one is recorded. */
export function listPackets(): { runId: string; packets: (Packet & { approval?: { by: string; at: string; note: string } })[] } {
  const runs = existsSync("out") ? readdirSync("out").filter((r) => existsSync(`out/${r}/actions`)).sort((a, b) => statSync(`out/${b}`).mtimeMs - statSync(`out/${a}`).mtimeMs) : [];
  const runId = runs[0];
  if (!runId) return { runId: "", packets: [] };
  const packets = readdirSync(`out/${runId}/actions`).flatMap((c) => {
    const f = `out/${runId}/actions/${c}/packet.json`;
    if (!existsSync(f)) return [];
    const p = JSON.parse(readFileSync(f, "utf8")) as Packet;
    const pl = `out/${runId}/actions/${c}/pull-list.csv`;
    if (!p.items && existsSync(pl)) p.items = itemsFromPullList(readFileSync(pl, "utf8"));
    const a = `out/${runId}/actions/${c}/approval.json`;
    return [{ ...p, ...(existsSync(a) ? { approval: JSON.parse(readFileSync(a, "utf8")) } : {}) }];
  });
  return { runId, packets };
}
