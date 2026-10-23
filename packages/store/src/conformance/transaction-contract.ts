// ─── Shared AsyncStoreTransactions contract suite ──────────────────────────
// Test tooling, not a package entry point. Every adapter that implements
// AsyncStoreTransactions registers this suite from its own tests with two
// handles on one fresh database. The JSON corpus cannot carry these rules: they
// need interleaved awaits, callbacks, and a second connection.

import { describe, expect, it } from "vitest";

import type { AsyncStoreTransactions } from "../transaction-types.js";

type ContractTarget =
  | { kind: "key"; key: string }
  | { kind: "record"; collection: string; id: string };

/** The store calls the contract makes. It is structural, without the
 *  `StoreVersion` brand, so an adapter typed against the published
 *  `@mirk/store` declarations satisfies it as well as one built from source. */
export interface TransactionContractStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  getById(collection: string, id: string): Promise<unknown>;
  put(collection: string, item: { id: string; [field: string]: unknown }): Promise<unknown>;
  getVersioned(target: ContractTarget): Promise<{ value: unknown; version: string } | null>;
  mutateAtomically(request: {
    conditions?: readonly (
      | { target: ContractTarget; expected: "missing" | "present" }
      | { target: ContractTarget; expected: "version"; version: string }
    )[];
    operations: readonly (
      | { op: "set"; key: string; value: unknown }
      | { op: "delete"; key: string }
      | { op: "put"; collection: string; item: { id: string; [field: string]: unknown } }
      | { op: "remove"; collection: string; id: string }
    )[];
  }): Promise<{ status: string }>;
}

export interface TransactionContractHandle extends AsyncStoreTransactions {
  readonly kv: TransactionContractStore;
}

export interface TransactionContractDatabase {
  /** Two adapter instances, each with its own connection, on one database. */
  first: TransactionContractHandle;
  second: TransactionContractHandle;
  close(): Promise<void>;
}

export interface TransactionContractOptions {
  /** Open a fresh, empty database. */
  open(): Promise<TransactionContractDatabase>;
}

const KEY = (key: string) => ({ kind: "key" as const, key });
const RECORD = (collection: string, id: string) => ({
  kind: "record" as const,
  collection,
  id,
});

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** Resolves to "pending" if `promise` has not settled after `ms`. */
async function settledWithin<T>(
  promise: Promise<T>,
  ms: number
): Promise<"pending" | "settled"> {
  const timeout = new Promise<"pending">((resolve) =>
    setTimeout(() => resolve("pending"), ms)
  );
  return Promise.race([promise.then(() => "settled" as const, () => "settled" as const), timeout]);
}

