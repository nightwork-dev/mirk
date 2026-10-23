// Store-specific receipt expiry behavior the shared corpus cannot express:
// files written by an earlier release, backlogs larger than one batch, and
// option checks. The expiry rules themselves are pinned by the
// `store/atomic/receipt-*` conformance scenarios.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteAdapter } from "./adapters/sqlite.js";
import { InMemoryKv, RECEIPT_PRUNE_BATCH } from "./index.js";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mirk-receipts-"));
  path = join(directory, "store.db");
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const request = {
  operations: [{ op: "set" as const, key: "k", value: 1 }],
  idempotency: { key: "once" },
};

describe("SQLite receipt expiry", () => {
  it("adds the creation column to an earlier release's file and gives its receipts one full window", () => {
    const legacy = new Database(path);
    legacy.exec(
      "CREATE TABLE _mirk_atomic_receipts (idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result_json TEXT NOT NULL)"
    );
    legacy.close();
    const first = new SqliteAdapter({ path });
    expect(first.kv.mutateAtomically(request).status).toBe("applied");
    first.close();
    const raw = new Database(path);
    raw.exec("UPDATE _mirk_atomic_receipts SET created_at = NULL");
    raw.close();

    let now = 5_000;
    const adapter = new SqliteAdapter({ path, receiptRetentionMs: 100, now: () => now });
    try {
      expect(adapter.kv.mutateAtomically(request).status).toBe("replayed");
      now += 100;
      expect(adapter.kv.pruneExpiredReceipts()).toBe(0);
      expect(adapter.kv.mutateAtomically(request).status).toBe("replayed");
      now += 1;
      expect(adapter.kv.pruneExpiredReceipts()).toBe(1);
    } finally {
      adapter.close();
    }
  });

  it("prunes at most one batch on a keyed write and the rest on an explicit prune", async () => {
    let now = 1_000;
    const adapter = new SqliteAdapter({ path, receiptRetentionMs: 10, now: () => now });
    try {
      const backlog = RECEIPT_PRUNE_BATCH * 2 + 5;
      for (let index = 0; index < backlog; index += 1) {
        adapter.kv.mutateAtomically({
          operations: [{ op: "set", key: `k${index}`, value: index }],
          idempotency: { key: `r${index}` },
        });
      }
      now += 11;
      adapter.kv.mutateAtomically({ operations: [{ op: "set", key: "x", value: 0 }], idempotency: { key: "x" } });
      expect(adapter.kv.pruneExpiredReceipts()).toBe(backlog - RECEIPT_PRUNE_BATCH);
      expect(await adapter.asyncKv.pruneExpiredReceipts()).toBe(0);
    } finally {
      adapter.close();
    }
  });

  it("keeps receipts forever and stamps them anyway when no window is set", () => {
    const adapter = new SqliteAdapter({ path, now: () => 42 });
    try {
      adapter.kv.mutateAtomically(request);
      expect(adapter.kv.receiptRetentionMs).toBeUndefined();
      expect(adapter.kv.pruneExpiredReceipts()).toBe(0);
    } finally {
      adapter.close();
    }
    const raw = new Database(path);
    expect(raw.prepare("SELECT created_at FROM _mirk_atomic_receipts").get()).toEqual({ created_at: 42 });
    raw.close();
  });
});

describe("receipt retention option", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses %s", (value) => {
    expect(() => new InMemoryKv({ receiptRetentionMs: value })).toThrow(
      "receiptRetentionMs must be a positive safe integer"
    );
    expect(() => new SqliteAdapter({ path: ":memory:", receiptRetentionMs: value })).toThrow(
      "receiptRetentionMs must be a positive safe integer"
    );
  });
});
