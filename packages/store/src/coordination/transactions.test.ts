import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../backends/memory.js";
import { InMemoryLogStore } from "../log/memory.js";
import { createMemoryTransactions } from "../transaction.js";
import {
  CoordinationOwnershipLostError,
  type CoordinationLease,
} from "./core.js";
import {
  createMemoryCoordinator,
  createMemoryCoordinationState,
} from "./memory.js";

function setup(enlist = true) {
  const kv = new InMemoryStore();
  const log = new InMemoryLogStore();
  const state = createMemoryCoordinationState();
  let now = 1000;
  const coordinator = createMemoryCoordinator({
    state,
    ownerTokenFactory: () => "same-token",
    clock: {
      now: () => now,
      sleep: async () => {
        throw new Error("unexpected sleep");
      },
    },
  });
  const tx = createMemoryTransactions({
    kv,
    log,
    ...(enlist ? { coordination: state } : {}),
  });
  const acquire = async (key = "key", leaseMs = 100) => {
    const result = await coordinator.tryAcquire(key, { leaseMs });
    if (result.status !== "acquired") throw new Error(result.status);
    return result.lease;
  };
  return {
    kv,
    log,
    state,
    coordinator,
    tx,
    acquire,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("memory lease transaction participation", () => {
  it("rolls back acquisition with KV/log and permanently fences escaped provisional handles", async () => {
    const s = setup();
    let escaped!: CoordinationLease;
    await expect(
      s.tx.transaction(async () => {
        escaped = await s.acquire();
        s.kv.set("private", true);
        s.log.append("private", true);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(s.kv.has("private")).toBe(false);
    expect(s.log.list("private")).toEqual([]);
    expect(escaped.signal.aborted).toBe(true);
    const next = await s.acquire();
    expect(next.ownerToken).toBe(escaped.ownerToken);
    expect(next.fencingGeneration).toBeGreaterThan(escaped.fencingGeneration);
    expect(await escaped.renew(100)).toBe(false);
    expect(await escaped.release()).toBe(false);
    expect(() => escaped.assertOwned()).toThrow(CoordinationOwnershipLostError);
    next.assertOwned();
  });

  it("restores renewal expiry, release, and failed ownership checks without aborting a valid handle", async () => {
    const s = setup();
    const lease = await s.acquire();
    await expect(
      s.tx.transaction(async () => {
        expect(await lease.renew(500)).toBe(true);
        expect(lease.expiresAt).toBe(1500);
        expect(await lease.release()).toBe(true);
        expect(lease.signal.aborted).toBe(false);
        expect(() => lease.assertOwned()).toThrow(
          CoordinationOwnershipLostError,
        );
        expect(await lease.renew(500)).toBe(false);
        expect(lease.signal.aborted).toBe(false);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(lease.signal.aborted).toBe(false);
    expect(lease.expiresAt).toBe(1100);
    lease.assertOwned();
    await s.tx.transaction(async () => {
      expect(await lease.release()).toBe(true);
      expect(lease.signal.aborted).toBe(false);
    });
    expect(lease.signal.aborted).toBe(true);
  });

  it("uses nested savepoints for rows, handle expiry and deferred signal effects", async () => {
    const s = setup();
    const lease = await s.acquire();
    let inner!: CoordinationLease;
    let committedChild!: CoordinationLease;
    await expect(
      s.tx.transaction(async () => {
        await lease.renew(500);
        await expect(
          s.tx.transaction(async () => {
            await lease.renew(1000);
            await lease.release();
            inner = await s.acquire();
            throw new Error("inner");
          }),
        ).rejects.toThrow("inner");
        expect(lease.expiresAt).toBe(1500);
        expect(inner.signal.aborted).toBe(true);
        expect(lease.signal.aborted).toBe(false);
        lease.assertOwned();
        await s.tx.transaction(async () => {
          committedChild = await s.acquire("other");
        });
        expect(committedChild.signal.aborted).toBe(false);
        throw new Error("outer");
      }),
    ).rejects.toThrow("outer");
    expect(lease.expiresAt).toBe(1100);
    lease.assertOwned();
    expect(committedChild.signal.aborted).toBe(true);
    expect((await s.acquire("other")).fencingGeneration).toBeGreaterThan(
      committedChild.fencingGeneration,
    );
  });

  it("rejects foreign synchronous handles, refuses immediate acquisition and queues renew/release", async () => {
    const s = setup();
    const lease = await s.acquire();
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => {
      ready = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const running = s.tx.transaction(async () => {
      await lease.renew(500);
      ready();
      await gate;
    });
    await entered;
    expect(() => lease.assertOwned()).toThrow("another transaction");
    expect(() => lease.expiresAt).toThrow("another transaction");
    let finished = 0;
    expect(await s.coordinator.tryAcquire("other")).toEqual({
      status: "unavailable",
      retryable: true,
    });
    const renewing = lease.renew(100).then((x) => {
      finished++;
      return x;
    });
    const releasing = lease.release().then((x) => {
      finished++;
      return x;
    });
    await Promise.resolve();
    expect(finished).toBe(0);
    release();
    await running;
    expect(await renewing).toBe(true);
    expect(await releasing).toBe(true);
    (await s.acquire("other")).assertOwned();
  });

  it("leaves unenlisted coordination independently committed and rejects double enlistment", async () => {
    const s = setup(false);
    let lease!: CoordinationLease;
    await expect(
      s.tx.transaction(async () => {
        lease = await s.acquire();
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    lease.assertOwned();
    const enlisted = setup();
    expect(() =>
      createMemoryTransactions({
        kv: new InMemoryStore(),
        log: new InMemoryLogStore(),
        coordination: enlisted.state,
      }),
    ).toThrow("already belongs");
  });
});
