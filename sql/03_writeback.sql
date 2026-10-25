-- Where the Cartographer writes the corrected barcode map back (src/agents/cartographer.ts publish()):
-- a USL table refreshed from reconciled.ship_notice_item_keys, with a data-quality rule Zetaris runs:
-- every ship notice matched by barcode must name the notice's own SKU.
CREATE NAMESPACE IF NOT EXISTS lightning.metastore;
CREATE NAMESPACE IF NOT EXISTS lightning.metastore.recallwhy;
COMPILE USL IF NOT EXISTS recall_keys DEPLOY NAMESPACE lightning.metastore.recallwhy DDL
CREATE TABLE notice_item (
  asn_id varchar(20) NOT NULL,
  supplier_id varchar(10) NOT NULL,
  notice_sku varchar(20) NOT NULL,
  item_sku varchar(20) NOT NULL,
  lot_code varchar(40),
  PRIMARY KEY (asn_id, item_sku)
);
REGISTER DQ barcode_names_the_notice_sku TABLE lightning.metastore.recallwhy.recall_keys.notice_item AS item_sku = notice_sku;
