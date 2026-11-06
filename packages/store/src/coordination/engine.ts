import {
  CoordinationAbortedError,
  CoordinationOwnershipLostError,
  CoordinationTimeoutError,
  type AsyncCoordinator,
  type CoordinationAbortSignal,
  type CoordinationAcquireOptions,
  type CoordinationAcquireResult,
  type CoordinationClock,
  type CoordinationGuard,
  type CoordinationLease,
  type CoordinationOptions,
  type CoordinationRunOptions,
} from "../coordination.js";

export interface LeaseIdentity {
  key: string;
  ownerToken: string;
  fencingGeneration: number;
  expiresAt: number;
}
export interface LeaseBackend {
  acquire(
    key: string,
    token: string,
    leaseMs: number,
  ):
    | { status: "acquired"; fencingGeneration: number; expiresAt: number }
    | { status: "held"; expiresAt: number }
    | { status: "unavailable"; retryable: true };
  renew(
    lease: LeaseIdentity,
    leaseMs: number,
  ): number | undefined | "unavailable";
  release(lease: LeaseIdentity): boolean | "unavailable";
  isOwned(lease: LeaseIdentity): boolean;
}

export const systemClock: CoordinationClock = {
  now: Date.now,
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  },
};

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer; got ${value}.`);
  return value;
}

export class LeaseCoordinator implements AsyncCoordinator {
  readonly clock: CoordinationClock;
  readonly namespace: string;
  readonly #token: () => string;
  constructor(
    readonly backend: LeaseBackend,
    options: CoordinationOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.namespace = options.namespace ?? "default";
    this.#token =
      options.ownerTokenFactory ?? (() => globalThis.crypto.randomUUID());
  }

  async tryAcquire(
    key: string,
    options: CoordinationAcquireOptions = {},
  ): Promise<CoordinationAcquireResult> {
    if (typeof key !== "string" || !key)
      throw new Error("coordination key must not be empty.");
    const leaseMs = positiveInteger(options.leaseMs ?? 5000, "leaseMs");
    this.#checkAbort(key, options.signal);
    const ownerToken = this.#token();
    const result = this.backend.acquire(key, ownerToken, leaseMs);
    if (result.status !== "acquired") return result;
    const lease = new ManagedLease(this.backend, this.namespace, this.clock, {
      key,
      ownerToken,
      fencingGeneration: result.fencingGeneration,
      expiresAt: result.expiresAt,
    });
    if (options.signal?.aborted) {
      await lease.release();
      this.#checkAbort(key, options.signal);
    }
    return { status: "acquired", lease };
  }

  async runExclusive<T>(
    key: string,
    work: (guard: CoordinationGuard) => Promise<T>,
    options: CoordinationRunOptions = {},
  ): Promise<T> {
    const waitMs = options.waitMs ?? 30_000;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0)
      throw new Error("waitMs must be a non-negative safe integer.");
    const leaseMs = positiveInteger(options.leaseMs ?? 5000, "leaseMs");
    const renewEveryMs = positiveInteger(
      options.renewEveryMs ?? Math.max(1, Math.floor(leaseMs / 3)),
      "renewEveryMs",
    );
    if (renewEveryMs >= leaseMs)
      throw new Error("renewEveryMs must be less than leaseMs.");
    const deadline = this.clock.now() + waitMs;
    let first = true;
    let lease: ManagedLease;
    while (true) {
      this.#checkAbort(key, options.signal);
      if ((!first || waitMs > 0) && this.clock.now() >= deadline)
        throw new CoordinationTimeoutError(key, waitMs, this.namespace);
      first = false;
      const result = await this.tryAcquire(key, options);
      if (result.status === "acquired") {
        lease = result.lease as ManagedLease;
        break;
      }
      if (waitMs === 0 || this.clock.now() >= deadline)
        throw new CoordinationTimeoutError(key, waitMs, this.namespace);
      await this.#sleep(
        key,
        Math.min(50, Math.max(0, deadline - this.clock.now())),
        options.signal,
      );
    }
    const timerAbort = new AbortController();
    const forwardAbort = () =>
      lease.abort(new CoordinationAbortedError(key, options.signal?.reason));
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();
    const renewal = (async () => {
      try {
        while (!timerAbort.signal.aborted && !lease.signal.aborted) {
          await this.clock.sleep(renewEveryMs, timerAbort.signal);
          if (timerAbort.signal.aborted || lease.signal.aborted) break;
          if (!(await lease.renew(leaseMs, timerAbort.signal))) break;
        }
      } catch (error) {
        if (!timerAbort.signal.aborted) lease.abort(error);
      }
    })();
    try {
      lease.assertOwned();
      return await work(lease);
    } finally {
      timerAbort.abort();
      options.signal?.removeEventListener("abort", forwardAbort);
      await renewal;
      await lease.release();
    }
  }

  #checkAbort(key: string, signal?: CoordinationAbortSignal): void {
    if (signal?.aborted) throw new CoordinationAbortedError(key, signal.reason);
  }
  async #sleep(
    key: string,
    ms: number,
    signal?: CoordinationAbortSignal,
  ): Promise<void> {
    try {
      await this.clock.sleep(ms, signal);
    } catch (error) {
      this.#checkAbort(key, signal);
      throw error;
    }
    this.#checkAbort(key, signal);
  }
}

class ManagedLease implements CoordinationLease {
  readonly #controller = new AbortController();
  readonly signal = this.#controller.signal;
  readonly key: string;
  readonly ownerToken: string;
  readonly fencingGeneration: number;
  expiresAt: number;
  constructor(
    readonly backend: LeaseBackend,
    readonly namespace: string,
    readonly clock: CoordinationClock,
    identity: LeaseIdentity,
  ) {
    this.key = identity.key;
    this.ownerToken = identity.ownerToken;
    this.fencingGeneration = identity.fencingGeneration;
    this.expiresAt = identity.expiresAt;
  }
  assertOwned(): void {
    if (this.signal.aborted) throw this.signal.reason;
    if (!this.backend.isOwned(this)) {
      this.#lost();
      throw this.signal.reason;
    }
  }
  async renew(
    leaseMs: number,
    signal: CoordinationAbortSignal = this.signal,
  ): Promise<boolean> {
    positiveInteger(leaseMs, "leaseMs");
    if (this.signal.aborted) return false;
    while (
      this.clock.now() < this.expiresAt &&
      !this.signal.aborted &&
      !signal.aborted
    ) {
      const expiry = this.backend.renew(this, leaseMs);
      if (expiry === "unavailable") {
        try {
          await this.clock.sleep(
            Math.max(0, Math.min(5, this.expiresAt - this.clock.now())),
            signal,
          );
        } catch (error) {
          if (signal.aborted) return false;
          throw error;
        }
        continue;
      }
      if (expiry === undefined) {
        this.#lost();
        return false;
      }
      this.expiresAt = expiry;
      return true;
    }
    if (!signal.aborted) this.#lost();
    return false;
  }
  async release(): Promise<boolean> {
    while (this.clock.now() < this.expiresAt) {
      const released = this.backend.release(this);
      if (released === "unavailable") {
        await this.clock.sleep(
          Math.max(0, Math.min(5, this.expiresAt - this.clock.now())),
        );
        continue;
      }
      this.#lost();
      return released;
    }
    this.#lost();
    return false;
  }
  abort(reason: unknown): void {
    if (!this.signal.aborted) this.#controller.abort(reason);
  }
  #lost(): void {
    this.abort(
      new CoordinationOwnershipLostError(
        this.key,
        this.ownerToken,
        this.fencingGeneration,
        this.namespace,
      ),
    );
  }
}
