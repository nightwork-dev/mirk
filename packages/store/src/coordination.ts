// ─── @mirk/store/coordination ───────────────────────────────────────────────
// A SQLite-backed async critical-section coordinator for cooperating processes.
// SQLite transactions cover lease metadata only; caller work always runs after
// acquisition and outside any database transaction.

import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

export interface CoordinationGuard {
  readonly key: string;
  readonly ownerToken: string;
  readonly fencingGeneration: number;
  readonly signal: AbortSignal;
  assertOwned(): void;
}

export interface AsyncCoordinator {
  runExclusive<T>(
    key: string,
    work: (guard: CoordinationGuard) => Promise<T>,
    options?: CoordinationRunOptions
  ): Promise<T>;
}

export interface CoordinationRunOptions {
  waitMs?: number;
  leaseMs?: number;
  renewEveryMs?: number;
  signal?: AbortSignal;
}

export interface SqliteCoordinatorOptions {
  path: string;
  namespace?: string;
  busyTimeoutMs?: number;
  now?: () => number;
  ownerTokenFactory?: () => string;
}

export class CoordinationTimeoutError extends Error {
  readonly name = "CoordinationTimeoutError";

  constructor(
    readonly key: string,
    readonly waitMs: number,
    readonly namespace: string
  ) {
    super(
      `Timed out waiting ${waitMs}ms to acquire coordination key "${key}" in namespace "${namespace}".`
    );
  }
}

export class CoordinationAbortedError extends Error {
  readonly name = "CoordinationAbortedError";

  constructor(readonly key: string, cause?: unknown) {
    super(`Aborted while waiting for coordination key "${key}".`, { cause });
  }
}

export class CoordinationOwnershipLostError extends Error {
  readonly name = "CoordinationOwnershipLostError";

  constructor(
    readonly key: string,
    readonly ownerToken: string,
    readonly fencingGeneration: number,
    readonly namespace: string
  ) {
    super(
      `Lost ownership of coordination key "${key}" in namespace "${namespace}" for generation ${fencingGeneration}.`
    );
  }
}

interface LeaseRow {
  owner_token: string;
  fencing_generation: number;
  expires_at_ms: number;
}

const DEFAULT_NAMESPACE = "default";
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_LEASE_MS = 5_000;
const MIN_RETRY_MS = 5;
const MAX_RETRY_MS = 50;

export function createSqliteCoordinator(
  options: SqliteCoordinatorOptions
): AsyncCoordinator {
  return new SqliteCoordinator(options);
}

