// ─── Physical table registry ────────────────────────────────────────────────
// `hashName` is a 32-bit hash, so it cannot be injective: `"%$;**@"` and
// `"~,~$(*"` sanitize to the same string AND collide on the hash, which before
// the `_mirk_tables` registry put both collections in one physical table. These
// tests pin the registry's three-step resolution, the in-place adoption of a
// file written before it existed, and the refusal to open a newer file.

import { describe, expect, it, afterEach } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { SqliteAdapter } from "./adapters/sqlite.js";
import { INSERT_REGISTERED_TABLE_SQL, isTableRegistryConflict } from "./sql.js";

/** The pre-registry file is built by the same script the Python compat test
 *  runs, invoked the same way, so one fixture definition serves both languages. */
const FIXTURE_SCRIPT = fileURLToPath(
  new URL("../scripts/legacy-file-fixture.mjs", import.meta.url),
);
function writeLegacyFixture(path: string): void {
  execFileSync(process.execPath, [FIXTURE_SCRIPT, path], { stdio: "pipe" });
}

const A = "%$;**@";
const B = "~,~$(*";
const LEGACY_TABLE = "c________jqoxun";
const LEGACY_DOCS = "search_docs________jqoxun";

const paths: string[] = [];
function tempDb(label: string): string {
  const path = join(
    tmpdir(),
    `mirk-${label}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  paths.push(path);
  return path;
}
afterEach(() => {
  for (const path of paths.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${path}${suffix}`, { force: true });
    }
  }
});

function registryRows(path: string): Array<{ kind: string; name: string; table_name: string }> {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .prepare("SELECT kind, name, table_name FROM _mirk_tables ORDER BY kind, name")
      .all() as Array<{ kind: string; name: string; table_name: string }>;
  } finally {
    db.close();
  }
}

describe("collision-safe collection tables", () => {
  it("keeps two collections that sanitize and hash identically apart", () => {
    const adapter = new SqliteAdapter({ path: ":memory:" });
    try {
      adapter.kv.put(A, { id: "a1", tag: "first" });
      adapter.kv.put(B, { id: "b1", tag: "second" });

      expect(adapter.kv.getById(A, "a1")).toEqual({ id: "a1", tag: "first" });
      expect(adapter.kv.getById(B, "b1")).toEqual({ id: "b1", tag: "second" });
      expect(adapter.kv.getById(A, "b1")).toBeNull();
      expect(adapter.kv.getById(B, "a1")).toBeNull();
      expect(adapter.kv.count(A)).toBe(1);
      expect(adapter.kv.count(B)).toBe(1);
    } finally {
      adapter.close();
    }
  });

  it("records the first name on the legacy table and suffixes the second", () => {
    const path = tempDb("registry");
    const adapter = new SqliteAdapter({ path });
    try {
      adapter.kv.put(A, { id: "a1" });
      adapter.kv.put(B, { id: "b1" });
    } finally {
      adapter.close();
    }
    expect(registryRows(path)).toEqual([
      { kind: "collection", name: A, table_name: LEGACY_TABLE },
      { kind: "collection", name: B, table_name: `${LEGACY_TABLE}_2` },
    ]);
  });

  it("resolves to the same physical tables after reopening the file", () => {
    const path = tempDb("reopen");
    const first = new SqliteAdapter({ path });
    try {
      first.kv.put(A, { id: "a1", tag: "first" });
      first.kv.put(B, { id: "b1", tag: "second" });
    } finally {
      first.close();
    }
    // A fresh connection resolves from the registry alone: order of first use
    // in this process must not change which table a name maps to.
    const second = new SqliteAdapter({ path });
    try {
      expect(second.kv.getById(B, "b1")).toEqual({ id: "b1", tag: "second" });
      expect(second.kv.getById(A, "a1")).toEqual({ id: "a1", tag: "first" });
      expect(second.kv.getById(B, "a1")).toBeNull();
    } finally {
      second.close();
    }
    expect(registryRows(path)).toHaveLength(2);
  });

  it("keeps two search collections that sanitize and hash identically apart", () => {
    const adapter = new SqliteAdapter({ path: ":memory:" });
    try {
      adapter.search.index(A, { id: "a", text: "aardvark burrow" });
      adapter.search.index(B, { id: "b", text: "basilisk burrow" });

      expect(adapter.search.search(A, "burrow").map((r) => r.id)).toEqual(["a"]);
      expect(adapter.search.search(B, "burrow").map((r) => r.id)).toEqual(["b"]);
      expect(adapter.search.search(A, "basilisk")).toEqual([]);
      expect(adapter.search.search(B, "aardvark")).toEqual([]);
    } finally {
      adapter.close();
    }
  });
});

