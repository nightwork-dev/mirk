import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import BetterSqliteDatabase from "better-sqlite3";

import { SqliteAdapter } from "./adapters/sqlite.js";
import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import type { SqliteAdapterCore } from "./adapters/sqlite-core.js";

// Another process on the same file is stood in for by a second raw
// connection that mints a version number exactly when this adapter's
// connection runs a hooked statement. If the adapter has released the write
// lock at that moment, the other connection takes a number; otherwise it is
// refused with SQLITE_BUSY and tries again after the adapter is done.

type Hook = (sql: string) => void;

interface Harness {
  adapter: SqliteAdapterCore;
  otherMints: number[];
  hookOn(pattern: RegExp): void;
  close(): void;
}

function harness(driver: "better-sqlite3" | "node:sqlite"): Harness {
  const root = mkdtempSync(join(tmpdir(), "mirk-version-tokens-"));
  const path = join(root, "store.sqlite");
  const otherMints: number[] = [];
  let pattern: RegExp | undefined;
  let inHook = false;
  // The stand-in uses the adapter's own driver: two copies of SQLite in one
  // process do not see each other's file locks.
  let other: { prepare(sql: string): { get(): unknown }; close(): void } | undefined;
  const mintElsewhere = (): void => {
    other ??=
      driver === "better-sqlite3"
        ? new BetterSqliteDatabase(path, { timeout: 0 })
        : new DatabaseSync(path, { timeout: 0 });
    try {
      const row = other
        .prepare("UPDATE _mirk_atomic_sequence SET value = value + 1 WHERE id = 1 RETURNING value")
        .get() as { value: number };
      otherMints.push(Number(row.value));
    } catch {
      // The adapter still holds the write lock.
    }
  };
  const hook: Hook = (sql) => {
    if (inHook || !pattern?.test(sql)) return;
    inHook = true;
    try {
      mintElsewhere();
    } finally {
      inHook = false;
    }
  };
  const wrapStatement = <S extends { run: Function; get: Function }>(sql: string, statement: S): S =>
    new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== "run" && property !== "get") return typeof value === "function" ? value.bind(target) : value;
        return (...args: unknown[]) => {
          const result = (value as (...a: unknown[]) => unknown).apply(target, args);
          hook(sql);
          return result;
        };
      },
    });
  const wrapConnection = <D extends { exec(sql: string): unknown; prepare(sql: string): any }>(db: D): D =>
    new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "exec")
          return (sql: string) => {
            const result = target.exec(sql);
            hook(sql);
            return result;
          };
        if (property === "prepare") return (sql: string) => wrapStatement(sql, target.prepare(sql));
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const adapter =
    driver === "better-sqlite3"
      ? new SqliteAdapter({ path, db: wrapConnection(new BetterSqliteDatabase(path)) })
      : new NodeSqliteAdapter({ path, db: wrapConnection(new DatabaseSync(path)) });
  return {
    adapter,
    otherMints,
    hookOn(next) {
      pattern = next;
    },
    close() {
      adapter.close();
      other?.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const number = (version: string): number => Number(version.slice(version.lastIndexOf("-v") + 2));

for (const driver of ["better-sqlite3", "node:sqlite"] as const) {
  describe(`SQLite (${driver}) version tokens across processes`, () => {
    it("are not reissued after an async rollback", async () => {
      const h = harness(driver);
      try {
        h.adapter.kv.set("k", 0);
        let minted = "";
        h.hookOn(/^ROLLBACK/);
        await expect(
          h.adapter.asyncTransaction(async () => {
            await h.adapter.asyncKv.set("k", 1);
            minted = (await h.adapter.asyncKv.getVersioned({ kind: "key", key: "k" }))!.version;
            throw new Error("rollback");
          })
        ).rejects.toThrow("rollback");
        h.hookOn(/^$/);
        h.adapter.kv.set("k", 2);
        const after = h.adapter.kv.getVersioned({ kind: "key", key: "k" })!.version;
        expect(h.otherMints).not.toContain(number(minted));
        expect(after).not.toBe(minted);
      } finally {
        h.close();
      }
    });

    it("are not reissued after a synchronous rollback", () => {
      const h = harness(driver);
      try {
        h.adapter.kv.set("k", 0);
        let minted = "";
        h.hookOn(/^ROLLBACK/);
        expect(() =>
          h.adapter.transaction(() => {
            h.adapter.kv.set("k", 1);
            minted = h.adapter.kv.getVersioned({ kind: "key", key: "k" })!.version;
            throw new Error("rollback");
          }, "immediate")
        ).toThrow("rollback");
        h.hookOn(/^$/);
        h.adapter.kv.set("k", 2);
        expect(h.otherMints).not.toContain(number(minted));
        expect(h.adapter.kv.getVersioned({ kind: "key", key: "k" })!.version).not.toBe(minted);
      } finally {
        h.close();
      }
    });

    it("are unique when a row without a version is versioned on read", () => {
      const h = harness(driver);
      try {
        h.adapter.kv.set("seed", 0);
        const raw = new DatabaseSync(join(h.adapter.inspect({ debugPaths: true }).path!));
        raw.prepare("INSERT INTO _kv (key, value) VALUES ('legacy', '1')").run();
        raw.close();
        h.hookOn(/^UPDATE _mirk_atomic_sequence/);
        const version = h.adapter.kv.getVersioned({ kind: "key", key: "legacy" })!.version;
        expect(h.otherMints).not.toContain(number(version));
      } finally {
        h.close();
      }
    });
  });
}
