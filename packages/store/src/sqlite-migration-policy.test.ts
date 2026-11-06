import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { NodeSqliteAdapter, backupSqliteFile } from "./adapters/node-sqlite.js";
import { NodeSqliteDriver } from "./adapters/sqlite-driver.js";
import { ensureMirkFormat } from "./adapters/sqlite-format.js";
const directories: string[] = [];
function paths() {
  const directory = mkdtempSync(join(tmpdir(), "mirk-policy-"));
  directories.push(directory);
  return {
    file: join(directory, "source.db"),
    backup: join(directory, "backup.db"),
  };
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function legacy(file: string) {
  const db = new Database(file);
  db.pragma("journal_mode=WAL");
  db.exec(`CREATE TABLE _mirk_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO _mirk_meta VALUES('schema_version','2');
 CREATE TABLE _mirk_tables(kind TEXT,name TEXT,table_name TEXT UNIQUE,PRIMARY KEY(kind,name));
 CREATE TABLE vectors(collection TEXT,id TEXT,vec BLOB,metadata TEXT,PRIMARY KEY(collection,id));
 INSERT INTO vectors VALUES('assets','a',X'0000803f00000000',NULL);
 CREATE TABLE _vec_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO _vec_meta VALUES('dimensions','2');
 CREATE TABLE app(value TEXT); INSERT INTO app VALUES('WAL preimage');
 CREATE TABLE _mirk_atomic_receipts(idempotency_key TEXT PRIMARY KEY,request_digest TEXT,result_json TEXT);
 INSERT INTO _mirk_atomic_receipts VALUES('r','digest','{}');`);
  return db;
}
for (const Adapter of [SqliteAdapter, NodeSqliteAdapter])
  describe(Adapter.name, () => {
    it.each(["explicit", "refuse"] as const)(
      "refuses old files under %s without writes",
      (migration) => {
        const { file } = paths();
        const raw = legacy(file);
        const before = raw
          .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
          .all();
        expect(() => new Adapter({ path: file, migration })).toThrow(
          expect.objectContaining({
            code:
              migration === "explicit"
                ? "migration-required"
                : "migration-refused",
          }),
        );
        expect(
          raw.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
        ).toEqual(before);
        expect(raw.prepare("SELECT value FROM _mirk_meta").get()).toEqual({
          value: "2",
        });
        raw.close();
      },
    );
    it.each(["explicit", "refuse"] as const)(
      "initializes fresh files under %s",
      (migration) => {
        const { file } = paths();
        new Adapter({ path: file, migration }).close();
        expect(Adapter.migrate({ path: file })).toEqual({
          fromVersion: 4,
          toVersion: 4,
          changed: false,
        });
      },
    );
    it("backs up the WAL preimage, migrates explicitly with a chosen space and repairs old receipt columns", () => {
      const { file, backup } = paths();
      const raw = legacy(file);
      expect(existsSync(`${file}-wal`)).toBe(true);
      expect(
        Adapter.migrate({
          path: file,
          backupPath: backup,
          legacyVectorSpace: "text-v1",
        }),
      ).toEqual({
        fromVersion: 2,
        toVersion: 4,
        changed: true,
        backupPath: backup,
      });
      const copy = new Database(backup, { readonly: true });
      expect(copy.prepare("SELECT value FROM app").get()).toEqual({
        value: "WAL preimage",
      });
      expect(copy.prepare("SELECT value FROM _mirk_meta").get()).toEqual({
        value: "2",
      });
      expect(
        copy.prepare("SELECT hex(vec) AS bytes FROM vectors").get(),
      ).toEqual({ bytes: "0000803F00000000" });
      copy.close();
      const opened = new Adapter({
        path: file,
        migration: "refuse",
        legacyVectorSpace: "ignored",
      });
      expect(opened.vector.listSpaces()[0]?.name).toBe("text-v1");
      expect(Object.keys(opened.vector.get("assets", "a")!.vectors)).toEqual([
        "text-v1",
      ]);
      expect(
        opened.vector.search("assets", {
          space: "text-v1",
          vector: Float32Array.from([1, 0]),
        })[0]?.id,
      ).toBe("a");
      opened.close();
      raw.close();
      const migrated = new Database(file);
      expect(
        migrated.prepare("PRAGMA table_info(_mirk_atomic_receipts)").all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "created_at" }),
        ]),
      );
      expect(Adapter.migrate({ path: file, backupPath: backup })).toEqual({
        fromVersion: 4,
        toVersion: 4,
        changed: false,
      });
      migrated.close();
    });
    it("does not overwrite an existing backup or migrate after a backup failure", () => {
      const { file, backup } = paths();
      const raw = legacy(file);
      const destination = new Database(backup);
      destination.exec("CREATE TABLE kept(x);INSERT INTO kept VALUES(42)");
      destination.close();
      expect(() => Adapter.migrate({ path: file, backupPath: backup })).toThrow(
        expect.objectContaining({ code: "backup-failed" }),
      );
      expect(raw.prepare("SELECT value FROM _mirk_meta").get()).toEqual({
        value: "2",
      });
      const kept = new Database(backup);
      expect(kept.prepare("SELECT x FROM kept").get()).toEqual({ x: 42 });
      kept.close();
      expect(() =>
        Adapter.migrate({ path: file, backupPath: join(backup, "missing.db") }),
      ).toThrow(expect.objectContaining({ code: "backup-failed" }));
      expect(raw.prepare("SELECT value FROM _mirk_meta").get()).toEqual({
        value: "2",
      });
      raw.close();
    });
    it("rejects an incompatible destination space atomically", () => {
      const { file } = paths();
      const raw = legacy(file);
      raw.exec(
        "CREATE TABLE _mirk_vector_spaces(namespace TEXT,name TEXT,dimensions INTEGER,metric TEXT,encoding TEXT,PRIMARY KEY(namespace,name)); INSERT INTO _mirk_vector_spaces VALUES('default','text',3,'cosine','float32')",
      );
      expect(() =>
        Adapter.migrate({ path: file, legacyVectorSpace: "text" }),
      ).toThrow();
      expect(raw.prepare("SELECT value FROM _mirk_meta").get()).toEqual({
        value: "2",
      });
      expect(
        raw.prepare("SELECT dimensions FROM _mirk_vector_spaces").get(),
      ).toEqual({ dimensions: 3 });
      expect(raw.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({
        n: 1,
      });
      raw.close();
    });
  });
