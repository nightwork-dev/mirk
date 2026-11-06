import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
const dirs: string[] = [];
function path() {
  const dir = mkdtempSync(join(tmpdir(), "mirk-format-"));
  dirs.push(dir);
  return join(dir, "store.db");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture(file: string, blob = Buffer.from("0000803f00000000", "hex")) {
  const db = new Database(file);
  db.exec(`CREATE TABLE _mirk_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 INSERT INTO _mirk_meta VALUES('schema_version','2');
 CREATE TABLE _mirk_tables(kind TEXT NOT NULL,name TEXT NOT NULL,table_name TEXT NOT NULL UNIQUE,PRIMARY KEY(kind,name));
 CREATE TABLE vectors(collection TEXT NOT NULL,id TEXT NOT NULL,vec BLOB NOT NULL,metadata TEXT,PRIMARY KEY(collection,id));
 CREATE TABLE _vec_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 INSERT INTO _vec_meta VALUES('dimensions','2');
 CREATE TABLE application_data(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO application_data VALUES(1,'preserved');
 CREATE TABLE _mirk_atomic_identity(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO _mirk_atomic_identity VALUES(1,'original');
 CREATE TABLE _mirk_atomic_sequence(id INTEGER PRIMARY KEY,value INTEGER);INSERT INTO _mirk_atomic_sequence VALUES(1,42);
 CREATE TABLE _kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO _kv VALUES('key','{"kept":true}');
 CREATE TABLE _mirk_atomic_versions(kind TEXT,collection TEXT,target_key TEXT,version TEXT,PRIMARY KEY(kind,collection,target_key));INSERT INTO _mirk_atomic_versions VALUES('key','','key','original-v7');
 CREATE TABLE _mirk_atomic_receipts(idempotency_key TEXT PRIMARY KEY,request_digest TEXT NOT NULL,result_json TEXT NOT NULL,created_at INTEGER);INSERT INTO _mirk_atomic_receipts VALUES('receipt','digest','{"kept":true}',123);
 CREATE TABLE _mirk_log(stream TEXT,sequence INTEGER,record TEXT NOT NULL,PRIMARY KEY(stream,sequence));INSERT INTO _mirk_log VALUES('events',9,'{"kept":true}');`);
  db.prepare("INSERT INTO vectors VALUES(?,?,?,?)").run(
    "docs",
    "a",
    blob,
    null,
  );
  db.prepare("INSERT INTO vectors VALUES(?,?,?,?)").run(
    "docs",
    "b",
    blob,
    "{}",
  );
  db.close();
}
for (const Adapter of [SqliteAdapter, NodeSqliteAdapter])
  describe(Adapter.name, () => {
    it("migrates v2 byte-for-byte and preserves unrelated identities and application data", () => {
      const file = path();
      fixture(file);
      const adapter = new Adapter({ path: file });
      expect(adapter.vector.listSpaces()).toEqual([
        {
          name: "default",
          dimensions: 2,
          metric: "cosine",
          encoding: "float32",
        },
      ]);
      expect(adapter.vector.get("docs", "a")?.metadata).toBeUndefined();
      expect(adapter.vector.get("docs", "b")?.metadata).toEqual({});
      expect(
        adapter.kv.getVersioned({ kind: "key", key: "key" })?.version,
      ).toBe("original-v7");
      expect(adapter.log.lastSequence("events")).toBe(9);
      adapter.close();
      const raw = new Database(file);
      expect(
        raw
          .prepare("SELECT hex(vec) AS bytes FROM _mirk_vector_values LIMIT 1")
          .get(),
      ).toEqual({ bytes: "0000803F00000000" });
      expect(
        raw.prepare("SELECT value FROM _mirk_atomic_identity").get(),
      ).toEqual({ value: "original" });
      expect(
        raw.prepare("SELECT value FROM _mirk_atomic_sequence").get(),
      ).toEqual({ value: 42 });
      expect(
        raw
          .prepare(
            "SELECT request_digest,result_json,created_at FROM _mirk_atomic_receipts",
          )
          .get(),
      ).toEqual({
        request_digest: "digest",
        result_json: '{"kept":true}',
        created_at: 123,
      });
      expect(raw.prepare("SELECT value FROM application_data").get()).toEqual({
        value: "preserved",
      });
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('vectors','_vec_meta')",
          )
          .all(),
      ).toEqual([]);
      raw.close();
    });
    it("rolls back invalid BLOB migrations without changing old data or version", () => {
      const file = path();
      fixture(file, Buffer.from([1, 2, 3]));
      expect(() => new Adapter({ path: file })).toThrow(
        expect.objectContaining({ code: "malformed-schema" }),
      );
      const raw = new Database(file);
      expect(
        raw
          .prepare("SELECT value FROM _mirk_meta WHERE key='schema_version'")
          .get(),
      ).toEqual({ value: "2" });
      expect(
        raw.prepare("SELECT hex(vec) AS bytes FROM vectors LIMIT 1").get(),
      ).toEqual({ bytes: "010203" });
      expect(
        raw
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='_mirk_vector_spaces'",
          )
          .get(),
      ).toBeUndefined();
      raw.close();
    });
    it("rejects malformed and future versions before creating tables", () => {
      for (const version of ["3junk", "", "999"]) {
        const file = path();
        const raw = new Database(file);
        raw.exec(
          "CREATE TABLE _mirk_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
        );
        raw
          .prepare("INSERT INTO _mirk_meta VALUES(?,?)")
          .run("schema_version", version);
        const before = raw
          .prepare("SELECT sql FROM sqlite_master ORDER BY name")
          .all();
        raw.close();
        expect(() => new Adapter({ path: file })).toThrow();
        const after = new Database(file);
        expect(
          after.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(),
        ).toEqual(before);
        after.close();
      }
    });
  });