describe("legacy files without a registry", () => {
  it("adopts the existing tables in place and reads the data already there", () => {
    const path = tempDb("legacy");
    writeLegacyFixture(path);

    const adapter = new SqliteAdapter({ path });
    try {
      expect(adapter.kv.get("greeting")).toBe("hello");
      expect(adapter.kv.getById(A, "p1")).toEqual({ id: "p1", tag: "legacy-a" });
      expect(adapter.kv.count(A)).toBe(2);
      expect(adapter.search.search(A, "aardvark").map((r) => r.id)).toEqual(["d1"]);

      // The colliding name is new to this file, so it gets its own table
      // instead of joining the adopted one.
      adapter.kv.put(B, { id: "b1", tag: "second" });
      expect(adapter.kv.count(A)).toBe(2);
      expect(adapter.kv.count(B)).toBe(1);
    } finally {
      adapter.close();
    }

    expect(registryRows(path)).toEqual([
      { kind: "collection", name: A, table_name: LEGACY_TABLE },
      { kind: "collection", name: B, table_name: `${LEGACY_TABLE}_2` },
      { kind: "search", name: A, table_name: LEGACY_DOCS },
    ]);
  });

  it("does not rewrite the adopted table", () => {
    const path = tempDb("adopt-inplace");
    writeLegacyFixture(path);
    const before = new Database(path, { readonly: true });
    const rowidsBefore = before
      .prepare(`SELECT rowid, id FROM ${LEGACY_TABLE} ORDER BY rowid`)
      .all();
    before.close();

    const adapter = new SqliteAdapter({ path });
    try {
      adapter.kv.list(A);
    } finally {
      adapter.close();
    }

    const after = new Database(path, { readonly: true });
    const rowidsAfter = after
      .prepare(`SELECT rowid, id FROM ${LEGACY_TABLE} ORDER BY rowid`)
      .all();
    after.close();
    expect(rowidsAfter).toEqual(rowidsBefore);
  });
});

describe("stray tables from an interrupted run", () => {
  it("skips an unclaimed suffixed table instead of adopting it", () => {
    const path = tempDb("stray");
    const seed = new Database(path);
    // A `_2` table with no registry row: what an interrupted run leaves behind.
    // Its rows belong to whatever name was mid-resolution, not to the next
    // colliding name that comes along.
    seed.exec(
      `CREATE TABLE ${LEGACY_TABLE}_2 (
         id TEXT PRIMARY KEY,
         data JSON NOT NULL,
         created_at TEXT DEFAULT (datetime('now')),
         updated_at TEXT DEFAULT (datetime('now')))`,
    );
    seed
      .prepare(`INSERT INTO ${LEGACY_TABLE}_2 (id, data) VALUES (?, ?)`)
      .run("stray", JSON.stringify({ id: "stray", tag: "not-ours" }));
    seed.close();

    const adapter = new SqliteAdapter({ path });
    try {
      adapter.kv.put(A, { id: "a1", tag: "first" });
      adapter.kv.put(B, { id: "b1", tag: "second" });
      // Only B's own row: the stray table was skipped, not adopted.
      expect(adapter.kv.count(B)).toBe(1);
      expect(adapter.kv.getById(B, "stray")).toBeNull();
    } finally {
      adapter.close();
    }

    expect(registryRows(path)).toEqual([
      { kind: "collection", name: A, table_name: LEGACY_TABLE },
      { kind: "collection", name: B, table_name: `${LEGACY_TABLE}_3` },
    ]);

    const check = new Database(path, { readonly: true });
    const stray = check.prepare(`SELECT id, data FROM ${LEGACY_TABLE}_2`).all();
    check.close();
    expect(stray).toEqual([
      { id: "stray", data: JSON.stringify({ id: "stray", tag: "not-ours" }) },
    ]);
  });
});

describe("search read paths", () => {
  it("mints neither a registry row nor a table for a collection never indexed", () => {
    const path = tempDb("search-read");
    const adapter = new SqliteAdapter({ path });
    try {
      expect(adapter.search.search("never-indexed", "anything")).toEqual([]);
      expect(adapter.search.remove("never-indexed", "a")).toBe(false);
    } finally {
      adapter.close();
    }

    expect(registryRows(path)).toEqual([]);
    const db = new Database(path, { readonly: true });
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    db.close();
    expect(tables.filter((name) => name.startsWith("search_docs_"))).toEqual([]);
    expect(tables.filter((name) => name.startsWith("search_fts_"))).toEqual([]);
  });
});

