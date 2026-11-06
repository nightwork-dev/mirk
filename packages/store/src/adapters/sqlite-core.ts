import { ensureMirkFormat } from "./sqlite-format.js";
import { SqliteVectorFacet } from "./sqlite-vector.js";
import type { SqliteVectorEngine } from "./sqlite-vector-engine.js";
import { type SqliteDb } from "./sqlite-driver.js";
import type {
  AsyncStore,
  AsyncStoreInQuery,
  AsyncStoreIndexes,
  SyncStore,
  SyncStoreInQuery,
  SyncStoreIndexes,
} from "../types.js";
import { toAsync } from "../to-async.js";
import { AsyncTransactionCoordinator } from "../transaction.js";
import type { AfterCommitNotify } from "../transaction-types.js";
import type {
  AsyncAtomicMutationStore,
  AtomicMutationLimits,
  JsonValue,
  SyncAtomicMutationStore,
  AsyncReceiptPruning,
  SyncReceiptPruning,
} from "../atomic.js";
import {
  IN_PROCESS_ATOMIC_LIMITS,
  resolveAtomicLimits,
  resolveReceiptRetention,
} from "../atomic.js";
import type { VectorStore } from "../vector/types.js";
import { runSqliteBusyRetry } from "../sqlite-busy.js";
import type { SearchStore } from "../search/types.js";
import type { AsyncLogStore, LogStore } from "../log/types.js";
import { toAsyncLog } from "../log/to-async-log.js";
import { SqliteLogFacet } from "./sqlite-log.js";
import { existsSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SqliteKvFacet } from "./sqlite-kv.js";
import { SqliteSearchFacet } from "./sqlite-search.js";
// ─── Shared synchronous SQLite adapter core ─────────────────────────────────
// One SQLite connection, multiple capability
// facets: `.kv` is a SyncStore (KV + collections), `.vector` is a VectorStore.
//
// Why facets and not "class implements SyncStore, VectorStore": the two ports
// both declare get/remove/count with DIFFERENT shapes (kv `get(key)` vs vector
// `get(collection, id)`), so a single class can't implement both. A multi-
// capability handle exposing one facet per capability is the collision-free
// shape — and it's exactly how one source (SurrealDB: kv + vector + blob +
// graph) serves many capabilities over one connection.
//
export type SqliteAdapterErrorCode =
  | "malformed-schema"
  | "migration-required"
  | "unsupported-schema-version"
  | "invalid-busy-timeout"
  | "async-operation-active";

// Awaitable work is serialized per database file across every adapter in this
// process. A second handle that hit SQLite's lock would busy-wait
// synchronously and block the event loop the open transaction needs to finish.
// In-memory databases are private to one connection and key on the adapter.
type AsyncFileKey = string | SqliteAdapterCore;
const OUTERMOST_SAVEPOINT = "mirk_tx_outermost";
const asyncOwners = new Map<AsyncFileKey, SqliteAdapterCore>();
const asyncTails = new Map<AsyncFileKey, Promise<unknown>>();

/** The real path of the database file, so a plain path and a `file:` URI
 *  naming the same file share one queue. In-memory databases have none. */
function asyncFileKeyFor(path: string): string | undefined {
  let file = path;
  if (path.startsWith("file:")) {
    const query = path.indexOf("?");
    const params = new URLSearchParams(
      query === -1 ? "" : path.slice(query + 1),
    );
    if (params.get("mode") === "memory") return undefined;
    const location = (query === -1 ? path : path.slice(0, query)).replace(
      /#.*$/,
      "",
    );
    try {
      file = location.startsWith("file://")
        ? fileURLToPath(location)
        : decodeURIComponent(location.slice("file:".length));
    } catch {
      return undefined;
    }
  }
  if (file === "" || file === ":memory:") return undefined;
  return existsSync(file) ? realpathSync(file) : undefined;
}

/** Wait for the file's previous awaitable unit, then own the file until the
 *  returned release function runs. */
