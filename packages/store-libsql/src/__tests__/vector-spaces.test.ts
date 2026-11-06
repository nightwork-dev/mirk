import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeSqliteAdapter } from "@mirk/store/node-sqlite";
import { LibsqlAdapter } from "../libsql-adapter.js";

const v = (...values: number[]): Float32Array => Float32Array.from(values);

describe("libSQL named vector persistence", () => {
  it("initializes isolated prefixed formats through the shared migration plan", async () => {
    const client = createClient({ url: ":memory:" });
    const first = await LibsqlAdapter.open({ url: ":memory:", client, tablePrefix: "one_" });
    const second = await LibsqlAdapter.open({ url: ":memory:", client, tablePrefix: "two_" });
    try {
      await first.vector.ensureSpace("text", { dimensions: 2 });
      await second.vector.ensureSpace("text", { dimensions: 3 });
      await first.vector.upsert("docs", { id: "a", vectors: { text: v(1, 0) } });
      await second.vector.upsert("docs", { id: "a", vectors: { text: v(0, 1, 0) } });
      expect((await first.vector.get("docs", "a"))!.vectors.text).toEqual(v(1, 0));
      expect((await second.vector.get("docs", "a"))!.vectors.text).toEqual(v(0, 1, 0));
      const reopened = await LibsqlAdapter.open({ url: ":memory:", client, tablePrefix: "one_" });
      try { expect(await reopened.vector.count("docs")).toBe(1); } finally { reopened.close(); }
      expect((await client.execute("SELECT name FROM sqlite_master WHERE name='_mirk_meta'")).rows).toEqual([]);
    } finally { first.close(); second.close(); client.close(); }
  });

  it.each([false, true])("stores distinct dimensions, replaces maps and shares portable bytes (JS=%s)", async (forceJsCosine) => {
    const directory = mkdtempSync(join(tmpdir(), "mirk-libsql-spaces-"));
    const path = join(directory, "vectors.db");
    const db = await LibsqlAdapter.open({ url: `file:${path}`, forceJsCosine });
    try {
      await db.vector.ensureSpace("text", { dimensions: 2 });
      await db.vector.ensureSpace("image", { dimensions: 3 });
      await db.vector.upsert("assets", { id: "a", vectors: { text: v(1, 0), image: v(0, 1, 0) }, metadata: { kind: "keep" } });
      await db.vector.upsert("assets", { id: "b", vectors: { text: v(0, 1) } });
      expect(await db.vector.count("assets")).toBe(2);
      expect((await db.vector.search("assets", { space: "image", vector: v(0, 1, 0) }, { minScore: 1 })).map((hit) => hit.id)).toEqual(["a"]);
      await expect(db.vector.upsertMany("assets", [{ id: "valid", vectors: { text: v(1, 0) } }, { id: "bad", vectors: { image: v(1, 0) } }])).rejects.toMatchObject({ code: "dimension-mismatch" });
      expect(await db.vector.count("assets")).toBe(2);
      await db.vector.upsert("assets", { id: "a", vectors: { text: v(1, 0) } });
      expect(await db.vector.search("assets", { space: "image", vector: v(0, 1, 0) })).toEqual([]);
      expect((await db.vector.get("assets", "a"))!.metadata).toBeUndefined();
      const other = await LibsqlAdapter.open({ url: `file:${path}`, namespace: "other" });
      try { await other.vector.ensureSpace("text", { dimensions: 4 }); expect(await other.vector.count("assets")).toBe(0); } finally { other.close(); }
      db.close();
      const portable = new NodeSqliteAdapter({ path });
      try {
        expect(portable.vector.get("assets", "a")).toEqual({ id: "a", vectors: { text: v(1, 0) } });
        portable.vector.upsert("assets", { id: "a", vectors: { image: v(1, 0, 0) } });
      } finally { portable.close(); }
      const reopened = await LibsqlAdapter.open({ url: `file:${path}` });
      try { expect(await reopened.vector.get("assets", "a")).toEqual({ id: "a", vectors: { image: v(1, 0, 0) } }); expect(await reopened.vector.remove("assets", "a")).toBe(true); } finally { reopened.close(); }
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("migrates a version-two file once and preserves source bytes and application tables", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mirk-libsql-migration-"));
    const url = `file:${join(directory, "legacy.db")}`;
    const raw = createClient({ url });
    try {
      await raw.executeMultiple(`CREATE TABLE _mirk_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT INTO _mirk_meta VALUES('schema_version','2');
        CREATE TABLE vectors(collection TEXT,id TEXT,vec BLOB,metadata TEXT,PRIMARY KEY(collection,id));
        CREATE TABLE _vec_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT INTO _vec_meta VALUES('dimensions','2');
        INSERT INTO vectors VALUES('docs','a',x'0000803f00000000',NULL);
        CREATE TABLE application(value TEXT); INSERT INTO application VALUES('preserved');`);
      const db = await LibsqlAdapter.open({ url });
      expect(await db.vector.get("docs", "a")).toEqual({ id: "a", vectors: { default: v(1, 0) } });
      db.close();
      const reopened = await LibsqlAdapter.open({ url });
      reopened.close();
      expect((await raw.execute("SELECT value FROM _mirk_meta WHERE key='schema_version'")).rows[0]!.value).toBe("4");
      expect((await raw.execute("SELECT hex(vec) bytes FROM _mirk_vector_values")).rows[0]!.bytes).toBe("0000803F00000000");
      expect((await raw.execute("SELECT value FROM application")).rows[0]!.value).toBe("preserved");
      expect((await raw.execute("SELECT name FROM sqlite_master WHERE name IN ('vectors','_vec_meta')")).rows).toEqual([]);
    } finally { raw.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it("rolls back a failed format migration and can retry it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mirk-libsql-migration-failure-"));
    const url = `file:${join(directory, "legacy.db")}`;
    const raw = createClient({ url });
    try {
      await raw.executeMultiple(`CREATE TABLE _mirk_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT INTO _mirk_meta VALUES('schema_version','2');
        CREATE TABLE vectors(collection TEXT,id TEXT,vec BLOB,metadata TEXT,PRIMARY KEY(collection,id));
        INSERT INTO vectors VALUES('docs','a',x'0000803f00000000',NULL);
        CREATE TRIGGER fail_migration BEFORE UPDATE ON _mirk_meta
          WHEN NEW.value='4' BEGIN SELECT RAISE(ABORT,'migration-interrupted'); END;`);
      await expect(LibsqlAdapter.open({ url })).rejects.toThrow("migration-interrupted");
      expect((await raw.execute("SELECT value FROM _mirk_meta")).rows[0]!.value).toBe("2");
      expect((await raw.execute("SELECT hex(vec) bytes FROM vectors")).rows[0]!.bytes).toBe("0000803F00000000");
      expect((await raw.execute("SELECT name FROM sqlite_master WHERE name='_mirk_vector_values'")).rows).toEqual([]);
      await raw.execute("DROP TRIGGER fail_migration");
      const db = await LibsqlAdapter.open({ url });
      try { expect(await db.vector.get("docs", "a")).toEqual({ id: "a", vectors: { default: v(1, 0) } }); } finally { db.close(); }
    } finally { raw.close(); rmSync(directory, { recursive: true, force: true }); }
  });

});