export class SqliteCoordinator implements AsyncCoordinator {
  readonly #db: Database.Database;
  readonly #namespace: string;
  readonly #now: () => number;
  readonly #ownerTokenFactory: () => string;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: SqliteCoordinatorOptions) {
    if (!options.path)
      throw new Error("SqliteCoordinator requires a database path.");
    if (
      options.busyTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.busyTimeoutMs) ||
        options.busyTimeoutMs < 0)
    ) {
      throw new Error(
        `busyTimeoutMs must be a non-negative safe integer; got ${options.busyTimeoutMs}.`
      );
    }
    this.#namespace = options.namespace ?? DEFAULT_NAMESPACE;
    this.#now = options.now ?? Date.now;
    this.#ownerTokenFactory = options.ownerTokenFactory ?? randomUUID;
    const busyTimeoutMs = options.busyTimeoutMs ?? 30_000;
    this.#db = new Database(options.path, { timeout: busyTimeoutMs });
    this.#db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    runWithBusyRetry(() => {
      this.#db.pragma("journal_mode = WAL");
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS _mirk_coordination_generations (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          last_generation INTEGER NOT NULL,
          PRIMARY KEY (namespace, key)
        );

        CREATE TABLE IF NOT EXISTS _mirk_coordination_leases (
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          owner_token TEXT NOT NULL,
          fencing_generation INTEGER NOT NULL,
          acquired_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (namespace, key)
        )
      `);
    }, busyTimeoutMs);
  }

  async runExclusive<T>(
    key: string,
    work: (guard: CoordinationGuard) => Promise<T>,
    options: CoordinationRunOptions = {}
  ): Promise<T> {
    assertKey(key);
    const waitMs = positiveInteger(options.waitMs ?? DEFAULT_WAIT_MS, "waitMs");
    const leaseMs = positiveInteger(
      options.leaseMs ?? DEFAULT_LEASE_MS,
      "leaseMs"
    );
    const renewEveryMs = positiveInteger(
      options.renewEveryMs ?? Math.max(1, Math.floor(leaseMs / 3)),
      "renewEveryMs"
    );
    if (renewEveryMs >= leaseMs)
      throw new Error("renewEveryMs must be less than leaseMs.");

    const deadline = this.#now() + waitMs;
    const releaseLocalQueue = await this.#enterLocalQueue(
      key,
      deadline,
      waitMs,
      options.signal
    );
    let guard: SqliteCoordinationGuard | undefined;
    let renewTimer: ReturnType<typeof setInterval> | undefined;
    let abortForwarder: (() => void) | undefined;

    try {
      const lease = await this.#acquire(
        key,
        leaseMs,
        deadline,
        waitMs,
        options.signal
      );
      guard = new SqliteCoordinationGuard({
        key,
        namespace: this.#namespace,
        ownerToken: lease.ownerToken,
        fencingGeneration: lease.fencingGeneration,
        isOwned: () =>
          this.#isOwned(key, lease.ownerToken, lease.fencingGeneration),
      });
      abortForwarder = () => {
        guard?.abort(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new CoordinationAbortedError(key, options.signal?.reason)
        );
      };
      options.signal?.addEventListener("abort", abortForwarder, { once: true });
      renewTimer = setInterval(() => {
        if (!guard || guard.signal.aborted) return;
        if (
          !this.#renew(key, guard.ownerToken, guard.fencingGeneration, leaseMs)
        ) {
          guard.abort(
            new CoordinationOwnershipLostError(
              key,
              guard.ownerToken,
              guard.fencingGeneration,
              this.#namespace
            )
          );
        }
      }, renewEveryMs);

      return await work(guard);
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      if (abortForwarder)
        options.signal?.removeEventListener("abort", abortForwarder);
      if (guard) {
        this.#release(key, guard.ownerToken, guard.fencingGeneration);
      }
      releaseLocalQueue();
    }
  }

  close(): void {
    this.#db.close();
  }

  async #enterLocalQueue(
    key: string,
    deadline: number,
    waitMs: number,
    signal: AbortSignal | undefined
  ): Promise<() => void> {
    const queueKey = `${this.#namespace}\0${key}`;
    const prior = this.#queues.get(queueKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prior.catch(() => undefined).then(() => current);
    this.#queues.set(queueKey, chained);

    try {
      await waitFor(
        prior.catch(() => undefined),
        {
          key,
          waitMs,
          namespace: this.#namespace,
          deadline,
          now: this.#now,
          signal,
        }
      );
    } catch (err) {
      release();
      if (this.#queues.get(queueKey) === chained) this.#queues.delete(queueKey);
      throw err;
    }

    return () => {
      release();
      if (this.#queues.get(queueKey) === chained) this.#queues.delete(queueKey);
    };
  }

  async #acquire(
    key: string,
    leaseMs: number,
    deadline: number,
    waitMs: number,
    signal: AbortSignal | undefined
  ): Promise<{ ownerToken: string; fencingGeneration: number }> {
    while (true) {
      if (signal?.aborted)
        throw new CoordinationAbortedError(key, signal.reason);
      const ownerToken = this.#ownerTokenFactory();
      const acquired = trySqliteBusyAsMiss(() =>
        this.#tryAcquire(key, ownerToken, leaseMs)
      );
      if (acquired)
        return { ownerToken, fencingGeneration: acquired.fencingGeneration };
      if (this.#now() >= deadline)
        throw new CoordinationTimeoutError(key, waitMs, this.#namespace);
      await sleep(
        Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, deadline - this.#now())),
        signal,
        key
      );
    }
  }

  #tryAcquire(
    key: string,
    ownerToken: string,
    leaseMs: number
  ): { fencingGeneration: number } | undefined {
    return this.#db
      .transaction(() => {
        const now = this.#now();
        const row = this.#db
          .prepare(
            `SELECT owner_token, fencing_generation, expires_at_ms
           FROM _mirk_coordination_leases
           WHERE namespace = ? AND key = ?`
          )
          .get(this.#namespace, key) as LeaseRow | undefined;

        if (!row) {
          const nextGeneration = this.#nextGeneration(key);
          this.#db
            .prepare(
              `INSERT INTO _mirk_coordination_leases
             (namespace, key, owner_token, fencing_generation, acquired_at_ms, expires_at_ms, updated_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              this.#namespace,
              key,
              ownerToken,
              nextGeneration,
              now,
              now + leaseMs,
              now
            );
          return { fencingGeneration: nextGeneration };
        }

        if (row.expires_at_ms > now) return undefined;

        const nextGeneration = this.#nextGeneration(key);
        const result = this.#db
          .prepare(
            `UPDATE _mirk_coordination_leases
           SET owner_token = ?, fencing_generation = ?, acquired_at_ms = ?, expires_at_ms = ?, updated_at_ms = ?
           WHERE namespace = ? AND key = ? AND fencing_generation = ? AND expires_at_ms <= ?`
          )
          .run(
            ownerToken,
            nextGeneration,
            now,
            now + leaseMs,
            now,
            this.#namespace,
            key,
            row.fencing_generation,
            now
          );
        return result.changes === 1
          ? { fencingGeneration: nextGeneration }
          : undefined;
      })
      .immediate();
  }

  #nextGeneration(key: string): number {
    const row = this.#db
      .prepare(
        `SELECT last_generation
         FROM _mirk_coordination_generations
         WHERE namespace = ? AND key = ?`
      )
      .get(this.#namespace, key) as { last_generation: number } | undefined;
    const nextGeneration = (row?.last_generation ?? 0) + 1;
    this.#db
      .prepare(
        `INSERT INTO _mirk_coordination_generations (namespace, key, last_generation)
         VALUES (?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET last_generation = excluded.last_generation`
      )
      .run(this.#namespace, key, nextGeneration);
    return nextGeneration;
  }

  #renew(
    key: string,
    ownerToken: string,
    fencingGeneration: number,
    leaseMs: number
  ): boolean {
    const now = this.#now();
    const result = this.#db
      .prepare(
        `UPDATE _mirk_coordination_leases
         SET expires_at_ms = ?, updated_at_ms = ?
         WHERE namespace = ? AND key = ? AND owner_token = ? AND fencing_generation = ? AND expires_at_ms > ?`
      )
      .run(
        now + leaseMs,
        now,
        this.#namespace,
        key,
        ownerToken,
        fencingGeneration,
        now
      );
    return result.changes === 1;
  }

  #release(
    key: string,
    ownerToken: string,
    fencingGeneration: number
  ): boolean {
    const result = this.#db
      .prepare(
        `DELETE FROM _mirk_coordination_leases
         WHERE namespace = ? AND key = ? AND owner_token = ? AND fencing_generation = ? AND expires_at_ms > ?`
      )
      .run(this.#namespace, key, ownerToken, fencingGeneration, this.#now());
    return result.changes === 1;
  }

  #isOwned(
    key: string,
    ownerToken: string,
    fencingGeneration: number
  ): boolean {
    const row = this.#db
      .prepare(
        `SELECT owner_token, fencing_generation, expires_at_ms
         FROM _mirk_coordination_leases
         WHERE namespace = ? AND key = ?`
      )
      .get(this.#namespace, key) as LeaseRow | undefined;
    return Boolean(
      row &&
        row.owner_token === ownerToken &&
        row.fencing_generation === fencingGeneration &&
        row.expires_at_ms > this.#now()
    );
  }
}

class SqliteCoordinationGuard implements CoordinationGuard {
  readonly key: string;
  readonly ownerToken: string;
  readonly fencingGeneration: number;
  readonly signal: AbortSignal;
  readonly #controller = new AbortController();
  readonly #namespace: string;
  readonly #isOwned: () => boolean;

  constructor(options: {
    key: string;
    namespace: string;
    ownerToken: string;
    fencingGeneration: number;
    isOwned: () => boolean;
  }) {
    this.key = options.key;
    this.#namespace = options.namespace;
    this.ownerToken = options.ownerToken;
    this.fencingGeneration = options.fencingGeneration;
    this.#isOwned = options.isOwned;
    this.signal = this.#controller.signal;
  }

  assertOwned(): void {
    if (this.signal.aborted) throw this.signal.reason;
    if (!this.#isOwned()) {
      const err = new CoordinationOwnershipLostError(
        this.key,
        this.ownerToken,
        this.fencingGeneration,
        this.#namespace
      );
      this.abort(err);
      throw err;
    }
  }

  abort(reason: Error): void {
    if (!this.#controller.signal.aborted) this.#controller.abort(reason);
  }
}

async function waitFor(
  promise: Promise<void>,
  options: {
    key: string;
    waitMs: number;
    namespace: string;
    deadline: number;
    now: () => number;
    signal?: AbortSignal;
  }
): Promise<void> {
  if (options.signal?.aborted)
    throw new CoordinationAbortedError(options.key, options.signal.reason);
  const remaining = options.deadline - options.now();
  if (remaining <= 0)
    throw new CoordinationTimeoutError(
      options.key,
      options.waitMs,
      options.namespace
    );

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new CoordinationTimeoutError(
            options.key,
            options.waitMs,
            options.namespace
          )
        )
      );
    }, remaining);
    const onAbort = () => {
      finish(() =>
        reject(
          new CoordinationAbortedError(options.key, options.signal?.reason)
        )
      );
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => finish(resolve),
      (err) => finish(() => reject(err))
    );
  });
}

function sleep(
  ms: number,
  signal: AbortSignal | undefined,
  key: string
): Promise<void> {
  if (signal?.aborted) throw new CoordinationAbortedError(key, signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new CoordinationAbortedError(key, signal?.reason));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer; got ${value}.`);
  return value;
}

function assertKey(key: string): void {
  if (key.length === 0) throw new Error("coordination key must not be empty.");
}

function trySqliteBusyAsMiss<T>(work: () => T): T | undefined {
  try {
    return work();
  } catch (err) {
    if (isSqliteBusy(err)) return undefined;
    throw err;
  }
}

function runWithBusyRetry(work: () => void, waitMs: number): void {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      work();
      return;
    } catch (err) {
      if (!isSqliteBusy(err) || Date.now() >= deadline) throw err;
      syncSleep(
        Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, deadline - Date.now()))
      );
    }
  }
}

function isSqliteBusy(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "SQLITE_BUSY"
  );
}

function syncSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