async function acquireAsyncFile(
  key: AsyncFileKey,
  owner: SqliteAdapterCore,
): Promise<() => void> {
  const previous = asyncTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => done);
  asyncTails.set(key, tail);
  await previous;
  asyncOwners.set(key, owner);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (asyncOwners.get(key) === owner) asyncOwners.delete(key);
    if (asyncTails.get(key) === tail) asyncTails.delete(key);
    release();
  };
}

/** Rejects synchronous use of a connection while awaitable work owns its file. */
class GuardedSqliteDb implements SqliteDb {
  constructor(
    private readonly inner: SqliteDb,
    private readonly check: () => void,
  ) {}
  prepare(sql: string) {
    this.check();
    return this.inner.prepare(sql);
  }
  exec(sql: string): void {
    this.check();
    this.inner.exec(sql);
  }
  pragma(sql: string): unknown {
    this.check();
    return this.inner.pragma(sql);
  }
  transaction<T, A>(work: (arg: A) => T) {
    this.check();
    return this.inner.transaction<T, A>(work);
  }
  get inTransaction(): boolean {
    return this.inner.inTransaction;
  }
  loadExtension(path: string): void {
    this.check();
    this.inner.loadExtension(path);
  }

  close(): void {
    this.check();
    this.inner.close();
  }
}

export const SQLITE_MAX_BUSY_TIMEOUT_MS = 2_147_483_647;

