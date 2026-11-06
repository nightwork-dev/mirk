import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CoordinationAbortedError,
  CoordinationOwnershipLostError,
  CoordinationTimeoutError,
  type CoordinationAbortSignal,
  type CoordinationClock,
  type CoordinationLease,
} from "./core.js";
import {
  createMemoryCoordinator,
  createMemoryCoordinationState,
} from "./memory.js";
import { SqliteCoordinator } from "./sqlite.js";

class ManualClock implements CoordinationClock {
  time = 1000;
  pending = new Set<{ at: number; finish: () => void }>();
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
  async advance(ms: number): Promise<void> {
    this.time += ms;
    for (const task of [...this.pending])
      if (task.at <= this.time) task.finish();
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
}

for (const kind of ["memory", "sqlite"] as const)
  describe(`${kind} shared lease state machine`, () => {
    function setup() {
      const clock = new ManualClock();
      const root = mkdtempSync(join(tmpdir(), "mirk-clock-"));
      const path = join(root, "leases.db");
      const state = createMemoryCoordinationState();
      const make = () =>
        kind === "memory"
          ? createMemoryCoordinator({ state, clock })
          : new SqliteCoordinator({ path, clock });
      const a = make(),
        b = make();
      return {
        clock,
        a,
        b,
        path,
        close() {
          if (a instanceof SqliteCoordinator) a.close();
          if (b instanceof SqliteCoordinator) b.close();
          rmSync(root, { recursive: true, force: true });
        },
      };
    }
    it("has immediate held, boundary takeover, stale fencing and persistent generations", async () => {
      const s = setup();
      try {
        const r = await s.a.tryAcquire("key", { leaseMs: 100 });
        expect(r.status).toBe("acquired");
        if (r.status !== "acquired") throw new Error();
        expect(s.clock.pending.size).toBe(0);
        expect(await s.b.tryAcquire("key")).toEqual({
          status: "held",
          expiresAt: 1100,
        });
        await s.clock.advance(99);
        r.lease.assertOwned();
        await s.clock.advance(1);
        const next = await s.b.tryAcquire("key", { leaseMs: 100 });
        if (next.status !== "acquired") throw new Error();
        expect(next.lease.fencingGeneration).toBe(2);
        expect(await r.lease.renew(100)).toBe(false);
        expect(await r.lease.release()).toBe(false);
        next.lease.assertOwned();
        expect(await next.lease.release()).toBe(true);
        expect(await next.lease.release()).toBe(false);
        const third = await s.a.tryAcquire("key");
        if (third.status !== "acquired") throw new Error();
        expect(third.lease.fencingGeneration).toBe(3);
        await third.lease.release();
      } finally {
        s.close();
      }
    });
    it("allows zero-wait immediate work but never attempts at a positive deadline", async () => {
      const s = setup();
      try {
        await s.a.runExclusive("free", async () => {}, { waitMs: 0 });
        const held = await s.a.tryAcquire("key", { leaseMs: 100 });
        if (held.status !== "acquired") throw new Error();
        const waiting = s.b.runExclusive(
          "key",
          async () => {
            throw new Error("must not enter");
          },
          { waitMs: 100 },
        );
        const rejected = expect(waiting).rejects.toBeInstanceOf(
          CoordinationTimeoutError,
        );
        await s.clock.advance(100);
        await rejected;
        expect(s.clock.pending.size).toBe(0);
        expect((await s.b.tryAcquire("key")).status).toBe("acquired");
      } finally {
        s.close();
      }
    });
    it("leaves frozen waits pending and cancellation wakes without advancing", async () => {
      const s = setup();
      try {
        await s.a.tryAcquire("key");
        const abort = new AbortController();
        let entered = false;
        const waiting = s.b.runExclusive(
          "key",
          async () => {
            entered = true;
          },
          { signal: abort.signal },
        );
        const rejected = expect(waiting).rejects.toBeInstanceOf(
          CoordinationAbortedError,
        );
        await s.clock.advance(0);
        expect(s.clock.pending.size).toBe(1);
        abort.abort();
        await rejected;
        expect(entered).toBe(false);
        expect(s.clock.pending.size).toBe(0);
      } finally {
        s.close();
      }
    });
    it("renews before expiry and fences a missed renewal on the same handle", async () => {
      const s = setup();
      try {
        let guard!: CoordinationLease;
        let finish!: () => void;
        const running = s.a.runExclusive(
          "key",
          async (g) => {
            guard = g as CoordinationLease;
            await new Promise<void>((r) => {
              finish = r;
            });
          },
          { leaseMs: 100, renewEveryMs: 30 },
        );
        await s.clock.advance(0);
        await s.clock.advance(30);
        expect(guard.expiresAt).toBe(1130);
        await s.clock.advance(100);
        expect(guard.signal.aborted).toBe(true);
        expect(() => guard.assertOwned()).toThrow(
          CoordinationOwnershipLostError,
        );
        await s.a.runExclusive(
          "key",
          async (g) => {
            expect(g.fencingGeneration).toBe(2);
          },
          { waitMs: 0 },
        );
        finish();
        await running;
        expect(s.clock.pending.size).toBe(0);
      } finally {
        s.close();
      }
    });
    if (kind === "sqlite")
      it("retries busy renewal and release on the lease clock, bounded by expiry", async () => {
        const s = setup();
        const lock = new Database(s.path);
        try {
          const result = await s.a.tryAcquire("key", { leaseMs: 100 });
          if (result.status !== "acquired") throw new Error();
          lock.exec("BEGIN IMMEDIATE");
          const renewing = result.lease.renew(100);
          await s.clock.advance(0);
          expect(s.clock.pending.size).toBe(1);
          lock.exec("ROLLBACK");
          await s.clock.advance(5);
          expect(await renewing).toBe(true);
          expect(result.lease.expiresAt).toBe(1105);
          lock.exec("BEGIN IMMEDIATE");
          const releasing = result.lease.release();
          await s.clock.advance(100);
          expect(await releasing).toBe(false);
          lock.exec("ROLLBACK");
          expect((await s.b.tryAcquire("key")).status).toBe("acquired");
          expect(s.clock.pending.size).toBe(0);
        } finally {
          lock.close();
          s.close();
        }
      });
    if (kind === "sqlite")
      it("reports a native writer lock as unavailable, separately from held", async () => {
        const s = setup();
        const lock = new Database(s.path);
        try {
          lock.exec("BEGIN IMMEDIATE");
          expect(await s.a.tryAcquire("key")).toEqual({
            status: "unavailable",
            retryable: true,
          });
          lock.exec("ROLLBACK");
          expect((await s.a.tryAcquire("key")).status).toBe("acquired");
          expect((await s.b.tryAcquire("key")).status).toBe("held");
        } finally {
          lock.close();
          s.close();
        }
      });
  });
