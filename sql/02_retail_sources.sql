-- Synthetic retailer databases (Postgres in docker-compose) as two Zetaris JDBC datasources.
-- ${RW_PG_USER} / ${RW_PG_PASSWORD} are filled from .env by scripts/setup-zetaris.ts; never commit real values.
CREATE DATASOURCE erp DESCRIBE BY "Northwind-Mercantile-ERP,synthetic" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://host.docker.internal:55432/erp",
  username "${RW_PG_USER}",
  password "${RW_PG_PASSWORD}",
  fetchsize "5000"
);
REGISTER DATASOURCE TABLES FROM erp;
CREATE DATASOURCE supplier_portal DESCRIBE BY "Supplier-portal-ship-notices,synthetic" OPTIONS (
  jdbcdriver "org.postgresql.Driver",
  jdbcurl "jdbc:postgresql://host.docker.internal:55432/supplier_portal",
  username "${RW_PG_USER}",
  password "${RW_PG_PASSWORD}",
  fetchsize "5000"
);
REGISTER DATASOURCE TABLES FROM supplier_portal;
