import { describe, expect, it } from "vitest";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SqliteAdapter } from "./adapters/sqlite.js";

function tempDb(label: string): string {
  return join(
    tmpdir(),
    `mirk-${label}-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.sqlite`
  );
}

function clean(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
}

describe("SQLite operational inspection", () => {
  it("does not cache a collection table that an outer transaction rolls back", () => {
    const adapter = new SqliteAdapter({ path: ":memory:" });
    try {
      expect(() =>
        adapter.transaction(() => {
          adapter.kv.put("rolled-back", { id: "x", value: 1 });
          throw new Error("rollback");
        }, "immediate")
      ).toThrow("rollback");

      expect(adapter.kv.getById("rolled-back", "x")).toBeNull();
      expect(() =>
        adapter.kv.put("rolled-back", { id: "x", value: 2 })
      ).not.toThrow();
      expect(adapter.kv.getById("rolled-back", "x")).toEqual({
        id: "x",
        value: 2,
      });
    } finally {
      adapter.close();
    }
  });

  it("reports configuration and does not disclose the path by default", () => {
    const path = tempDb("inspect");
    const adapter = new SqliteAdapter({ path, busyTimeoutMs: 237 });
    try {
      adapter.kv.set("record", { value: 1 });
      const before = existsSync(`${path}-wal`)
        ? statSync(`${path}-wal`).size
        : 0;
      const inspection = adapter.inspect();
      expect(inspection.journalMode.toLowerCase()).toBe("wal");
      expect(inspection.foreignKeys).toBe(true);
      expect(inspection.busyTimeoutMs).toBe(237);
      expect(inspection.transactionState).toBe("none");
      expect(inspection.pageCount).toBeGreaterThan(0);
      expect(inspection.dataVersion).toBeGreaterThan(0);
      expect(JSON.stringify(inspection)).not.toContain(path);
      const after = existsSync(`${path}-wal`)
        ? statSync(`${path}-wal`).size
        : 0;
      expect(after).toBe(before);
      expect(adapter.inspect({ debugPaths: true }).path).toBe(path);
    } finally {
      adapter.close();
      clean(path);
    }
  });

  it("runs explicit passive, restart, and truncate checkpoints", () => {
    const path = tempDb("checkpoint");
    const adapter = new SqliteAdapter({ path, busyTimeoutMs: 2_000 });
    try {
      for (let index = 0; index < 30; index += 1) {
        adapter.kv.set(`k:${index}`, "x".repeat(256));
      }
      const before = adapter.inspect();
      const passive = adapter.checkpoint("passive");
      expect(passive.busy).toBeGreaterThanOrEqual(0);
      expect(passive.logFrames).toBeGreaterThanOrEqual(
        passive.checkpointedFrames
      );
      const restart = adapter.checkpoint("restart");
      expect(restart.busy).toBeGreaterThanOrEqual(0);
      const truncate = adapter.checkpoint("truncate");
      expect(truncate.busy).toBeGreaterThanOrEqual(0);
      expect(adapter.kv.get("k:29")).toBe("x".repeat(256));
      const after = adapter.inspect();
      expect(after.pageCount).toBeGreaterThanOrEqual(before.pageCount);
      expect(after.walFileSizeBytes ?? 0).toBeLessThanOrEqual(
        before.walFileSizeBytes ?? Number.MAX_SAFE_INTEGER
      );
      // A checkpoint result is a compact operational record, not raw SQLite
      // output (and therefore stays stable across better-sqlite3 versions).
      expect(Object.keys(truncate).sort()).toEqual([
        "busy",
        "checkpointedFrames",
        "logFrames",
      ]);
    } finally {
      adapter.close();
      clean(path);
    }
  });
});
