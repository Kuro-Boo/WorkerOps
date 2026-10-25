import assert from "node:assert/strict";
import { addColumnTarget, createIndexName, splitSql } from "./sql.ts";

// 複数行の文は 1 文のまま(D1 の exec() は改行ごとに切ってしまう)。
assert.deepEqual(splitSql(`-- head
CREATE TABLE a (id TEXT);
CREATE UNIQUE INDEX a_open ON a (id)
  WHERE id IS NOT NULL;
`), ["CREATE TABLE a (id TEXT)", "CREATE UNIQUE INDEX a_open ON a (id)\n  WHERE id IS NOT NULL"]);

// トリガーは本体の中の ; で切らず、END; で閉じる。
assert.deepEqual(splitSql(`CREATE TRIGGER t BEFORE UPDATE ON a
WHEN OLD.id <> 'x'
BEGIN SELECT RAISE(ABORT, 'frozen'); UPDATE a SET id = id; END;
CREATE TABLE b (id TEXT);`), [
  "CREATE TRIGGER t BEFORE UPDATE ON a\nWHEN OLD.id <> 'x'\nBEGIN SELECT RAISE(ABORT, 'frozen'); UPDATE a SET id = id; END",
  "CREATE TABLE b (id TEXT)",
]);

// 文字列・名前の中の ; と -- は区切りにも注釈にもしない。'' は文字列の中の 1 文字。
assert.deepEqual(splitSql(`INSERT INTO a VALUES ('x;y -- z', 'it''s');
UPDATE "we;ird" SET id = 1; /* a ; b */ SELECT 1`), [
  "INSERT INTO a VALUES ('x;y -- z', 'it''s')",
  'UPDATE "we;ird" SET id = 1',
  "SELECT 1",
]);

// 中の注釈は残す(SQLite は書いたとおりの文を控える)。注釈の中の ; でも切らない。
assert.deepEqual(splitSql(`CREATE TABLE c (
  -- 説明; ここで切らない
  id TEXT /* 中; */
);`), ["CREATE TABLE c (\n  -- 説明; ここで切らない\n  id TEXT /* 中; */\n)"]);

// 注釈だけ・空の文は落とす。
assert.deepEqual(splitSql("-- only\n;\n  ;"), []);
assert.throws(() => splitSql("SELECT 'open"), /unterminated quote/);
assert.throws(() => splitSql("SELECT 1 /* open"), /unterminated comment/);

assert.deepEqual(addColumnTarget("ALTER TABLE idempotency ADD COLUMN owner TEXT"), { table: "idempotency", column: "owner" });
assert.deepEqual(addColumnTarget('ALTER TABLE "x" ADD "y" INTEGER'), { table: "x", column: "y" });
assert.equal(addColumnTarget("ALTER TABLE x RENAME TO y"), null);
assert.equal(createIndexName("CREATE UNIQUE INDEX a_open ON a (id)"), "a_open");
assert.equal(createIndexName("CREATE INDEX IF NOT EXISTS a_open ON a (id)"), null);
assert.equal(createIndexName("CREATE TABLE a (id TEXT)"), null);

console.log("sql: ok");
