import { createClient } from "@libsql/client";
import { afterEach, describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { LibsqlAdapter } from "../libsql-adapter.js";
const dirs: string[] = [];
function files() {
  const dir = mkdtempSync(join(tmpdir(), "mirk-libsql-policy-"));
  dirs.push(dir);
  return { file: join(dir, "source.db"), backup: join(dir, "backup.db") };
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function legacy(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE _mirk_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO _mirk_meta VALUES('schema_version','2');
CREATE TABLE _mirk_tables(kind TEXT,name TEXT,table_name TEXT UNIQUE,PRIMARY KEY(kind,name));
CREATE TABLE vectors(collection TEXT,id TEXT,vec BLOB,metadata TEXT,PRIMARY KEY(collection,id));INSERT INTO vectors VALUES('assets','a',X'0000803f00000000',NULL);
CREATE TABLE _vec_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);INSERT INTO _vec_meta VALUES('dimensions','2');
CREATE TABLE app(value TEXT);INSERT INTO app VALUES('WAL preimage');`);
  return db;
}
describe("local libSQL migration policies", () => {
  it.each(["explicit", "refuse"] as const)(
    "rejects old %s and initializes new",
    async (migration) => {
      const { file } = files();
      const db = legacy(file);
      const url = pathToFileURL(file).href;
      const schema = db
        .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
        .all();
      await expect(
        LibsqlAdapter.open({ url, migration }),
      ).rejects.toMatchObject({
        code:
          migration === "explicit" ? "migration-required" : "migration-refused",
      });
      expect(
        db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
      ).toEqual(schema);
      db.close();
      const fresh = files();
      (
        await LibsqlAdapter.open({
          url: pathToFileURL(fresh.file).href,
          migration,
        })
      ).close();
    },
  );
  it("takes a consistent WAL backup and preserves custom space across reopen", async () => {
    const { file, backup } = files();
    const db = legacy(file);
    expect(existsSync(`${file}-wal`)).toBe(true);
    const url = pathToFileURL(file).href;
    expect(
      await LibsqlAdapter.migrate({
        url,
        backupPath: backup,
        legacyVectorSpace: "text-v1",
      }),
    ).toEqual({
      fromVersion: 2,
      toVersion: 4,
      changed: true,
      backupPath: backup,
    });
    const snapshot = new DatabaseSync(backup, { readOnly: true });
    expect(snapshot.prepare("SELECT value FROM app").get()).toEqual({
      value: "WAL preimage",
    });
    expect(snapshot.prepare("SELECT value FROM _mirk_meta").get()).toEqual({
      value: "2",
    });
    snapshot.close();
    const adapter = await LibsqlAdapter.open({ url, migration: "refuse" });
    expect((await adapter.vector.listSpaces())[0]?.name).toBe("text-v1");
    expect(
      Object.keys((await adapter.vector.get("assets", "a"))!.vectors),
    ).toEqual(["text-v1"]);
    expect(
      (
        await adapter.vector.search("assets", {
          space: "text-v1",
          vector: Float32Array.from([1, 0]),
        })
      )[0]?.id,
    ).toBe("a");
    adapter.close();
    db.close();
    expect(await LibsqlAdapter.migrate({ url, backupPath: backup })).toEqual({
      fromVersion: 4,
      toVersion: 4,
      changed: false,
    });
  });
  it("rejects backup overwrite, failed paths, and remote backup requests before mutation", async () => {
    const { file, backup } = files();
    const db = legacy(file);
    const url = pathToFileURL(file).href;
    writeFileSync(backup, "keep");
    for (const backupPath of [backup, join(backup, "missing")])
      await expect(
        LibsqlAdapter.migrate({ url, backupPath }),
      ).rejects.toMatchObject({ code: "backup-failed" });
    expect(readFileSync(backup, "utf8")).toBe("keep");
    expect(db.prepare("SELECT value FROM _mirk_meta").get()).toEqual({
      value: "2",
    });
    db.close();
    await expect(
      LibsqlAdapter.open({ url: "http://127.0.0.1:1", backupPath: backup }),
    ).rejects.toMatchObject({ code: "unsupported-backup" });
  });
});
it("explicit libSQL migration honors a refusal pin", async () => {
  const { file } = files();
  legacy(file).close();
  const url = pathToFileURL(file).href;
  await expect(
    LibsqlAdapter.migrate({ url, migration: "refuse" }),
  ).rejects.toMatchObject({ code: "migration-refused" });
  expect(
    await LibsqlAdapter.migrate({ url, migration: "explicit" }),
  ).toMatchObject({ fromVersion: 2, toVersion: 4, changed: true });
});

it("rejects a remote supplied client even when its options name a file URL", async () => {
  const { file, backup } = files();
  const client = createClient({ url: "http://127.0.0.1:1" });
  try {
    await expect(
      LibsqlAdapter.open({
        url: pathToFileURL(file).href,
        client,
        backupPath: backup,
      }),
    ).rejects.toMatchObject({ code: "unsupported-backup" });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(backup)).toBe(false);
  } finally {
    client.close();
  }
});