/** Thrown when a SQLite file or adapter option cannot be used. */
export class SqliteAdapterError extends Error {
  declare readonly name: "SqliteAdapterError";
  constructor(
    readonly code: SqliteAdapterErrorCode,
    message: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(SqliteAdapterError.prototype, "name", {
  value: "SqliteAdapterError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export function validateSqliteBusyTimeout(
  busyTimeoutMs: number | undefined,
): void {
  if (
    busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(busyTimeoutMs) ||
      busyTimeoutMs < 0 ||
      busyTimeoutMs > SQLITE_MAX_BUSY_TIMEOUT_MS)
  ) {
    throw new SqliteAdapterError(
      "invalid-busy-timeout",
      `busyTimeoutMs must be an integer from 0 to ${SQLITE_MAX_BUSY_TIMEOUT_MS}; got ${busyTimeoutMs}.`,
    );
  }
}

export interface SqliteAdapterCoreOptions {
  /** Path to the SQLite database file. Use ":memory:" for in-memory. */
  path: string;
  /** Driver-wrapped connection. */
  db: SqliteDb;
  /** Whether the adapter created the connection and should close it. */
  ownsDb: boolean;
  /** Logical vector namespace. Defaults to "default". */
  namespace?: string;
  /** Optional native vector computation on this same connection. */
  vectorEngine?: SqliteVectorEngine;
  /** Maximum time SQLite waits for another process's writer before returning SQLITE_BUSY. */
  busyTimeoutMs?: number;
  /** Override any of the in-process atomic request bounds `.kv` enforces. The
   *  batch is one local `BEGIN IMMEDIATE`, so these are sizing choices rather
   *  than a wire contract. The idempotency outcome cap is fixed regardless. */
  atomicLimits?: Partial<AtomicMutationLimits>;
  /** The prefix version tokens carry when this file is initialized. It is
   *  written once, into `_mirk_atomic_identity`; a file that already carries an
   *  identity keeps it, so reopening with a different value changes nothing.
   *  Defaults to a fresh UUID. */
  versionIdentity?: string;
  /** How long, in milliseconds, an idempotency receipt is kept. A request
   *  whose key matches only an expired receipt is applied as new. Defaults to
   *  keeping receipts forever. */
  receiptRetentionMs?: number;
  /** The clock, in milliseconds since the epoch, that stamps and expires
   *  idempotency receipts. Defaults to `Date.now`. */
  now?: () => number;
}

export type SqliteTransactionMode = "deferred" | "immediate" | "exclusive";

/** Read-only operational state for a SQLite connection.
 *
 * `path` is intentionally omitted unless callers explicitly request debug
 * paths.  The default inspection shape is safe to include in logs and run
 * receipts without disclosing a host's filesystem layout.
 */
export interface SqliteStoreInspection {
  journalMode: string;
  foreignKeys: boolean;
  busyTimeoutMs: number;
  transactionState: "none" | "read" | "write";
  pageCount: number;
  freelistCount: number;
  dataVersion: number;
  walAutocheckpointPages: number;
  walFileSizeBytes?: number;
  path?: string;
}

export interface SqliteInspectionOptions {
  /** Include the adapter path for local debug output. Defaults to false. */
  debugPaths?: boolean;
}

export type SqliteCheckpointMode = "passive" | "restart" | "truncate";

export interface SqliteCheckpointResult {
  busy: number;
  logFrames: number;
  checkpointedFrames: number;
}

/** Multi-capability sqlite source adapter. Open once; use `.kv` and/or `.vector`
 *  — both ride the same connection. */
export class SqliteAdapterCore {
  private readonly db: SqliteDb;
  private readonly rawDb: SqliteDb;
  private readonly dbPath: string;
  private readonly asyncKey: AsyncFileKey;
  private readonly asyncTransactions: AsyncTransactionCoordinator<() => void>;
  /** Depth of queued awaitable store calls currently executing. */
  private asyncCallDepth = 0;
  private syncSavepoints = 0;
  readonly kv!: SyncStore &
    SyncStoreInQuery &
    SyncStoreIndexes &
    SyncAtomicMutationStore &
    SyncReceiptPruning;
  /** The same store as `.kv`, awaitable and serialized with
   *  {@link asyncTransaction} on this database file. */
  readonly asyncKv!: AsyncStore &
    AsyncStoreInQuery &
    AsyncStoreIndexes &
    AsyncAtomicMutationStore &
    AsyncReceiptPruning;
  readonly vector!: VectorStore;
  readonly search!: SearchStore;
  readonly log!: LogStore;
  /** The same log as `.log`, awaitable and serialized with
   *  {@link asyncTransaction} on this database file. */
  readonly asyncLog!: AsyncLogStore;

  constructor(opts: SqliteAdapterCoreOptions) {
    const ownsDb = opts.ownsDb;
    validateSqliteBusyTimeout(opts.busyTimeoutMs);
    this.dbPath = opts.path;
    this.rawDb = opts.db;
    const fileKey = asyncFileKeyFor(opts.path);
    this.asyncKey = fileKey ?? this;
    if (fileKey !== undefined && asyncOwners.has(fileKey)) {
      if (ownsDb) opts.db.close();
      throw new SqliteAdapterError(
        "async-operation-active",
        "Open SQLite adapters before starting asynchronous work on the same file.",
      );
    }
    this.db = new GuardedSqliteDb(opts.db, () => this.assertSyncAccess());
    this.asyncTransactions = new AsyncTransactionCoordinator<() => void>({
      begin: async () => {
        const release = await acquireAsyncFile(this.asyncKey, this);
        try {
          this.rawDb.exec("BEGIN IMMEDIATE");
          this.rawDb.exec(`SAVEPOINT ${OUTERMOST_SAVEPOINT}`);
        } catch (error) {
          if (this.rawDb.inTransaction) this.rawDb.exec("ROLLBACK");
          release();
          throw error;
        }
        return release;
      },
      commit: () => this.rawDb.exec("COMMIT"),
      rollback: () => {
        if (!this.rawDb.inTransaction) return;
        try {
          this.rollbackKeepingVersions(OUTERMOST_SAVEPOINT);
          this.rawDb.exec("COMMIT");
        } catch (error) {
          if (this.rawDb.inTransaction) this.rawDb.exec("ROLLBACK");
          throw error;
        }
      },
      savepoint: (_release, name) => this.rawDb.exec(`SAVEPOINT ${name}`),
      releaseSavepoint: (_release, name) =>
        this.rawDb.exec(`RELEASE SAVEPOINT ${name}`),
      rollbackToSavepoint: (_release, name) =>
        this.rollbackKeepingVersions(name),
      end: (release) => release(),
    });
    try {
      const busyTimeoutMs = opts.busyTimeoutMs ?? 30_000;
      this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      // Opening two adapters concurrently can contend on the WAL mode pragma
      // and bootstrap DDL. Keep startup within the caller's bounded timeout,
      // just as individual atomic writes are kept bounded below.
      let kv: SqliteKvFacet | undefined;
      let vector: SqliteVectorFacet | undefined;
      let search: SqliteSearchFacet | undefined;
      let log: SqliteLogFacet | undefined;
      runSqliteBusyRetry(
        () => {
          ensureMirkFormat(
            this.db,
            (code, message) => new SqliteAdapterError(code, message),
          );
          this.db.pragma("journal_mode = WAL");
          kv = new SqliteKvFacet(
            this.db,
            resolveAtomicLimits(opts.atomicLimits, IN_PROCESS_ATOMIC_LIMITS),
            opts.versionIdentity,
            resolveReceiptRetention(opts.receiptRetentionMs),
            opts.now ?? Date.now,
          );
          vector = new SqliteVectorFacet(
            this.db,
            opts.namespace,
            opts.vectorEngine,
          );
          search = new SqliteSearchFacet(this.db);
          log = new SqliteLogFacet(this.db);
        },
        busyTimeoutMs,
        1,
        50,
      );
      this.kv = kv!;
      this.vector = vector!;
      this.search = search!;
      this.log = log!;
      this.asyncKv = this.serializedAsyncStore(toAsync(kv!), kv!);
      this.asyncLog = this.serializedAsyncLog(toAsyncLog(log!));
    } catch (err) {
      // A facet constructor can throw. Don't leak the
      // connection we opened — but never close a db handle the caller passed in.
      if (ownsDb) {
        try {
          this.db.close();
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  }

  /** Run synchronous work atomically on this adapter's connection.
   *
   * The callback may use any adapter facet. It must not perform asynchronous or
   * external work: better-sqlite3 transactions are synchronous and hold the
   * database transaction open until the callback returns.
   */
  transaction<T>(work: () => T, mode: SqliteTransactionMode = "deferred"): T {
    // The work runs in a savepoint so a failure can be undone while the
    // transaction, and its write lock, still hold: the sequence is moved past
    // any token the work minted before anyone else can mint again.
    let failure: { error: unknown } | undefined;
    const name = `mirk_work_${++this.syncSavepoints}`;
    const value = this.db
      .transaction((): T | undefined => {
        this.rawDb.exec(`SAVEPOINT ${name}`);
        try {
          const result = work();
          if (
            result !== null &&
            (typeof result === "object" || typeof result === "function") &&
            typeof (result as { then?: unknown }).then === "function"
          ) {
            throw new TypeError("Transaction function cannot return a promise");
          }
          this.rawDb.exec(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (error) {
          failure = { error };
          this.rollbackKeepingVersions(name);
          this.rawDb.exec(`RELEASE SAVEPOINT ${name}`);
          return undefined;
        }
      })
      [mode]();
    if (failure) throw failure.error;
    return value as T;
  }

  /** Roll back to `savepoint` inside the open transaction, then move the
   *  version sequence past every token minted since, before the write lock is
   *  released, so a token a caller may hold is never issued again. */
  private rollbackKeepingVersions(savepoint: string): void {
    const minted = this.mintedVersions();
    this.rawDb.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    this.keepVersionsMinted(minted);
  }

  /** The last version number minted on this connection, including by the
   *  open transaction. */
  private mintedVersions(): number {
    return (
      this.rawDb
        .prepare("SELECT value FROM _mirk_atomic_sequence WHERE id = 1")
        .get() as { value: number }
    ).value;
  }

  /** A rollback rewinds the version sequence, but a caller may already hold a
   *  token minted inside the rolled-back work. Move the sequence past it so no
   *  later write can reissue that token. */
  private keepVersionsMinted(minted: number): void {
    if (minted <= this.mintedVersions()) return;
    this.rawDb
      .prepare(
        "UPDATE _mirk_atomic_sequence SET value = max(value, ?) WHERE id = 1",
      )
      .run(minted);
  }

  /** Run short, database-only async work in one `BEGIN IMMEDIATE`
   *  transaction. It implements `AsyncStoreTransactions.transaction`: `asyncKv`
   *  and the synchronous facets called inside `work` join it, a nested call is
   *  a savepoint, and every other awaitable call on this file waits for it. */
  asyncTransaction<T>(work: () => T | Promise<T>): Promise<T> {
    return this.asyncTransactions.transaction(work);
  }

  /** `AsyncStoreTransactions.afterCommit` for {@link asyncTransaction}. */
  afterCommit(notify: AfterCommitNotify): void {
    this.asyncTransactions.afterCommit(notify);
  }

  private assertSyncAccess(): void {
    const owner = asyncOwners.get(this.asyncKey);
    if (owner === undefined) return;
    if (
      owner === this &&
      (this.asyncCallDepth > 0 || this.asyncTransactions.inUsableScope())
    )
      return;
    throw new SqliteAdapterError(
      "async-operation-active",
      "Use asyncKv or asyncTransaction while an asynchronous SQLite operation owns this database.",
    );
  }

  private runSerialized<T>(op: () => Promise<T>): Promise<T> {
    return this.asyncTransactions.withConnection(async (release) => {
      if (release !== undefined) return op();
      const releaseFile = await acquireAsyncFile(this.asyncKey, this);
      this.asyncCallDepth += 1;
      try {
        return await op();
      } finally {
        this.asyncCallDepth -= 1;
        releaseFile();
      }
    });
  }

  private serializedAsyncStore(
    lifted: AsyncStore &
      AsyncStoreInQuery &
      AsyncStoreIndexes &
      AsyncAtomicMutationStore,
    pruning: SyncReceiptPruning,
  ): AsyncStore &
    AsyncStoreInQuery &
    AsyncStoreIndexes &
    AsyncAtomicMutationStore &
    AsyncReceiptPruning {
    const run = <T>(op: () => Promise<T>): Promise<T> => this.runSerialized(op);
    return {
      get meta() {
        return lifted.meta;
      },
      atomicLimits: lifted.atomicLimits,
      receiptRetentionMs: pruning.receiptRetentionMs,
      pruneExpiredReceipts: () =>
        run(async () => pruning.pruneExpiredReceipts()),
      get: (key) => run(() => lifted.get(key)),
      set: (key, value) => run(() => lifted.set(key, value)),
      has: (key) => run(() => lifted.has(key)),
      delete: (key) => run(() => lifted.delete(key)),
      keys: (prefix) => run(() => lifted.keys(prefix)),
      list: (collection, filter) => run(() => lifted.list(collection, filter)),
      listWhereIn: (collection, field, values, filter) =>
        run(() => lifted.listWhereIn(collection, field, values, filter)),
      ensureIndex: (collection, field) =>
        run(() => lifted.ensureIndex(collection, field)),
      getById: (collection, id) => run(() => lifted.getById(collection, id)),
      put: (collection, item) => run(() => lifted.put(collection, item)),
      remove: (collection, id) => run(() => lifted.remove(collection, id)),
      count: (collection, filter) =>
        run(() => lifted.count(collection, filter)),
      getVersioned: (target) => run(() => lifted.getVersioned(target)),
      mutateAtomically: (request) =>
        run(() => lifted.mutateAtomically(request)),
    };
  }

  private serializedAsyncLog(lifted: AsyncLogStore): AsyncLogStore {
    const run = <T>(op: () => Promise<T>): Promise<T> => this.runSerialized(op);
    return {
      append: ((stream: string, record: JsonValue) =>
        run(() => lifted.append(stream, record))) as AsyncLogStore["append"],
      get: (stream, sequence) => run(() => lifted.get(stream, sequence)),
      list: (stream, options) => run(() => lifted.list(stream, options)),
      lastSequence: (stream) => run(() => lifted.lastSequence(stream)),
      deleteStream: (stream) => run(() => lifted.deleteStream(stream)),
    };
  }

  /**
   * Read SQLite configuration and file metadata without performing maintenance.
   *
   * This method deliberately does not call `wal_checkpoint` (or any equivalent
   * pragma).  In particular, observing WAL size must not truncate or advance the
   * checkpoint.  Filesystem metadata is best-effort because in-memory and URI
   * databases do not have a WAL sidecar.
   */
  inspect(options: SqliteInspectionOptions = {}): SqliteStoreInspection {
    const pragma = (name: string): Record<string, unknown> | undefined => {
      try {
        const result = this.db.pragma(name) as unknown;
        if (Array.isArray(result))
          return (result[0] ?? undefined) as
            | Record<string, unknown>
            | undefined;
        return result as Record<string, unknown> | undefined;
      } catch {
        // SQLite versions can omit transaction_state. Inspection remains useful
        // with the portable subset of pragmas available on that runtime.
        return undefined;
      }
    };
    const numberValue = (
      row: Record<string, unknown> | undefined,
      key: string,
      fallback = 0,
    ): number => {
      const value = row?.[key];
      return typeof value === "number" && Number.isFinite(value)
        ? value
        : fallback;
    };
    const journalMode = pragma("journal_mode")?.journal_mode;
    const transaction = pragma("transaction_state")?.transaction_state;
    const state =
      transaction === "read" ||
      transaction === "write" ||
      transaction === "none"
        ? transaction
        : this.db.inTransaction
          ? "write"
          : "none";
    const result: SqliteStoreInspection = {
      journalMode: typeof journalMode === "string" ? journalMode : "unknown",
      foreignKeys: numberValue(pragma("foreign_keys"), "foreign_keys") !== 0,
      busyTimeoutMs: numberValue(pragma("busy_timeout"), "timeout"),
      transactionState: state,
      pageCount: numberValue(pragma("page_count"), "page_count"),
      freelistCount: numberValue(pragma("freelist_count"), "freelist_count"),
      dataVersion: numberValue(pragma("data_version"), "data_version"),
      walAutocheckpointPages: numberValue(
        pragma("wal_autocheckpoint"),
        "wal_autocheckpoint",
      ),
    };
    if (
      this.dbPath !== ":memory:" &&
      !this.dbPath.startsWith("file::memory:")
    ) {
      try {
        result.walFileSizeBytes = statSync(`${this.dbPath}-wal`).size;
      } catch {
        // A checkpoint may have removed the sidecar, or this may be a URI/unnamed
        // database. Absence is represented by omission rather than an invented 0.
      }
    }
    if (options.debugPaths) result.path = this.dbPath;
    return result;
  }

  /** Run an explicitly requested SQLite WAL checkpoint operation. */
  checkpoint(mode: SqliteCheckpointMode = "passive"): SqliteCheckpointResult {
    if (mode !== "passive" && mode !== "restart" && mode !== "truncate") {
      throw new Error(`Unsupported SQLite checkpoint mode: ${String(mode)}.`);
    }
    const pragmaMode = mode.toUpperCase();
    const row = this.db.pragma(`wal_checkpoint(${pragmaMode})`) as unknown;
    const value = Array.isArray(row) ? row[0] : row;
    const record = (value ?? {}) as Record<string, unknown>;
    const integer = (name: string, index: number): number => {
      const direct = record[name];
      if (typeof direct === "number" && Number.isFinite(direct)) return direct;
      if (Array.isArray(value)) {
        const positional = value[index];
        if (typeof positional === "number" && Number.isFinite(positional))
          return positional;
      }
      return 0;
    };
    return {
      busy: integer("busy", 0),
      logFrames: integer("log", 1),
      checkpointedFrames: integer("checkpointed", 2),
    };
  }

  /** Close the underlying connection (shared by both facets). */
  close(): void {
    this.db.close();
  }
}

// ─── KV facet (SyncStore) ────────────────────────────────────────────────────
