import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteAdapter } from "./adapters/sqlite.js";
import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import type { SqliteAdapterCore } from "./adapters/sqlite-core.js";
import { namespaceAsyncStore } from "./namespace.js";
import {
  asyncTransactionContract,
  type TransactionContractHandle,
} from "./conformance/transaction-contract.js";

const drivers: [string, (path: string) => SqliteAdapterCore][] = [
  ["better-sqlite3", (path) => new SqliteAdapter({ path, busyTimeoutMs: 1000 })],
  ["node:sqlite", (path) => new NodeSqliteAdapter({ path, busyTimeoutMs: 1000 })],
];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function handle(adapter: SqliteAdapterCore): TransactionContractHandle {
  return {
    kv: adapter.asyncKv,
    transaction: (work) => adapter.asyncTransaction(work),
    afterCommit: (notify) => adapter.afterCommit(notify),
  };
}

// node:sqlite opens `file:` URIs; better-sqlite3 13 treats them as paths.
asyncTransactionContract("SQLite (node:sqlite, a plain path and a file: URI to one file)", {
  async open() {
    const root = mkdtempSync(join(tmpdir(), "mirk-async-uri-"));
    const path = join(root, "store.sqlite");
    const first = new NodeSqliteAdapter({ path, busyTimeoutMs: 1000 });
    const second = new NodeSqliteAdapter({
      path: `file:${encodeURI(path)}?mode=rw`,
      busyTimeoutMs: 1000,
    });
    return {
      first: handle(first),
      second: handle(second),
      async close() {
        first.close();
        second.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
});

for (const [driver, open] of drivers) {
  asyncTransactionContract(`SQLite (${driver}, two adapters on one file)`, {
    async open() {
      const root = mkdtempSync(join(tmpdir(), "mirk-async-contract-"));
      const path = join(root, "store.sqlite");
      const first = open(path);
      const second = open(path);
      return {
        first: handle(first),
        second: handle(second),
        async close() {
          first.close();
          second.close();
          rmSync(root, { recursive: true, force: true });
        },
      };
    },
  });

  describe(`SQLite (${driver}) awaitable facet`, () => {
    it("rejects synchronous facets while asynchronous work owns the connection", async () => {
      const adapter = open(":memory:");
      try {
        const entered = deferred();
        const hold = deferred();
        const transaction = adapter.asyncTransaction(async () => {
          await adapter.asyncKv.set("state", "tentative");
          expect(adapter.kv.get("state")).toBe("tentative");
          entered.resolve();
          await hold.promise;
          throw new Error("cancelled");
        });
        await entered.promise;
        expect(() => adapter.kv.get("state")).toThrow("asyncKv");
        expect(() => adapter.transaction(() => undefined)).toThrow("asyncKv");
        const queued = adapter.asyncKv.get("state");
        hold.resolve();
        await expect(transaction).rejects.toThrow("cancelled");
        expect(await queued).toBeNull();
        expect(adapter.kv.get("state")).toBeNull();
      } finally {
        adapter.close();
      }
    });

    it("never runs a write started without await after the commit", async () => {
      const adapter = open(":memory:");
      try {
        const leaks: Promise<string>[] = [];
        await adapter.asyncTransaction(() => {
          for (let depth = 0; depth < 12; depth += 1) {
            let chain: Promise<void> = Promise.resolve();
            for (let step = 0; step < depth; step += 1) chain = chain.then(() => undefined);
            leaks.push(
              chain.then(() => {
                const write = adapter.asyncKv.set(`k${depth}`, depth);
                let state: string;
                try {
                  state = adapter.inspect().transactionState;
                } catch {
                  state = "refused";
                }
                return write.then(
                  () => state,
                  (error: Error) => error.message
                );
              })
            );
          }
        });
        for (const state of await Promise.all(leaks)) {
          expect(["write", "refused"]).toContain(
            state.includes("transaction has ended") ? "refused" : state
          );
        }
      } finally {
        adapter.close();
      }
    });

    it("serializes sibling nested transactions started without awaiting", async () => {
      const adapter = open(":memory:");
      try {
        await adapter.asyncTransaction(async () => {
          await Promise.all(
            [1, 2, 3].map((n) =>
              adapter.asyncTransaction(async () => {
                await adapter.asyncKv.set(String(n), n);
              })
            )
          );
        });
        expect(await adapter.asyncKv.keys()).toEqual(["1", "2", "3"]);
      } finally {
        adapter.close();
      }
    });

    it("refuses to open a handle on a file while asynchronous work owns it", async () => {
      const root = mkdtempSync(join(tmpdir(), "mirk-async-open-"));
      const path = join(root, "store.sqlite");
      const first = open(path);
      try {
        const entered = deferred();
        const hold = deferred();
        const transaction = first.asyncTransaction(async () => {
          entered.resolve();
          await hold.promise;
        });
        await entered.promise;
        expect(() => open(path)).toThrow(
          expect.objectContaining({ code: "async-operation-active" })
        );
        hold.resolve();
        await transaction;
        open(path).close();
      } finally {
        first.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("binds atomic tokens to namespaces and refuses cross-namespace compare-and-set", async () => {
      const adapter = open(":memory:");
      try {
        const a = namespaceAsyncStore(adapter.asyncKv, "a");
        const b = namespaceAsyncStore(adapter.asyncKv, "b");
        await a.set("x", 1);
        await b.set("x", 2);
        const prior = await a.getVersioned({ kind: "key", key: "x" });
        await expect(
          b.mutateAtomically({
            conditions: [
              { target: { kind: "key", key: "x" }, expected: "version", version: prior!.version },
            ],
            operations: [{ op: "set", key: "x", value: 3 }],
          })
        ).rejects.toThrow("different namespace");
        const applied = await a.mutateAtomically({
          conditions: [
            { target: { kind: "key", key: "x" }, expected: "version", version: prior!.version },
          ],
          operations: [{ op: "set", key: "x", value: 4 }],
        });
        expect(applied).toMatchObject({
          status: "applied",
          versions: [{ target: { kind: "key", key: "x" } }],
        });
        expect(await a.keys()).toEqual(["x"]);
        expect(await a.get("x")).toBe(4);
        expect(await b.get("x")).toBe(2);
      } finally {
        adapter.close();
      }
    });
  });
}
