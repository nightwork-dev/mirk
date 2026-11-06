import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../backends/memory.js";
import { InMemoryLogStore } from "../log/memory.js";
import {
  createMemoryTransactions,
  TransactionScopeError,
} from "../transaction.js";
import {
  CoordinationAbortedError,
  CoordinationTimeoutError,
  type CoordinationAbortSignal,
  type CoordinationClock,
} from "./core.js";
import {
  createMemoryCoordinationState,
  createMemoryCoordinator,
} from "./memory.js";

class Clock implements CoordinationClock {
  time = 1000;
  pending = new Set<{ at: number; finish(): void }>();
  now = () => this.time;
  sleep(ms: number, signal?: CoordinationAbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.pending.delete(task);
        signal?.removeEventListener("abort", abort);
      };
      const task = {
        at: this.time + ms,
        finish: () => {
          cleanup();
          resolve();
        },
      };
      const abort = () => {
        cleanup();
        reject(signal?.reason);
      };
      this.pending.add(task);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  async advance(ms = 0): Promise<void> {
    this.time += ms;
    for (const task of [...this.pending])
      if (task.at <= this.time) task.finish();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}
function setup() {
  const state = createMemoryCoordinationState();
  const clock = new Clock();
  const coordinator = createMemoryCoordinator({ state, clock });
  const tx = createMemoryTransactions({
    kv: new InMemoryStore(),
    log: new InMemoryLogStore(),
    coordination: state,
  });
  return { state, clock, coordinator, tx };
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

describe("immediate enlisted-memory admission", () => {
  it("returns unavailable before a foreign transaction ends, without observing its provisional lease", async () => {
    const s = setup(),
      entered = gate(),
      finish = gate();
    const running = s.tx.transaction(async () => {
      await s.coordinator.tryAcquire("private");
      entered.release();
      await finish.promise;
    });
    await entered.promise;
    try {
      expect(await s.coordinator.tryAcquire("private")).toEqual({
        status: "unavailable",
        retryable: true,
      });
      expect(await s.coordinator.tryAcquire("free")).toEqual({
        status: "unavailable",
        retryable: true,
      });
      await expect(s.coordinator.tryAcquire("")).rejects.toThrow(
        "must not be empty",
      );
      await expect(
        s.coordinator.tryAcquire("free", { leaseMs: 0 }),
      ).rejects.toThrow("positive safe integer");
      const abort = new AbortController();
      abort.abort();
      await expect(
        s.coordinator.tryAcquire("free", { signal: abort.signal }),
      ).rejects.toBeInstanceOf(CoordinationAbortedError);
    } finally {
      finish.release();
      await running;
    }
    expect((await s.coordinator.tryAcquire("private")).status).toBe("held");
    const free = await s.coordinator.tryAcquire("free");
    expect(free.status === "acquired" && free.lease.fencingGeneration).toBe(1);
  });

  it("keeps cancellation and timeout on the injected clock while the transaction stays open", async () => {
    const s = setup(),
      entered = gate(),
      finish = gate();
    let work = false;
    const running = s.tx.transaction(async () => {
      entered.release();
      await finish.promise;
    });
    await entered.promise;
    try {
      const abort = new AbortController();
      const cancelled = s.coordinator.runExclusive(
        "key",
        async () => {
          work = true;
        },
        { signal: abort.signal },
      );
      const aborted = expect(cancelled).rejects.toBeInstanceOf(
        CoordinationAbortedError,
      );
      await s.clock.advance();
      expect(s.clock.pending.size).toBe(1);
      abort.abort();
      await aborted;
      const timed = s.coordinator.runExclusive(
        "key",
        async () => {
          work = true;
        },
        { waitMs: 50 },
      );
      const timedOut = expect(timed).rejects.toBeInstanceOf(
        CoordinationTimeoutError,
      );
      await s.clock.advance();
      await s.clock.advance(50);
      await timedOut;
      expect(work).toBe(false);
      expect(s.clock.pending.size).toBe(0);
      expect(s.state.leases.size).toBe(0);
    } finally {
      finish.release();
      await running;
    }
  });

  it("refuses sibling-unusable scopes immediately but preserves ended-scope errors", async () => {
    const s = setup(),
      entered = gate(),
      finish = gate(),
      detached = gate();
    let ended!: Promise<unknown>;
    await s.tx.transaction(async () => {
      const child = s.tx.transaction(async () => {
        entered.release();
        await finish.promise;
      });
      await entered.promise;
      try {
        expect(await s.coordinator.tryAcquire("key")).toEqual({
          status: "unavailable",
          retryable: true,
        });
      } finally {
        finish.release();
        await child;
      }
      ended = (async () => {
        await detached.promise;
        return s.coordinator.tryAcquire("key");
      })();
    });
    const rejected = expect(ended).rejects.toBeInstanceOf(
      TransactionScopeError,
    );
    detached.release();
    await rejected;
  });
});
