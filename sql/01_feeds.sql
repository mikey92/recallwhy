-- Live recall feeds as Zetaris Lightning REST tables. Re-run safe except the
-- CREATE LIGHTNING DATABASE / SCHEMASTORE CONTAINER lines (Zetaris has no IF NOT EXISTS).
CREATE LIGHTNING DATABASE OPENFDA_REST DESCRIBE BY "openFDA food enforcement REST source";
CREATE LIGHTNING DATABASE CPSC_REST DESCRIBE BY "CPSC SaferProducts recalls REST source";
CREATE SCHEMASTORE CONTAINER recallfeeds;
CREATE LIGHTNING REST TABLE food_enforcement FROM OPENFDA_REST REQUEST(
    endpoint "https://api.fda.gov/food/enforcement.json?search=report_date:%5B20260701+TO+20261231%5D&limit=1000",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();
CREATE LIGHTNING REST TABLE recalls_2026h2 FROM CPSC_REST REQUEST(
    endpoint "https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=2026-07-01",
    method "get",
    response_type "json",
    http_encoding "URLENCODED"
) HEADER (
) BODY ();
CREATE SCHEMASTORE VIEW fda_food WITH CONTAINER recallfeeds AS
SELECT r.recall_number, r.recalling_firm, r.product_description, r.reason_for_recall, r.code_info, r.more_code_info,
       r.distribution_pattern, r.classification, r.report_date, r.recall_initiation_date, r.status, r.product_type
FROM OPENFDA_REST.food_enforcement LATERAL VIEW explode(results) t AS r;
CREATE SCHEMASTORE VIEW cpsc_recalls WITH CONTAINER recallfeeds AS
SELECT RecallNumber AS recall_number, substr(RecallDate, 1, 10) AS recall_date, substr(LastPublishDate, 1, 10) AS last_publish,
       Title AS title, Description AS description,
       concat_ws('|', transform(Products, p -> p.Name)) AS product_names,
       concat_ws('|', transform(Products, p -> p.Model)) AS models,
       concat_ws('|', transform(ProductUPCs, u -> u.UPC)) AS upcs,
       concat_ws('|', concat(transform(Manufacturers, m -> m.Name), transform(Importers, m -> m.Name), transform(Distributors, m -> m.Name))) AS firms,
       concat_ws('|', transform(Hazards, h -> h.Name)) AS hazard,
       URL AS url
FROM CPSC_REST.recalls_2026h2;