describe("schema version", () => {
  it("stamps schema_version 2 on a file it creates", () => {
    const path = tempDb("version");
    new SqliteAdapter({ path }).close();
    const db = new Database(path, { readonly: true });
    const row = db
      .prepare("SELECT value FROM _mirk_meta WHERE key = 'schema_version'")
      .get() as { value: string };
    db.close();
    expect(row.value).toBe("2");
  });

  it("refuses to open a file written by a newer adapter", () => {
    const path = tempDb("future");
    new SqliteAdapter({ path }).close();
    const db = new Database(path);
    db.prepare("UPDATE _mirk_meta SET value = '3' WHERE key = 'schema_version'").run();
    db.close();

    expect(() => new SqliteAdapter({ path })).toThrow(
      "Mirk SQLite file schema version 3 is newer than this adapter understands (2).",
    );
  });
});

describe("losing the race to register", () => {
  // Two processes resolving the same NEW logical name at once: both miss the
  // registry, both pick the same candidate, one INSERT wins and the other
  // violates the primary key. The loser must not surface that from an ordinary
  // `put`. Here the interleaving is forced: the adapter runs on a connection
  // whose first `_mirk_tables` INSERT is preceded by the winner's INSERT,
  // committed from a separate connection on the same file.
  it("re-reads the registry and uses the winner's table", () => {
    const path = tempDb("race");
    new SqliteAdapter({ path }).close();

    const winner = new Database(path);
    let fired = false;
    const loserDb = new Database(path);
    const injected = new Proxy(loserDb, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (fired || sql !== INSERT_REGISTERED_TABLE_SQL) return statement;
            return new Proxy(statement, {
              get(inner, innerProp) {
                if (innerProp === "run") {
                  return (...args: unknown[]) => {
                    if (!fired) {
                      fired = true;
                      // The winner claims the candidate first, and creates the
                      // table it claimed, exactly as a real opener would.
                      winner
                        .prepare(
                          "INSERT INTO _mirk_tables (kind, name, table_name) VALUES (?, ?, ?)",
                        )
                        .run("collection", A, LEGACY_TABLE);
                      winner.exec(
                        `CREATE TABLE IF NOT EXISTS ${LEGACY_TABLE} (
                           id TEXT PRIMARY KEY,
                           data JSON NOT NULL,
                           created_at TEXT DEFAULT (datetime('now')),
                           updated_at TEXT DEFAULT (datetime('now')))`,
                      );
                      winner
                        .prepare(`INSERT INTO ${LEGACY_TABLE} (id, data) VALUES (?, ?)`)
                        .run("w1", JSON.stringify({ id: "w1", tag: "winner" }));
                    }
                    return (inner.run as (...a: unknown[]) => unknown)(...args);
                  };
                }
                const value = Reflect.get(inner, innerProp);
                return typeof value === "function" ? value.bind(inner) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const loser = new SqliteAdapter({ path, db: injected });
    try {
      loser.kv.put(A, { id: "l1", tag: "loser" });
      // The write landed in the winner's table, alongside the winner's row.
      expect(loser.kv.getById(A, "w1")).toEqual({ id: "w1", tag: "winner" });
      expect(loser.kv.getById(A, "l1")).toEqual({ id: "l1", tag: "loser" });
      expect(loser.kv.count(A)).toBe(2);
    } finally {
      loser.close();
      winner.close();
    }

    expect(fired).toBe(true);
    // One row, the winner's. The loser recorded nothing of its own.
    expect(registryRows(path)).toEqual([
      { kind: "collection", name: A, table_name: LEGACY_TABLE },
    ]);
  });
});

describe("registry conflict detection", () => {
  // Two processes resolving the same new logical name at once produce one of
  // these; the driver restarts resolution instead of surfacing them from a
  // `put`. The restart itself is not witnessed here — the interleaving is
  // between statements of two connections and cannot be forced in-process —
  // but the error text the restart keys on is real, captured from SQLite.
  it("recognizes both constraint errors _mirk_tables can raise", () => {
    const path = tempDb("conflict");
    new SqliteAdapter({ path }).close();
    const db = new Database(path);
    const insert = db.prepare(
      "INSERT INTO _mirk_tables (kind, name, table_name) VALUES (?, ?, ?)",
    );
    insert.run("collection", "one", "c_one_x");

    let primaryKey: unknown;
    try {
      insert.run("collection", "one", "c_one_y");
    } catch (err) {
      primaryKey = err;
    }
    let unique: unknown;
    try {
      insert.run("collection", "two", "c_one_x");
    } catch (err) {
      unique = err;
    }
    db.close();

    expect(primaryKey).toBeInstanceOf(Error);
    expect(unique).toBeInstanceOf(Error);
    expect(isTableRegistryConflict(primaryKey)).toBe(true);
    expect(isTableRegistryConflict(unique)).toBe(true);
    expect(isTableRegistryConflict(new Error("database is locked"))).toBe(false);
  });
});