it("isolates space declarations and documents by namespace on one file", () => {
  const file = path();
  const a = new SqliteAdapter({ path: file, namespace: "a" });
  const b = new NodeSqliteAdapter({ path: file, namespace: "b" });
  a.vector.ensureSpace("text", { dimensions: 2 });
  b.vector.ensureSpace("text", { dimensions: 3 });
  a.vector.upsert("docs", {
    id: "same",
    vectors: { text: new Float32Array([1, 0]) },
  });
  expect(b.vector.count("docs")).toBe(0);
  expect(b.vector.listSpaces()[0]?.dimensions).toBe(3);
  a.close();
  b.close();
});
it("concurrent process openers converge on one migration", async () => {
  const file = path();
  fixture(file);
  const module = fileURLToPath(
    new URL("../dist/adapters/sqlite.js", import.meta.url),
  );
  const open = () =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        `import {SqliteAdapter} from ${JSON.stringify(module)}; const db=new SqliteAdapter({path:${JSON.stringify(file)}}); if(db.vector.count('docs')!==2)throw Error('missing');db.close();`,
      ]);
      let error = "";
      child.stderr.on("data", (value) => (error += value));
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(error)),
      );
    });
  await Promise.all([open(), open()]);
  const raw = new Database(file);
  expect(
    raw
      .prepare("SELECT value FROM _mirk_meta WHERE key='schema_version'")
      .get(),
  ).toEqual({ value: "4" });
  expect(
    raw.prepare("SELECT COUNT(*) AS n FROM _mirk_vector_values").get(),
  ).toEqual({ n: 2 });
  raw.close();
});

it("reports required migration for a read-only handle without touching v2", () => {
  const file = path();
  fixture(file);
  const raw = new Database(file, { readonly: true });
  expect(() => new SqliteAdapter({ path: file, db: raw })).toThrow(
    expect.objectContaining({ code: "migration-required" }),
  );
  expect(
    raw
      .prepare("SELECT value FROM _mirk_meta WHERE key='schema_version'")
      .get(),
  ).toEqual({ value: "2" });
  raw.close();
});

it("rolls back copied vectors and table drops when the final version write fails", () => {
  const file = path();
  fixture(file);
  const raw = new Database(file);
  raw.exec(
    "CREATE TRIGGER fail_version BEFORE UPDATE ON _mirk_meta BEGIN SELECT RAISE(ABORT,'injected migration failure'); END",
  );
  raw.close();
  expect(() => new SqliteAdapter({ path: file })).toThrow(
    "injected migration failure",
  );
  const check = new Database(file);
  expect(
    check
      .prepare("SELECT value FROM _mirk_meta WHERE key='schema_version'")
      .get(),
  ).toEqual({ value: "2" });
  expect(check.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({
    n: 2,
  });
  expect(
    check
      .prepare(
        "SELECT name FROM sqlite_master WHERE name='_mirk_vector_values'",
      )
      .get(),
  ).toBeUndefined();
  check.close();
});

for (const Adapter of [SqliteAdapter, NodeSqliteAdapter]) {
  it.each([true, false])(
    `${Adapter.name} rejects unsafe legacy dimensions with empty vector table: %s`,
    (hasVectorTable) => {
      const file = path();
      fixture(file);
      const raw = new Database(file);
      raw.exec("DELETE FROM vectors");
      if (!hasVectorTable) raw.exec("DROP TABLE vectors");
      const dimensions = "9007199254740992";
      raw
        .prepare("UPDATE _vec_meta SET value=? WHERE key='dimensions'")
        .run(dimensions);
      const schema = raw
        .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
        .all();
      expect(() => new Adapter({ path: file })).toThrow(
        expect.objectContaining({
          code: "malformed-schema",
          message: "Invalid legacy vector dimensions",
        }),
      );
      expect(
        raw.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
      ).toEqual(schema);
      expect(
        raw
          .prepare("SELECT value FROM _mirk_meta WHERE key='schema_version'")
          .get(),
      ).toEqual({ value: "2" });
      expect(
        raw.prepare("SELECT value FROM _vec_meta WHERE key='dimensions'").get(),
      ).toEqual({ value: dimensions });
      expect(raw.prepare("SELECT value FROM application_data").get()).toEqual({
        value: "preserved",
      });
      raw.close();
    },
  );
}