it("holds writer admission between the backup snapshot and migration", () => {
  const { file, backup } = paths();
  const old = legacy(file);
  old.close();
  const raw = new DatabaseSync(file);
  const driver = new NodeSqliteDriver(raw);
  const result = ensureMirkFormat(
    driver,
    (code, message) => Object.assign(new Error(message), { code }),
    { backupPath: backup },
    (destination) => {
      const contender = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync(${JSON.stringify(file)},{timeout:0});try{db.exec("UPDATE app SET value='raced'");process.exitCode=1;}catch(error){if(!String(error.message).includes('locked'))throw error;}finally{db.close();}`,
        ],
        { encoding: "utf8" },
      );
      expect(contender.status, contender.stderr).toBe(0);
      backupSqliteFile(file, destination);
    },
  );
  expect(result.changed).toBe(true);
  const copy = new DatabaseSync(backup);
  expect(copy.prepare("SELECT value FROM app").get()).toEqual({
    value: "WAL preimage",
  });
  copy.close();
  raw.exec("UPDATE app SET value='after migration'");
  raw.close();
});
for (const Adapter of [SqliteAdapter, NodeSqliteAdapter])
  it(`${Adapter.name} explicit migration honors a refusal pin`, () => {
    const { file } = paths();
    const raw = legacy(file);
    raw.close();
    expect(() => Adapter.migrate({ path: file, migration: "refuse" })).toThrow(
      expect.objectContaining({ code: "migration-refused" }),
    );
    expect(
      Adapter.migrate({ path: file, migration: "explicit" }),
    ).toMatchObject({ fromVersion: 2, toVersion: 4, changed: true });
  });
it("read-only migrations and future versions reject before creating a backup", () => {
  for (const node of [false, true]) {
    const { file, backup } = paths();
    legacy(file).close();
    if (node) {
      const db = new DatabaseSync(file, { readOnly: true });
      expect(() =>
        NodeSqliteAdapter.migrate({ path: file, db, backupPath: backup }),
      ).toThrow(expect.objectContaining({ code: "migration-required" }));
      db.close();
    } else {
      const db = new Database(file, { readonly: true });
      expect(() =>
        SqliteAdapter.migrate({ path: file, db, backupPath: backup }),
      ).toThrow(expect.objectContaining({ code: "migration-required" }));
      db.close();
    }
    expect(existsSync(backup)).toBe(false);
    const raw = new Database(file);
    raw.exec("UPDATE _mirk_meta SET value='999'");
    raw.close();
    expect(() =>
      (node ? NodeSqliteAdapter : SqliteAdapter).migrate({
        path: file,
        backupPath: backup,
      }),
    ).toThrow(expect.objectContaining({ code: "unsupported-schema-version" }));
    expect(existsSync(backup)).toBe(false);
  }
});
it("rejects missing canonical receipt columns in current-format files without repairing behind the version", () => {
  const { file } = paths();
  new SqliteAdapter({ path: file }).close();
  const raw = new Database(file);
  raw.exec(
    "DROP INDEX _mirk_atomic_receipts_created_at;ALTER TABLE _mirk_atomic_receipts DROP COLUMN created_at",
  );
  expect(() => new SqliteAdapter({ path: file })).toThrow(
    expect.objectContaining({ code: "malformed-schema" }),
  );
  expect(
    raw.prepare("PRAGMA table_info(_mirk_atomic_receipts)").all(),
  ).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "created_at" })]),
  );
  raw.close();
});

it("concurrent explicit migrators create one locked backup and converge", async () => {
  const { file, backup } = paths();
  legacy(file).close();
  const module = new URL("../dist/adapters/node-sqlite.js", import.meta.url)
    .href;
  const open = () =>
    new Promise<{ changed: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        `import{NodeSqliteAdapter}from ${JSON.stringify(module)}; console.log(JSON.stringify(NodeSqliteAdapter.migrate({path:${JSON.stringify(file)},backupPath:${JSON.stringify(backup)}})));`,
      ]);
      let output = "",
        error = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (error += chunk));
      child.on("exit", (code) =>
        code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)),
      );
    });
  const results = await Promise.all([open(), open()]);
  expect(results.map((result) => result.changed).sort()).toEqual([false, true]);
  const copy = new Database(backup);
  expect(copy.prepare("SELECT value FROM _mirk_meta").get()).toEqual({
    value: "2",
  });
  copy.close();
});
