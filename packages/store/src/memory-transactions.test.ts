import { asyncTransactionContract, type TransactionContractHandle } from "./conformance/transaction-contract.js";
import { describe, expect, it } from "vitest";
import { InMemoryStore } from "./backends/memory.js";
import { InMemoryLogStore } from "./log/memory.js";
import { toAsync } from "./to-async.js";
import { toAsyncLog } from "./log/to-async-log.js";
import { createMemoryTransactions } from "./transaction.js";

function setup() {
  const kv = new InMemoryStore();
  const log = new InMemoryLogStore();
  return { kv, log, tx: createMemoryTransactions({ kv, log }) };
}

describe("shared memory transactions", () => {
  it("commits the record and history together and restores deletion on rejection", async () => {
    const { kv, log, tx } = setup();
    await tx.transaction(() => {
      kv.put("jobs", { id: "a", state: "queued" });
      log.append("a", { state: "queued" });
    });
    const original = kv.getVersioned({ kind: "record", collection: "jobs", id: "a" });
    await expect(tx.transaction(async () => {
      kv.remove("jobs", "a");
      expect(log.deleteStream("a")).toBe(true);
      expect(log.append("a", "replacement")).toBe(1);
      await Promise.resolve();
      throw new Error("reject");
    })).rejects.toThrow("reject");
    expect(kv.getVersioned({ kind: "record", collection: "jobs", id: "a" })).toEqual(original);
    expect(log.list("a")).toEqual([{ generation: 1, sequence: 1, record: { state: "queued" } }]);
  });

  it("restores receipts and nested state while ordering only committed notifications", async () => {
    const { kv, log, tx } = setup();
    const events: string[] = [];
    const request = { operations: [{ op: "set" as const, key: "x", value: 1 }], idempotency: { key: "receipt" } };
    await tx.transaction(async () => {
      kv.set("outer", 1);
      tx.afterCommit(() => { events.push("first"); });
      await expect(tx.transaction(() => {
        kv.mutateAtomically(request);
        log.append("x", "inner");
        tx.afterCommit(() => { events.push("discarded"); });
        throw new Error("inner");
      })).rejects.toThrow("inner");
      expect(kv.has("x")).toBe(false);
      expect(log.list("x")).toEqual([]);
      expect(kv.mutateAtomically(request).status).toBe("applied");
      await tx.transaction(() => tx.afterCommit(() => { events.push("last"); }));
      expect(events).toEqual([]);
    });
    expect(events).toEqual(["first", "last"]);
    expect(kv.get("outer")).toBe(1);
  });

  it("rejects foreign sync operations and queues existing async bridges", async () => {
    const { kv, log, tx } = setup();
    const asyncKv = toAsync(kv);
    const asyncLog = toAsyncLog(log);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const transaction = tx.transaction(async () => {
      kv.set("private", true);
      entered();
      await gate;
      log.append("x", "committed");
    });
    await ready;
    expect(() => kv.get("private")).toThrow("another transaction");
    expect(() => log.append("x", "foreign")).toThrow("another transaction");
    let read = false;
    const pending = asyncKv.get("private").then((value) => { read = true; return value; });
    const append = asyncLog.append("x", "foreign");
    await Promise.resolve();
    expect(read).toBe(false);
    release();
    await transaction;
    expect(await pending).toBe(true);
    expect(await append).toBe(2);
    expect(log.list("x")).toHaveLength(2);
  });

  it("serializes concurrent transactions without losing their unlocks", async () => {
    const { kv, tx } = setup();
    await Promise.all(Array.from({ length: 10 }, () => tx.transaction(async () => {
      const value = kv.get<number>("n") ?? 0;
      await Promise.resolve();
      kv.set("n", value + 1);
    })));
    expect(kv.get("n")).toBe(10);
  });
});

asyncTransactionContract("Shared memory domain", {
  async open() {
    const { kv, tx } = setup();
    const handle = {
      kv: toAsync(kv),
      transaction: (work: () => unknown) => tx.transaction(work),
      afterCommit: tx.afterCommit.bind(tx),
    } as TransactionContractHandle;
    return { first: handle, second: handle, async close() {} };
  },
});
