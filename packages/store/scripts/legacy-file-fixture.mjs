// ─── Legacy (pre-registry) SQLite file fixture ──────────────────────────────
// Writes a SQLite file in the layout @mirk/store produced BEFORE MR-21: physical
// table names derived from `<prefix><sanitized>_<fnv32>` with NO `_mirk_tables`
// registry and NO `_mirk_meta`. Both the TypeScript and the Python adapter open
// this file to prove the adoption step — an existing file keeps working, its
// tables are claimed in place, and no data is rewritten.
//
// The DDL below is copied verbatim from docs/python-port/digests/store-graph-sqlite.md
// sections B.2, B.3 and B.4 (the layout as observed on a real pre-MR-21 file).
// It is intentionally NOT imported from src/: a fixture that shares code with the
// adapter under test proves nothing.
//
// Usage:
//   node packages/store/scripts/legacy-file-fixture.mjs <out-path>
//
// Contents, chosen so the registry's collision handling is observable:
//   collection "%$;**@"  -> c_______jqoxun          rows p1 (legacy-a), p2 (legacy-b)
//   search     "%$;**@"  -> search_docs_______jqoxun / search_fts_______jqoxun
//                           doc d1 "aardvark burrow"
//   kv         "greeting" = "hello"
// "~,~$(*" sanitizes and hashes identically but is absent, so opening this file
// must adopt the legacy tables for "%$;**@" and route "~,~$(*" to a `_2` table.

import { rmSync } from "node:fs";
import Database from "better-sqlite3";

/** Pre-MR-21 naming, copied from the digest: 32-bit FNV-1a over UTF-16 code
 *  units, base36, appended to the sanitized name. */
function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function legacyName(prefix, name) {
  return `${prefix}${name.replace(/[^a-zA-Z0-9_]/g, "_")}_${hashName(name)}`;
}

export const LEGACY_COLLECTION = "%$;**@";
export const COLLIDING_COLLECTION = "~,~$(*";

export function writeLegacyFixture(path) {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

  const collection = legacyName("c_", LEGACY_COLLECTION);
  const docs = legacyName("search_docs_", LEGACY_COLLECTION);
  const fts = legacyName("search_fts_", LEGACY_COLLECTION);

  db.exec(`
    CREATE TABLE IF NOT EXISTS _kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ${collection} (
      id TEXT PRIMARY KEY,
      data JSON NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS _mirk_search_schema (
      collection TEXT PRIMARY KEY,
      fields_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "${docs}" (
      id TEXT PRIMARY KEY,
      "text" TEXT NOT NULL,
      meta_json TEXT
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS "${fts}" USING fts5(
      "text", content='${docs}', content_rowid='rowid', tokenize='unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS "${docs}_ai" AFTER INSERT ON "${docs}" BEGIN
      INSERT INTO "${fts}"(rowid, "text") VALUES (new.rowid, new."text");
    END;
    CREATE TRIGGER IF NOT EXISTS "${docs}_ad" AFTER DELETE ON "${docs}" BEGIN
      INSERT INTO "${fts}"("${fts}", rowid, "text") VALUES('delete', old.rowid, old."text");
    END;
    CREATE TRIGGER IF NOT EXISTS "${docs}_au" AFTER UPDATE ON "${docs}" BEGIN
      INSERT INTO "${fts}"("${fts}", rowid, "text") VALUES('delete', old.rowid, old."text");
      INSERT INTO "${fts}"(rowid, "text") VALUES (new.rowid, new."text");
    END;
  `);

  db.prepare("INSERT INTO _kv (key, value) VALUES (?, ?)").run(
    "greeting",
    JSON.stringify("hello"),
  );
  const insertRow = db.prepare(`INSERT INTO ${collection} (id, data) VALUES (?, ?)`);
  insertRow.run("p1", JSON.stringify({ id: "p1", tag: "legacy-a" }));
  insertRow.run("p2", JSON.stringify({ id: "p2", tag: "legacy-b" }));
  db.prepare(
    "INSERT INTO _mirk_search_schema (collection, fields_json) VALUES (?, ?)",
  ).run(LEGACY_COLLECTION, JSON.stringify(["text"]));
  db.prepare(`INSERT INTO "${docs}" (id, "text", meta_json) VALUES (?, ?, ?)`).run(
    "d1",
    "aardvark burrow",
    null,
  );

  db.close();
  return { path, collection, docs, fts };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: node legacy-file-fixture.mjs <out-path>");
    process.exit(1);
  }
  const result = writeLegacyFixture(out);
  console.log(JSON.stringify(result, null, 2));
}
