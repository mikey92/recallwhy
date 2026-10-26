-- The governed model of the retailer's recall exposure, as a Zetaris Unified Semantic Layer:
-- seven tables with primary and foreign keys and descriptions, activated from the JDBC sources,
-- the live feed views and the views the agents write back (reconciled.*). The keys are the joins the
-- agents rely on; Zetaris's data-quality engine checks them (RUN DQ, SHOW DQ INVALID RECORD).
--
--   ship_notice.matched_sku -> item.sku   the barcode join as the agents have proven it so far
--                                         (reconciled.ship_notice_item_keys). A ship notice no proven
--                                         rule reaches carries matched_sku = 'unreached', so Zetaris
--                                         names those rows as orphans of this key, supplier by supplier.
--   decision.recall_id -> recall_notice   every verdict the agents or a reviewer recorded points at a
--   decision.sku -> item                  notice in the live feeds and an item we carry
--
-- Created once by `npm run setup:zetaris`; the Cartographer re-activates ship_notice after each map
-- correction and the Orchestrator re-activates decision after each run (src/zetaris-usl.ts).
-- Rules learned on Zetaris 2.4.3.1: the COMPILE USL statement is ONE statement with all its CREATE TABLE
-- parts (src/sql/split.ts joins them); descriptions are unquoted, without semicolons, apostrophes or
-- parentheses; key rules are named after their columns; REGISTER DQ fails if the rule exists.
CREATE NAMESPACE IF NOT EXISTS lightning.metastore;
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.recallwhy;
COMPILE USL IF NOT EXISTS recall_exposure DEPLOY NAMESPACE lightning.metastore.recallwhy DDL
CREATE TABLE supplier (
  supplier_id varchar(10) NOT NULL PRIMARY KEY,
  name varchar(80),
  contact_role varchar(60)
);
CREATE TABLE item (
  sku varchar(20) NOT NULL PRIMARY KEY,
  upc varchar(14),
  title varchar(200),
  brand varchar(120),
  department varchar(40),
  supplier_id varchar(10) FOREIGN KEY REFERENCES supplier(supplier_id)
);
CREATE TABLE store (
  store_id varchar(8) NOT NULL PRIMARY KEY,
  name varchar(80),
  city varchar(60),
  state varchar(2)
);
CREATE TABLE inventory_lot (
  store_id varchar(8) NOT NULL FOREIGN KEY REFERENCES store(store_id),
  sku varchar(20) NOT NULL FOREIGN KEY REFERENCES item(sku),
  lot_code varchar(40) NOT NULL,
  on_hand int,
  PRIMARY KEY (store_id, sku, lot_code)
);
CREATE TABLE ship_notice (
  asn_id varchar(20) NOT NULL PRIMARY KEY,
  supplier_id varchar(10) FOREIGN KEY REFERENCES supplier(supplier_id),
  notice_sku varchar(20) FOREIGN KEY REFERENCES item(sku),
  matched_sku varchar(20) FOREIGN KEY REFERENCES item(sku),
  notice_upc varchar(20),
  lot_code varchar(40),
  units int
);
CREATE TABLE recall_notice (
  recall_id varchar(40) NOT NULL PRIMARY KEY,
  feed varchar(4),
  firm varchar(300),
  reported varchar(10),
  product varchar(400)
);
CREATE TABLE decision (
  run_id varchar(40) NOT NULL,
  recall_id varchar(40) NOT NULL FOREIGN KEY REFERENCES recall_notice(recall_id),
  sku varchar(20) NOT NULL FOREIGN KEY REFERENCES item(sku),
  verdict varchar(10),
  basis varchar(20),
  decided_by varchar(20),
  PRIMARY KEY (run_id, recall_id, sku)
);
UPDATE USL lightning.metastore.recallwhy.recall_exposure SET DESCRIPTION RecallWhy recall exposure - the retailer item master, stores, stock by lot, supplier ship notices joined to items by the barcode rules the agents proved, the live CPSC and FDA recall notices, and every verdict the agents or a reviewer recorded. Stores stand at real SNAP supermarket locations and food items are real products - stock and ship notices are synthetic.;
UPDATE USL lightning.metastore.recallwhy.recall_exposure.supplier SET TABLE DESCRIPTION Suppliers from the supplier portal - each sends its own barcode format.;
UPDATE USL lightning.metastore.recallwhy.recall_exposure.item SET TABLE DESCRIPTION The ERP item master - food lines are real products from USDA FoodData Central and Open Food Facts with their real UPC or EAN-13.;
UPDATE USL lightning.metastore.recallwhy.recall_exposure.store SET TABLE DESCRIPTION The retailer stores - city and state of real SNAP-authorized supermarkets from USDA FNS.;
UPDATE USL lightning.metastore.recallwhy.recall_exposure.inventory_lot SET TABLE DESCRIPTION Units on hand per store, item and lot code - what a pull list pulls.;
UPDATE USL lightning.metastore.recallwhy.recall_exposure.ship_notice SET TABLE DESCRIPTION Barcoded supplier ship notices. matched_sku is the item the notice barcode reaches under the barcode rules the Cartographer proved and wrote back as reconciled.ship_notice_item_keys - unreached when no proven rule reaches it yet.;
UPDATE USL lightning.metastore.recallwhy.recall_exposure.recall_notice SET TABLE DESCRIPTION Recall notices read live from the CPSC Recall API and openFDA food enforcement through Lightning REST tables. recall_id is the feed and the recall number.;
UPDATE USL lightning.metastore.recallwhy.recall_exposure.decision SET TABLE DESCRIPTION Verdicts of the latest run for each recall and item - same, not-this or unsure - with how they were reached and whether an agent or a person decided. Written back by the Orchestrator as reconciled.case_verdicts.;
ACTIVATE USL TABLE lightning.metastore.recallwhy.recall_exposure.supplier AS
SELECT supplier_id, name, contact_role FROM supplier_portal.suppliers;
ACTIVATE USL TABLE lightning.metastore.recallwhy.recall_exposure.item AS
SELECT sku, upc, title, brand, department, supplier_id FROM erp.skus;
ACTIVATE USL TABLE lightning.metastore.recallwhy.recall_exposure.store AS
SELECT store_id, name, city, state FROM erp.stores;
ACTIVATE USL TABLE lightning.metastore.recallwhy.recall_exposure.inventory_lot AS
SELECT store_id, sku, lot_code, CAST(on_hand AS INT) AS on_hand FROM erp.inventory;
ACTIVATE USL TABLE lightning.metastore.recallwhy.recall_exposure.ship_notice AS
SELECT a.asn_id, a.supplier_id, a.sku AS notice_sku, COALESCE(r.item_sku, 'unreached') AS matched_sku, a.upc AS notice_upc, a.lot_code, CAST(a.units AS INT) AS units
FROM supplier_portal.ship_notices a LEFT JOIN reconciled.ship_notice_item_keys r ON r.asn_id = a.asn_id WHERE a.upc <> '';
ACTIVATE USL TABLE lightning.metastore.recallwhy.recall_exposure.recall_notice AS
SELECT COALESCE(concat('fda:', recall_number), '') AS recall_id, 'fda' AS feed, recalling_firm AS firm, report_date AS reported, substr(product_description, 1, 400) AS product FROM recallfeeds.fda_food
UNION ALL SELECT COALESCE(concat('cpsc:', recall_number), '') AS recall_id, 'cpsc' AS feed, substr(firms, 1, 300) AS firm, recall_date AS reported, substr(title, 1, 400) AS product FROM recallfeeds.cpsc_recalls;
DROP VIEW IF EXISTS reconciled.case_verdicts;
CREATE SCHEMASTORE VIEW case_verdicts WITH CONTAINER reconciled AS
SELECT * FROM VALUES ('none', 'none', 'none', 'unsure', 'none', 'none') AS t(run_id, recall_id, sku, verdict, basis, decided_by) WHERE run_id <> 'none';
ACTIVATE USL TABLE lightning.metastore.recallwhy.recall_exposure.decision AS
SELECT run_id, recall_id, sku, verdict, basis, decided_by FROM reconciled.case_verdicts;
-- The supplier barcode rules the Cartographer proves are kept here between runs (src/agents/cartographer.ts,
-- remember()); setup starts it empty, so a first run reads no rules instead of failing on a missing view.
DROP VIEW IF EXISTS reconciled.supplier_rules;
CREATE SCHEMASTORE VIEW supplier_rules WITH CONTAINER reconciled AS
SELECT * FROM VALUES ('none', 'none', 'null', '0', 'none', 'none', '') AS t(supplier_id, transform, ops, proven_rows, learned_from, run_id, proposed_by) WHERE supplier_id <> 'none';
REGISTER DQ on_hand_not_negative TABLE lightning.metastore.recallwhy.recall_exposure.inventory_lot AS on_hand >= 0;
REGISTER DQ ships_units TABLE lightning.metastore.recallwhy.recall_exposure.ship_notice AS units > 0;
REGISTER DQ known_verdict TABLE lightning.metastore.recallwhy.recall_exposure.decision AS verdict IN ('same', 'not-this', 'unsure');
