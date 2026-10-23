import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import BetterSqliteDatabase from "better-sqlite3";

import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import { SqliteAdapter } from "./adapters/sqlite.js";

function tempDb(label: string): string {
  return join(tmpdir(), `mirk-node-${label}-${process.pid}-${Date.now()}.sqlite`);
}

function clean(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

describe("NodeSqliteAdapter", () => {
  it("serves KV, vector, search, and nested transactions on one DatabaseSync", () => {
    const adapter = new NodeSqliteAdapter({ path: ":memory:", dimensions: 3 });
    try {
      adapter.kv.set("user:1", { name: "Ada" });
      adapter.kv.put("events", { id: "e1", type: "created" });
      adapter.vector.upsert("docs", {
        id: "doc-1",
        vector: Float32Array.from([1, 0, 0]),
        metadata: { source: "test" },
      });
      adapter.search.index("pages", { id: "intro", text: "hello world" });

      expect(adapter.kv.get("user:1")).toEqual({ name: "Ada" });
      expect(adapter.kv.getById("events", "e1")).toEqual({
        id: "e1",
        type: "created",
      });
      expect(adapter.vector.search("docs", Float32Array.from([1, 0, 0]))).toMatchObject([
        { id: "doc-1", score: 1, metadata: { source: "test" } },
      ]);
      expect(adapter.search.search("pages", "hello")[0]?.id).toBe("intro");

      expect(() =>
        adapter.transaction(() => {
          adapter.kv.set("rolled-back", true);
          throw new Error("rollback");
        }, "immediate"),
      ).toThrow("rollback");
      expect(adapter.kv.get("rolled-back")).toBeNull();

      adapter.transaction(() => {
        adapter.kv.set("outer", 1);
        try {
          adapter.transaction(() => {
            adapter.kv.set("inner", 2);
            throw new Error("inner rollback");
          });
        } catch (error) {
          expect(error).toEqual(new Error("inner rollback"));
        }
        adapter.kv.set("after-inner", 3);
      });
      expect(adapter.kv.keys()).toEqual([
        "after-inner",
        "outer",
        "user:1",
      ]);
    } finally {
      adapter.close();
    }
  });

  it("opens files written by better-sqlite3 and writes files it can reopen", () => {
    const path = tempDb("compatibility");
    try {
      const better = new SqliteAdapter({ path, dimensions: 2 });
      better.kv.set("from-better", { ok: true });
      better.vector.upsert("docs", { id: "b", vector: Float32Array.from([1, 0]) });
      better.close();

      const node = new NodeSqliteAdapter({ path, dimensions: 2 });
      expect(node.kv.get("from-better")).toEqual({ ok: true });
      expect(node.vector.get("docs", "b")?.vector).toEqual(
        Float32Array.from([1, 0]),
      );
      node.kv.set("from-node", { ok: true });
      node.close();

      const reopened = new SqliteAdapter({ path, dimensions: 2 });
      expect(reopened.kv.get("from-node")).toEqual({ ok: true });
      reopened.close();
    } finally {
      clean(path);
    }
  });

  it("shares a caller-supplied DatabaseSync connection", () => {
    const raw = new DatabaseSync(":memory:");
    const adapter = new NodeSqliteAdapter({ path: ":memory:", db: raw });
    try {
      adapter.kv.set("still-open", 1);
      expect(raw.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    } finally {
      adapter.close();
    }
  });

  it("normalizes node:sqlite busy errors to a retryable atomic failure", () => {
    const path = tempDb("busy");
    const blocker = new DatabaseSync(path, { timeout: 0 });
    const adapter = new NodeSqliteAdapter({ path, busyTimeoutMs: 0 });
    try {
      blocker.exec("BEGIN IMMEDIATE");
      let thrown: unknown;
      try {
        adapter.kv.mutateAtomically({
          conditions: [],
          operations: [{ op: "set", key: "blocked", value: true }],
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        name: "AtomicMutationBackendError",
        code: "unavailable",
        retryable: true,
      });
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
      adapter.close();
      clean(path);
    }
  });

  it("rejects oversized busy timeouts before touching caller-owned connections", () => {
    const rawNode = new DatabaseSync(":memory:");
    const rawBetter = new BetterSqliteDatabase(":memory:");
    try {
      expect(() =>
        new NodeSqliteAdapter({
          path: ":memory:",
          db: rawNode,
          busyTimeoutMs: 2_147_483_648,
        }),
      ).toThrow(
        expect.objectContaining({ name: "SqliteAdapterError", code: "invalid-busy-timeout" }),
      );
      expect(() =>
        new SqliteAdapter({
          path: ":memory:",
          db: rawBetter,
          busyTimeoutMs: 2_147_483_648,
        }),
      ).toThrow(
        expect.objectContaining({ name: "SqliteAdapterError", code: "invalid-busy-timeout" }),
      );
      expect(rawNode.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
      expect(rawBetter.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    } finally {
      rawNode.close();
      rawBetter.close();
    }
  });
});

