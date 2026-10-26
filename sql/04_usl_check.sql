-- Checks of the recall_exposure USL (after sql/04_usl.sql): the model, row counts, a join along its
-- keys, and Zetaris's data-quality engine on every key rule. Expected values: docs/ZETARIS.md.
--   npx tsx scripts/zetaris-sql.ts sql/04_usl_check.sql
SHOW NAMESPACES OR TABLES IN lightning.metastore.recallwhy;
LIST DQ USL lightning.metastore.recallwhy.recall_exposure;
SELECT COUNT(*) AS n FROM lightning.metastore.recallwhy.recall_exposure.supplier;
SELECT COUNT(*) AS n FROM lightning.metastore.recallwhy.recall_exposure.item;
SELECT COUNT(*) AS n FROM lightning.metastore.recallwhy.recall_exposure.store;
SELECT COUNT(*) AS n FROM lightning.metastore.recallwhy.recall_exposure.inventory_lot;
SELECT COUNT(*) AS n, SUM(CASE WHEN matched_sku = 'unreached' THEN 1 ELSE 0 END) AS unreached_n FROM lightning.metastore.recallwhy.recall_exposure.ship_notice;
SELECT feed, COUNT(*) AS n FROM lightning.metastore.recallwhy.recall_exposure.recall_notice GROUP BY feed;
SELECT COUNT(*) AS n FROM lightning.metastore.recallwhy.recall_exposure.decision;
RUN DQ supplier_id TABLE lightning.metastore.recallwhy.recall_exposure.item;
RUN DQ store_id TABLE lightning.metastore.recallwhy.recall_exposure.inventory_lot;
RUN DQ sku TABLE lightning.metastore.recallwhy.recall_exposure.inventory_lot;
RUN DQ notice_sku TABLE lightning.metastore.recallwhy.recall_exposure.ship_notice;
RUN DQ matched_sku TABLE lightning.metastore.recallwhy.recall_exposure.ship_notice;
RUN DQ on_hand_not_negative TABLE lightning.metastore.recallwhy.recall_exposure.inventory_lot;
RUN DQ ships_units TABLE lightning.metastore.recallwhy.recall_exposure.ship_notice;
SHOW DQ INVALID RECORD matched_sku TABLE lightning.metastore.recallwhy.recall_exposure.ship_notice;
