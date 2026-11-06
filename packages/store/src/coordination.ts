/** The minimal signal surface used by the coordinator. */
export interface CoordinationAbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(
    type: "abort",
    listener: (...args: any[]) => unknown,
    options?: { once?: boolean },
  ): void;
  removeEventListener(
    type: "abort",
    listener: (...args: any[]) => unknown,
  ): void;
}

export interface CoordinationGuard {
  readonly key: string;
  readonly ownerToken: string;
  readonly fencingGeneration: number;
  readonly signal: CoordinationAbortSignal;
  assertOwned(): void;
}

export interface AsyncCoordinator {
  tryAcquire(
    key: string,
    options?: CoordinationAcquireOptions,
  ): Promise<CoordinationAcquireResult>;
  runExclusive<T>(
    key: string,
    work: (guard: CoordinationGuard) => Promise<T>,
    options?: CoordinationRunOptions,
  ): Promise<T>;
}

export interface CoordinationAcquireOptions {
  leaseMs?: number;
  signal?: CoordinationAbortSignal;
}

export interface CoordinationRunOptions extends CoordinationAcquireOptions {
  waitMs?: number;
  leaseMs?: number;
  renewEveryMs?: number;
  signal?: CoordinationAbortSignal;
}

export interface CoordinationClock {
  now(): number;
  sleep(ms: number, signal?: CoordinationAbortSignal): Promise<void>;
}

export interface CoordinationOptions {
  namespace?: string;
  clock?: CoordinationClock;
  ownerTokenFactory?: () => string;
}

export interface CoordinationLease extends CoordinationGuard {
  readonly expiresAt: number;
  renew(leaseMs: number): Promise<boolean>;
  release(): Promise<boolean>;
}

export type CoordinationAcquireResult =
  | { status: "acquired"; lease: CoordinationLease }
  | { status: "held"; expiresAt: number }
  | { status: "unavailable"; retryable: true };

export class CoordinationTimeoutError extends Error {
  declare readonly name: "CoordinationTimeoutError";

  constructor(
    readonly key: string,
    readonly waitMs: number,
    readonly namespace: string,
  ) {
    super(
      `Timed out waiting ${waitMs}ms to acquire coordination key "${key}" in namespace "${namespace}".`,
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(CoordinationTimeoutError.prototype, "name", {
  value: "CoordinationTimeoutError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export class CoordinationAbortedError extends Error {
  declare readonly name: "CoordinationAbortedError";

  constructor(
    readonly key: string,
    cause?: unknown,
  ) {
    super(`Aborted while waiting for coordination key "${key}".`, { cause });
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(CoordinationAbortedError.prototype, "name", {
  value: "CoordinationAbortedError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export class CoordinationOwnershipLostError extends Error {
  declare readonly name: "CoordinationOwnershipLostError";

  constructor(
    readonly key: string,
    readonly ownerToken: string,
    readonly fencingGeneration: number,
    readonly namespace: string,
  ) {
    super(
      `Lost ownership of coordination key "${key}" in namespace "${namespace}" for generation ${fencingGeneration}.`,
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(CoordinationOwnershipLostError.prototype, "name", {
  value: "CoordinationOwnershipLostError",
  writable: true,
  configurable: true,
  enumerable: false,
});