export function asyncTransactionContract(
  name: string,
  options: TransactionContractOptions
): void {
  async function withDatabase(
    body: (db: TransactionContractDatabase) => Promise<void>
  ): Promise<void> {
    const db = await options.open();
    try {
      await body(db);
    } finally {
      await db.close();
    }
  }

  describe(`${name} AsyncStoreTransactions contract`, () => {
    describe("nesting", () => {
      it("rolls back only the failed nested transaction and commits the outer one", () =>
        withDatabase(async ({ first, second }) => {
          const value = await first.transaction(async () => {
            await first.kv.set("outer-before", 1);
            await expect(
              first.transaction(async () => {
                await first.kv.set("inner", 2);
                await first.kv.put("records", { id: "inner" });
                throw new Error("inner failed");
              })
            ).rejects.toThrow("inner failed");
            expect(await first.kv.get("inner")).toBeNull();
            await first.kv.set("outer-after", 3);
            return "committed";
          });
          expect(value).toBe("committed");
          expect(await second.kv.get("outer-before")).toBe(1);
          expect(await second.kv.get("outer-after")).toBe(3);
          expect(await second.kv.get("inner")).toBeNull();
          expect(await second.kv.getById("records", "inner")).toBeNull();
        }));

      it("joins the outer transaction, so an outer rollback undoes a committed nested one", () =>
        withDatabase(async ({ first, second }) => {
          await expect(
            first.transaction(async () => {
              await first.transaction(async () => {
                await first.kv.set("nested", 1);
              });
              expect(await first.kv.get("nested")).toBe(1);
              throw new Error("outer failed");
            })
          ).rejects.toThrow("outer failed");
          expect(await second.kv.get("nested")).toBeNull();
          expect(await first.kv.get("nested")).toBeNull();
        }));

      it("returns the work's value and rejects with the work's error", () =>
        withDatabase(async ({ first }) => {
          expect(await first.transaction(() => 7)).toBe(7);
          const failure = new Error("exact");
          await expect(
            first.transaction(() => {
              throw failure;
            })
          ).rejects.toBe(failure);
        }));
    });

    describe("own writes", () => {
      it("reads, versions, and compare-and-sets its own uncommitted key writes", () =>
        withDatabase(async ({ first, second }) => {
          await first.transaction(async () => {
            await first.kv.set("k", { n: 1 });
            expect(await first.kv.get("k")).toEqual({ n: 1 });
            const versioned = await first.kv.getVersioned(KEY("k"));
            expect(versioned?.value).toEqual({ n: 1 });
            const applied = await first.kv.mutateAtomically({
              conditions: [
                { target: KEY("k"), expected: "version", version: versioned!.version },
              ],
              operations: [{ op: "set", key: "k", value: { n: 2 } }],
            });
            expect(applied.status).toBe("applied");
            const stale = await first.kv.mutateAtomically({
              conditions: [
                { target: KEY("k"), expected: "version", version: versioned!.version },
              ],
              operations: [{ op: "set", key: "k", value: { n: 3 } }],
            });
            expect(stale.status).toBe("conflict");
            expect(await first.kv.get("k")).toEqual({ n: 2 });
          });
          expect(await second.kv.get("k")).toEqual({ n: 2 });
        }));

      it("reads, versions, and compare-and-sets its own uncommitted record writes", () =>
        withDatabase(async ({ first, second }) => {
          await first.transaction(async () => {
            await first.kv.put("jobs", { id: "j", state: "queued" });
            const versioned = await first.kv.getVersioned(RECORD("jobs", "j"));
            expect(versioned?.value).toEqual({ id: "j", state: "queued" });
            const present = await first.kv.mutateAtomically({
              conditions: [{ target: RECORD("jobs", "j"), expected: "present" }],
              operations: [
                { op: "put", collection: "jobs", item: { id: "j", state: "leased" } },
              ],
            });
            expect(present.status).toBe("applied");
            const leased = await first.kv.getVersioned(RECORD("jobs", "j"));
            expect(leased?.version).not.toBe(versioned?.version);
            const fenced = await first.kv.mutateAtomically({
              conditions: [
                {
                  target: RECORD("jobs", "j"),
                  expected: "version",
                  version: leased!.version,
                },
              ],
              operations: [{ op: "remove", collection: "jobs", id: "j" }],
            });
            expect(fenced.status).toBe("applied");
            expect(await first.kv.getById("jobs", "j")).toBeNull();
            expect(
              (
                await first.kv.mutateAtomically({
                  conditions: [{ target: RECORD("jobs", "j"), expected: "missing" }],
                  operations: [{ op: "set", key: "after-remove", value: true }],
                })
              ).status
            ).toBe("applied");
          });
          expect(await second.kv.getById("jobs", "j")).toBeNull();
          expect(await second.kv.get("after-remove")).toBe(true);
        }));

      it("never exposes uncommitted writes to the second connection", () =>
        withDatabase(async ({ first, second }) => {
          const written = gate();
          const release = gate();
          const transaction = first.transaction(async () => {
            await first.kv.set("tentative", 1);
            written.open();
            await release.wait;
            throw new Error("abandon");
          });
          await written.wait;
          const concurrentRead = second.kv.get("tentative");
          await settledWithin(concurrentRead, 50);
          release.open();
          await expect(transaction).rejects.toThrow("abandon");
          expect(await concurrentRead).toBeNull();
          expect(await second.kv.get("tentative")).toBeNull();
        }));
    });

    describe("second connection", () => {
      it("cannot compare-and-set against a version the open transaction replaced", () =>
        withDatabase(async ({ first, second }) => {
          await first.kv.set("lease", { owner: "none" });
          const original = await second.kv.getVersioned(KEY("lease"));
          const written = gate();
          const release = gate();
          let replaced: string | undefined;
          const transaction = first.transaction(async () => {
            await first.kv.set("lease", { owner: "first" });
            replaced = (await first.kv.getVersioned(KEY("lease")))!.version;
            written.open();
            await release.wait;
          });
          await written.wait;
          const competing = second.kv.mutateAtomically({
            conditions: [
              { target: KEY("lease"), expected: "version", version: original!.version },
            ],
            operations: [{ op: "set", key: "lease", value: { owner: "second" } }],
          });
          expect(await settledWithin(competing, 50)).toBe("pending");
          release.open();
          await transaction;
          const result = await competing;
          expect(result).toMatchObject({ status: "conflict", observed: replaced });
          expect(await second.kv.get("lease")).toEqual({ owner: "first" });
        }));

      it("cannot claim a missing target the open transaction created", () =>
        withDatabase(async ({ first, second }) => {
          const written = gate();
          const release = gate();
          const transaction = first.transaction(async () => {
            await first.kv.put("claims", { id: "c", by: "first" });
            written.open();
            await release.wait;
          });
          await written.wait;
          const competing = second.kv.mutateAtomically({
            conditions: [{ target: RECORD("claims", "c"), expected: "missing" }],
            operations: [{ op: "put", collection: "claims", item: { id: "c", by: "second" } }],
          });
          expect(await settledWithin(competing, 50)).toBe("pending");
          release.open();
          await transaction;
          expect(await competing).toMatchObject({ status: "conflict", observed: "present" });
          expect(await second.kv.getById("claims", "c")).toEqual({ id: "c", by: "first" });
        }));

      it("applies a waiting compare-and-set once the open transaction rolls back", () =>
        withDatabase(async ({ first, second }) => {
          await first.kv.set("lease", 0);
          const original = await second.kv.getVersioned(KEY("lease"));
          const written = gate();
          const release = gate();
          const transaction = first.transaction(async () => {
            await first.kv.set("lease", 1);
            written.open();
            await release.wait;
            throw new Error("abandon");
          });
          await written.wait;
          const competing = second.kv.mutateAtomically({
            conditions: [
              { target: KEY("lease"), expected: "version", version: original!.version },
            ],
            operations: [{ op: "set", key: "lease", value: 2 }],
          });
          release.open();
          await expect(transaction).rejects.toThrow("abandon");
          expect((await competing).status).toBe("applied");
          expect(await first.kv.get("lease")).toBe(2);
        }));
    });

    describe("afterCommit", () => {
      it("runs each callback once, in registration order, after the outermost commit", () =>
        withDatabase(async ({ first }) => {
          const calls: string[] = [];
          await first.transaction(async () => {
            first.afterCommit(() => calls.push("a"));
            await first.transaction(async () => {
              first.afterCommit(() => calls.push("b"));
              await first.kv.set("x", 1);
            });
            expect(calls).toEqual([]);
            first.afterCommit(() => calls.push("c"));
            expect(calls).toEqual([]);
          });
          expect(calls).toEqual(["a", "b", "c"]);
          await first.transaction(async () => {
            await first.kv.set("y", 1);
          });
          expect(calls).toEqual(["a", "b", "c"]);
        }));

      it("discards every callback when the outermost transaction rolls back", () =>
        withDatabase(async ({ first }) => {
          const calls: string[] = [];
          await expect(
            first.transaction(async () => {
              first.afterCommit(() => calls.push("outer"));
              await first.transaction(async () => {
                first.afterCommit(() => calls.push("inner"));
              });
              throw new Error("rollback");
            })
          ).rejects.toThrow("rollback");
          expect(calls).toEqual([]);
        }));

      it("discards only the callbacks of a nested transaction that rolled back", () =>
        withDatabase(async ({ first }) => {
          const calls: string[] = [];
          await first.transaction(async () => {
            first.afterCommit(() => calls.push("before"));
            await first
              .transaction(async () => {
                first.afterCommit(() => calls.push("discarded"));
                await first.transaction(async () => {
                  first.afterCommit(() => calls.push("discarded-grandchild"));
                });
                throw new Error("inner");
              })
              .catch(() => undefined);
            first.afterCommit(() => calls.push("after"));
          });
          expect(calls).toEqual(["before", "after"]);
        }));

      it("isolates a throwing callback from the others and from the commit", () =>
        withDatabase(async ({ first, second }) => {
          const calls: string[] = [];
          const value = await first.transaction(async () => {
            await first.kv.set("kept", true);
            first.afterCommit(() => calls.push("first"));
            first.afterCommit(() => {
              throw new Error("listener failed");
            });
            first.afterCommit(() => Promise.reject(new Error("async listener failed")));
            first.afterCommit(() => calls.push("last"));
            return "done";
          });
          expect(value).toBe("done");
          expect(calls).toEqual(["first", "last"]);
          expect(await second.kv.get("kept")).toBe(true);
        }));

      it("runs callbacks outside the finished transaction", () =>
        withDatabase(async ({ first, second }) => {
          const observed: Promise<unknown>[] = [];
          await first.transaction(async () => {
            await first.kv.set("state", "committed");
            first.afterCommit(() => {
              observed.push(first.kv.get("state"));
              observed.push(
                first.transaction(async () => {
                  await first.kv.set("follow-up", true);
                  return "follow-up";
                })
              );
            });
          });
          expect(await Promise.all(observed)).toEqual(["committed", "follow-up"]);
          expect(await second.kv.get("follow-up")).toBe(true);
        }));

      it("runs a callback immediately outside any transaction", () =>
        withDatabase(async ({ first }) => {
          const calls: string[] = [];
          first.afterCommit(() => calls.push("now"));
          expect(calls).toEqual(["now"]);
        }));
    });
  });
}
