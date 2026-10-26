import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSql } from "../src/sql/split.ts";

test("splitSql keeps a COMPILE USL model and its CREATE TABLEs as one statement", () => {
  const s = splitSql(`-- comment\nCREATE NAMESPACE IF NOT EXISTS a;\nCOMPILE USL IF NOT EXISTS m DEPLOY NAMESPACE a DDL\nCREATE TABLE x (\n  k varchar(2) NOT NULL PRIMARY KEY\n);\nCREATE TABLE y (\n  k varchar(2) FOREIGN KEY REFERENCES x(k)\n);\nUPDATE USL a.m SET DESCRIPTION d;\nSELECT 1`);
  assert.equal(s.length, 4);
  assert.match(s[1], /^COMPILE USL[\s\S]*CREATE TABLE x[\s\S]*;\nCREATE TABLE y/);
  assert.equal(s[2], "UPDATE USL a.m SET DESCRIPTION d");
  assert.equal(s[3], "SELECT 1");
});

test("splitSql leaves CREATE TABLE outside a USL model alone", () => {
  assert.deepEqual(splitSql("CREATE TABLE t (a int);\nSELECT 2;\n"), ["CREATE TABLE t (a int)", "SELECT 2"]);
});
