import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqliteDatabase from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import type { SqliteAdapterCore, SqliteAdapterCoreOptions } from "./adapters/sqlite-core.js";
import { buildOrderBy, buildWhereClause } from "./sql.js";

type Options = Omit<SqliteAdapterCoreOptions, "db" | "ownsDb" | "path">;

interface Raw {
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  exec(sql: string): unknown;
  close(): unknown;
}

/** Each driver with a raw connection from the same SQLite library: two SQLite
 *  libraries on one file in one process release each other's locks. */
const DRIVERS: [string, (path: string, options?: Options) => SqliteAdapterCore, (path: string) => Raw][] = [
  ["better-sqlite3", (path, options) => new SqliteAdapter({ path, ...options }), (path) => new BetterSqliteDatabase(path)],
  ["node:sqlite", (path, options) => new NodeSqliteAdapter({ path, ...options }), (path) => new DatabaseSync(path)],
];

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mirk-statistics-"));
  dirs.push(dir);
  return join(dir, "store.db");
}

/** Many links share a few types; each `to` names few links. With statistics
 *  SQLite reads the `to` index for `{ to, type }`; without, it guesses. */
function loadLinks(store: SqliteAdapterCore, count: number): void {
  for (const field of ["from", "to", "type"]) store.kv.ensureIndex("links", field);
  store.transaction(() => {
    for (let i = 0; i < count; i++) {
      store.kv.put("links", { id: `l${i}`, from: `r${i % 97}`, to: `r${i}`, type: ["answers", "changes", "serves"][i % 3] });
    }
  }, "immediate");
}

/** The index a fresh connection picks for the store's `{ to, type }` read. */
function indexFor(path: string, connect: (path: string) => Raw): string {
  const raw = connect(path);
  try {
    const { table_name: table } = raw
      .prepare("SELECT table_name FROM _mirk_tables WHERE kind = 'collection' AND name = 'links'")
      .get() as { table_name: string };
    const where = buildWhereClause({ where: { to: "r7", type: "answers" } });
    const sql = `EXPLAIN QUERY PLAN SELECT data FROM ${table}${where.clause}${buildOrderBy().clause}`;
    const detail = (raw.prepare(sql).all(...where.params) as { detail: string }[]).map((row) => row.detail).join(" ");
    if (detail.includes(`_${hex("to")} `)) return "to";
    if (detail.includes(`_${hex("type")} `)) return "type";
    return detail;
  } finally {
    raw.close();
  }
}

function hex(field: string): string {
  return [...new TextEncoder().encode(field)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe.each(DRIVERS)("query statistics (%s)", (_name, open, connect) => {
  const planned = (path: string) => indexFor(path, connect);
  it("refreshes statistics after a bulk load, so a two-field filter reads the selective index", () => {
    const path = tempPath();
    const store = open(path);
    loadLinks(store, 3_000);

    expect(store.lastStatisticsRefresh).toMatchObject({ reason: "writes" });
    expect(store.lastStatisticsRefresh?.tables.length).toBeGreaterThan(0);
    expect(planned(path)).toBe("to");
    expect(store.kv.list("links", { where: { to: "r7", type: "changes" } }).map((link) => (link as { id: string }).id)).toEqual(["l7"]);
    store.close();
  });

  it("refreshes statistics when it opens a file that has none", () => {
    const path = tempPath();
    const writer = open(path, { refreshStatisticsAfterChanges: 0 });
    loadLinks(writer, 3_000);
    writer.close();
    expect(planned(path)).toBe("type");

    const reader = open(path);
    expect(reader.lastStatisticsRefresh).toMatchObject({ reason: "open" });
    expect(planned(path)).toBe("to");
    reader.close();
  });

  it("refreshStatistics() rebuilds them on request and reports the tables", () => {
    const path = tempPath();
    const store = open(path, { refreshStatisticsAfterChanges: 0 });
    loadLinks(store, 3_000);
    expect(planned(path)).toBe("type");

    const refresh = store.refreshStatistics();
    expect(refresh.reason).toBe("request");
    expect(refresh.tables.some((table) => table.startsWith("c_links"))).toBe(true);
    expect(store.lastStatisticsRefresh).toBe(refresh);
    expect(planned(path)).toBe("to");
    store.close();
  });

  it("skips an automatic refresh, without waiting, while another connection holds the write lock", () => {
    const path = tempPath();
    const store = open(path, { busyTimeoutMs: 5_000 });
    loadLinks(store, 300);
    const holder = connect(path);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      store.close();
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(store.lastStatisticsRefresh?.reason).toBe("close");
      expect(store.lastStatisticsRefresh?.skipped).toMatch(/locked|busy/i);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  });

  it("rejects a refresh threshold that is not a whole number of rows", () => {
    expect(() => open(tempPath(), { refreshStatisticsAfterChanges: -1 })).toThrow(RangeError);
    expect(() => open(tempPath(), { refreshStatisticsAfterChanges: 1.5 })).toThrow(RangeError);
  });
});

describe("query statistics with a supplied better-sqlite3 connection", () => {
  it("refreshes through the caller's connection", () => {
    const path = tempPath();
    const db = new BetterSqliteDatabase(path);
    const store = new SqliteAdapter({ path, db });
    loadLinks(store, 3_000);
    expect(indexFor(path, (file) => new BetterSqliteDatabase(file))).toBe("to");
    store.close();
  });
});
