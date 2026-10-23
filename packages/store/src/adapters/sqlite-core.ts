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
// Drivers are the only runtime-specific references. Vector search is exact
// float64 JS cosine, and only that:
// `meta.accelerated` is always false here. A sqlite-vec (vec0) branch used to
// sit alongside it and never once executed; it is deleted.
// Legacy `vectors_vec_*` shadow tables in older files are left in place; they are
// inert.

import {
  type SqliteDb,
} from "./sqlite-driver.js";

import type {
  AsyncStore,
  AsyncStoreInQuery,
  SyncStore,
  SyncStoreInQuery,
  StoreMeta,
  StoreFilter,
} from "../types.js";
import { toAsync } from "../to-async.js";
import { AsyncTransactionCoordinator } from "../transaction.js";
import type { AfterCommitNotify } from "../transaction-types.js";
import type {
  AsyncAtomicMutationStore,
  AtomicMutationLimits,
  AtomicMutationRequest,
  AtomicMutationResult,
  StoreCondition,
  StoreTarget,
  StoreVersion,
  SyncAtomicMutationStore,
  AsyncReceiptPruning,
  SyncReceiptPruning,
  VersionedStoreValue,
} from "../atomic.js";
import {
  AtomicMutationBackendError,
  cloneJson,
  IN_PROCESS_ATOMIC_LIMITS,
  isReceiptExpired,
  RECEIPT_PRUNE_BATCH,
  resolveAtomicLimits,
  resolveReceiptRetention,
  validateAtomicRequest,
} from "../atomic.js";
import type {
  VectorStore,
  VectorStoreMeta,
  VectorDocument,
  VectorSearchResult,
  VectorSearchOptions,
  Vector,
} from "../vector/types.js";
import { matchesWhere } from "../vector/filter.js";
import { compareCodePoints } from "../order.js";
import { isSqliteBusyOrLocked, runSqliteBusyRetry } from "../sqlite-busy.js";
import {
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
  assertDimensions,
  isUsableVector,
  VectorInputError,
} from "../vector/cosine.js";
import type {
  SearchStore,
  SearchDocument,
  SearchResult,
  SearchOptions,
} from "../search/types.js";
import { sanitizeFtsQuery } from "../search/tokenize.js";
import {
  DEFAULT_SEARCH_FIELD,
  assertSameSearchFields,
  assertValidFieldWeightValues,
  fieldWeightsFor,
  normalizeSearchDocument,
  type NormalizedSearchFields,
} from "../search/fields.js";
import {
  buildWhereClause,
  buildOrderBy,
  buildLimitOffset,
  hashName,
  jsonPath,
  type SqlParam,
  COLLECTION_TABLE_KIND,
  COLLECTION_TABLE_PREFIX,
  ftsTableFor,
  INSERT_REGISTERED_TABLE_SQL,
  INSERT_SCHEMA_VERSION_SQL,
  isSchemaVersionTooNew,
  isTableRegistryConflict,
  MIRK_REGISTRY_DDL,
  MIRK_SCHEMA_VERSION,
  schemaVersionTooNewMessage,
  StoreFilterError,
  SEARCH_DOCS_TABLE_PREFIX,
  SEARCH_TABLE_KIND,
  SELECT_REGISTERED_TABLE_SQL,
  SELECT_SCHEMA_VERSION_SQL,
  SELECT_TABLE_CLAIM_SQL,
  SELECT_TABLE_EXISTS_SQL,
  tableResolution,
  type TableRegistryAnswer,
} from "../sql.js";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type SqliteAdapterErrorCode =
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
    const params = new URLSearchParams(query === -1 ? "" : path.slice(query + 1));
    if (params.get("mode") === "memory") return undefined;
    const location = (query === -1 ? path : path.slice(0, query)).replace(/#.*$/, "");
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
  owner: SqliteAdapterCore
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
    private readonly check: () => void
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
  close(): void {
    this.check();
    this.inner.close();
  }
}

export const SQLITE_MAX_BUSY_TIMEOUT_MS = 2_147_483_647;

/** Thrown when a SQLite file or adapter option cannot be used. */
export class SqliteAdapterError extends Error {
  declare readonly name: "SqliteAdapterError";
  constructor(readonly code: SqliteAdapterErrorCode, message: string) {
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

export function validateSqliteBusyTimeout(busyTimeoutMs: number | undefined): void {
  if (
    busyTimeoutMs !== undefined &&
    (!Number.isSafeInteger(busyTimeoutMs) ||
      busyTimeoutMs < 0 ||
      busyTimeoutMs > SQLITE_MAX_BUSY_TIMEOUT_MS)
  ) {
    throw new SqliteAdapterError(
      "invalid-busy-timeout",
      `busyTimeoutMs must be an integer from 0 to ${SQLITE_MAX_BUSY_TIMEOUT_MS}; got ${busyTimeoutMs}.`
    );
  }
}

function assertPositiveDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new VectorInputError(
      "invalid-dimensions",
      `Vector dimensions must be a positive integer; got ${dimensions}.`
    );
  }
}

/** Create `_mirk_tables` / `_mirk_meta` and pin `schema_version`. Runs once per
 *  open, BEFORE any facet, so a file written by a newer adapter is refused
 *  rather than half-read. */
function ensureMirkRegistry(db: SqliteDb): void {
  const hasMeta =
    db
      .prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = '_mirk_meta'"
      )
      .get() !== undefined;
  if (hasMeta) {
    const row = db.prepare(SELECT_SCHEMA_VERSION_SQL).get() as
      | { value: string }
      | undefined;
    if (row !== undefined && isSchemaVersionTooNew(row.value)) {
      throw new SqliteAdapterError(
        "unsupported-schema-version",
        schemaVersionTooNewMessage(row.value, MIRK_SCHEMA_VERSION)
      );
    }
  }
  db.exec(MIRK_REGISTRY_DDL);
  db.prepare(INSERT_SCHEMA_VERSION_SQL).run(String(MIRK_SCHEMA_VERSION));
}

/** Synchronous driver for the shared `tableResolution` procedure in ../sql.ts.
 *  The procedure itself lives there because @mirk/store-libsql runs the exact
 *  same steps against an async client. */
function runTableResolution(
  db: SqliteDb,
  kind: string,
  name: string,
  prefix: string,
  register: boolean
): string {
  // A concurrent opener can claim the candidate between this resolution's
  // lookup and its INSERT. Restarting reads the winner's row as a registry hit.
  for (let attempt = 1; ; attempt++) {
    try {
      return resolveTableOnce(db, kind, name, prefix, register);
    } catch (err) {
      if (attempt >= TABLE_RESOLUTION_ATTEMPTS || !isTableRegistryConflict(err)) {
        throw err;
      }
    }
  }
}

const TABLE_RESOLUTION_ATTEMPTS = 5;

function resolveTableOnce(
  db: SqliteDb,
  kind: string,
  name: string,
  prefix: string,
  register: boolean
): string {
  const resolution = tableResolution(kind, name, prefix, register);
  let step = resolution.next();
  while (!step.done) {
    const query = step.value;
    let answer: TableRegistryAnswer;
    if (query.q === "registered") {
      answer = (
        db.prepare(SELECT_REGISTERED_TABLE_SQL).get(query.kind, query.name) as
          | { table_name: string }
          | undefined
      )?.table_name;
    } else if (query.q === "claimant") {
      answer = (
        db.prepare(SELECT_TABLE_CLAIM_SQL).get(query.table) as
          | { name: string }
          | undefined
      )?.name;
    } else if (query.q === "tableExists") {
      answer = db.prepare(SELECT_TABLE_EXISTS_SQL).get(query.table) !== undefined;
    } else {
      db.prepare(INSERT_REGISTERED_TABLE_SQL).run(
        query.kind,
        query.name,
        query.table
      );
    }
    step = resolution.next(answer);
  }
  return step.value;
}

const NON_SCALAR_IN_MESSAGE = "Store IN queries only support JSON scalar values.";

/** One OR-ed, json_type-guarded term per value — never a bare `IN (...)` list.
 *  json_extract collapses a JSON boolean to SQL 1/0, so an unguarded IN makes
 *  `listWhereIn(f, [true])` match a stored 1 and `[1]` match a stored true. The
 *  guards mirror `buildWhereClause` in ../sql.ts exactly, which is what keeps the
 *  in-memory reference (`Set.has`, where true !== 1) and SQLite in step. */
function buildJsonInWhere(
  field: string,
  values: readonly unknown[],
  hasPriorWhere: boolean
): { clause: string; params: SqlParam[] } {
  const path = jsonPath(field);
  const params: SqlParam[] = [];
  const parts: string[] = [];

  for (const value of values) {
    if (value === null) {
      parts.push(`json_type(data, ?) = 'null'`);
      params.push(path);
    } else if (typeof value === "boolean") {
      parts.push(`json_type(data, ?) = '${value ? "true" : "false"}'`);
      params.push(path);
    } else if (typeof value === "string") {
      parts.push(`(json_type(data, ?) = 'text' AND json_extract(data, ?) = ?)`);
      params.push(path, path, value);
    } else if (typeof value === "number" || typeof value === "bigint") {
      parts.push(
        `(json_type(data, ?) IN ('integer', 'real') AND json_extract(data, ?) = ?)`
      );
      params.push(path, path, value);
    } else {
      throw new StoreFilterError("non-scalar-in-value", NON_SCALAR_IN_MESSAGE);
    }
  }

  return {
    clause: `${hasPriorWhere ? " AND" : " WHERE"} (${parts.join(" OR ")})`,
    params,
  };
}

export interface SqliteAdapterCoreOptions {
  /** Path to the SQLite database file. Use ":memory:" for in-memory. */
  path: string;
  /** Driver-wrapped connection. */
  db: SqliteDb;
  /** Whether the adapter created the connection and should close it. */
  ownsDb: boolean;
  /** Embedding dimensions. Optional: when omitted, `.vector` persists the
   *  dimensions from the first upsert/upsertMany call. KV/search work without it. */
  dimensions?: number;
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
  readonly kv!: SyncStore & SyncAtomicMutationStore & SyncReceiptPruning;
  /** The same store as `.kv`, awaitable and serialized with
   *  {@link asyncTransaction} on this database file. */
  readonly asyncKv!: AsyncStore &
    AsyncStoreInQuery &
    AsyncAtomicMutationStore &
    AsyncReceiptPruning;
  readonly vector!: VectorStore;
  readonly search!: SearchStore;

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
        "Open SQLite adapters before starting asynchronous work on the same file."
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
      runSqliteBusyRetry(
        () => {
          this.db.pragma("journal_mode = WAL");
          ensureMirkRegistry(this.db);
          kv = new SqliteKvFacet(
            this.db,
            resolveAtomicLimits(opts.atomicLimits, IN_PROCESS_ATOMIC_LIMITS),
            opts.versionIdentity,
            resolveReceiptRetention(opts.receiptRetentionMs),
            opts.now ?? Date.now
          );
          vector = new SqliteVectorFacet(this.db, opts.path, opts.dimensions);
          search = new SqliteSearchFacet(this.db);
        },
        busyTimeoutMs,
        1,
        50
      );
      this.kv = kv!;
      this.vector = vector!;
      this.search = search!;
      this.asyncKv = this.serializedAsyncStore(toAsync(kv!), kv!);
    } catch (err) {
      // A facet constructor can throw (e.g. dimension mismatch). Don't leak the
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
    const value = this.db.transaction((): T | undefined => {
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
    })[mode]();
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
      .prepare("UPDATE _mirk_atomic_sequence SET value = max(value, ?) WHERE id = 1")
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
      "Use asyncKv or asyncTransaction while an asynchronous SQLite operation owns this database."
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
    lifted: AsyncStore & AsyncStoreInQuery & AsyncAtomicMutationStore,
    pruning: SyncReceiptPruning
  ): AsyncStore & AsyncStoreInQuery & AsyncAtomicMutationStore & AsyncReceiptPruning {
    const run = <T>(op: () => Promise<T>): Promise<T> => this.runSerialized(op);
    return {
      get meta() {
        return lifted.meta;
      },
      atomicLimits: lifted.atomicLimits,
      receiptRetentionMs: pruning.receiptRetentionMs,
      pruneExpiredReceipts: () => run(async () => pruning.pruneExpiredReceipts()),
      get: (key) => run(() => lifted.get(key)),
      set: (key, value) => run(() => lifted.set(key, value)),
      has: (key) => run(() => lifted.has(key)),
      delete: (key) => run(() => lifted.delete(key)),
      keys: (prefix) => run(() => lifted.keys(prefix)),
      list: (collection, filter) => run(() => lifted.list(collection, filter)),
      listWhereIn: (collection, field, values, filter) =>
        run(() => lifted.listWhereIn(collection, field, values, filter)),
      getById: (collection, id) => run(() => lifted.getById(collection, id)),
      put: (collection, item) => run(() => lifted.put(collection, item)),
      remove: (collection, id) => run(() => lifted.remove(collection, id)),
      count: (collection, filter) => run(() => lifted.count(collection, filter)),
      getVersioned: (target) => run(() => lifted.getVersioned(target)),
      mutateAtomically: (request) => run(() => lifted.mutateAtomically(request)),
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
      fallback = 0
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
        "wal_autocheckpoint"
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

class SqliteKvFacet
  implements SyncStore, SyncStoreInQuery, SyncAtomicMutationStore, SyncReceiptPruning
{
  readonly meta: StoreMeta = { backend: "sqlite" };
  private readonly initializedTables = new Set<string>();
  private readonly resolvedTables = new Map<string, string>();
  private readonly versionPrefix: string;

  constructor(
    private readonly db: SqliteDb,
    readonly atomicLimits: AtomicMutationLimits = IN_PROCESS_ATOMIC_LIMITS,
    versionIdentity?: string,
    readonly receiptRetentionMs: number | undefined = undefined,
    private readonly now: () => number = Date.now
  ) {
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _mirk_atomic_versions (
        kind TEXT NOT NULL,
        collection TEXT NOT NULL,
        target_key TEXT NOT NULL,
        version TEXT NOT NULL,
        PRIMARY KEY (kind, collection, target_key)
      );
      CREATE TABLE IF NOT EXISTS _mirk_atomic_sequence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO _mirk_atomic_sequence (id, value) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS _mirk_atomic_receipts (
        idempotency_key TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS _mirk_atomic_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );
    `);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO _mirk_atomic_identity (id, value) VALUES (1, ?)"
      )
      .run(versionIdentity ?? randomUUID());
    // Receipts written before receipts expired carry no creation time.
    const receiptColumns = this.db
      .prepare("PRAGMA table_info(_mirk_atomic_receipts)")
      .all() as { name: string }[];
    if (!receiptColumns.some((column) => column.name === "created_at")) {
      this.db.exec(
        "ALTER TABLE _mirk_atomic_receipts ADD COLUMN created_at INTEGER"
      );
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS _mirk_atomic_receipts_created_at ON _mirk_atomic_receipts (created_at)"
    );
    this.versionPrefix = (
      this.db
        .prepare("SELECT value FROM _mirk_atomic_identity WHERE id = 1")
        .get() as { value: string }
    ).value;
  }

  /** Physical table for a collection, via the `_mirk_tables` registry. The
   *  hash-derived name is only the first CANDIDATE: a name whose candidate is
   *  already claimed by a different collection gets `_2`, `_3`, … so two names
   *  that sanitize and hash alike never share one table. */
  private tableName(collection: string): string {
    if (collection.length === 0) throw new Error("Invalid collection name");
    const cached = this.resolvedTables.get(collection);
    if (cached !== undefined) return cached;
    const table = runTableResolution(
      this.db,
      COLLECTION_TABLE_KIND,
      collection,
      COLLECTION_TABLE_PREFIX,
      true
    );
    // Same rollback discipline as `initializedTables` below: a registry row
    // written inside a caller's transaction can be undone by an outer rollback.
    if (!this.db.inTransaction) this.resolvedTables.set(collection, table);
    return table;
  }

  private ensureTable(collection: string): string {
    const table = this.tableName(collection);
    if (this.initializedTables.has(table)) return table;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        data JSON NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`
    );
    // A caller may have wrapped this operation in SqliteAdapter.transaction().
    // Schema creation is transactional, so an outer rollback can remove the
    // table after this method returns. Do not cache a table created while a
    // transaction is active; the next access will re-issue CREATE IF NOT EXISTS
    // and repair the cache after a committed operation.
    if (!this.db.inTransaction) this.initializedTables.add(table);
    return table;
  }

  get<T>(key: string): T | null {
    const row = this.db
      .prepare("SELECT value FROM _kv WHERE key = ?")
      .get(key) as { value: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  set<T>(key: string, value: T): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO _kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
        )
        .run(key, JSON.stringify(value));
      this.writeVersion({ kind: "key", key });
    })();
  }

  has(key: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM _kv WHERE key = ?").get(key) !== undefined
    );
  }

  delete(key: string): boolean {
    return this.db.transaction(() => {
      const deleted =
        this.db.prepare("DELETE FROM _kv WHERE key = ?").run(key).changes > 0;
      if (deleted) this.clearVersion({ kind: "key", key });
      return deleted;
    })();
  }

  keys(prefix?: string): string[] {
    if (prefix) {
      // Escape LIKE wildcards so the prefix matches LITERALLY (startsWith), not as
      // a pattern — matches the in-memory reference's `key.startsWith(prefix)`.
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rows = this.db
        .prepare(
          `SELECT key FROM _kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key`
        )
        .all(`${escaped}%`) as { key: string }[];
      return rows.map((r) => r.key);
    }
    const rows = this.db.prepare("SELECT key FROM _kv ORDER BY key").all() as {
      key: string;
    }[];
    return rows.map((r) => r.key);
  }

  list<T>(collection: string, filter?: StoreFilter): T[] {
    const table = this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const orderBy = buildOrderBy(filter);
    const limitOffset = buildLimitOffset(filter);
    const sql = `SELECT data FROM ${table}${where.clause}${orderBy.clause}${limitOffset}`;
    const rows = this.db
      .prepare(sql)
      .all(...where.params, ...orderBy.params) as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  listWhereIn<T>(
    collection: string,
    field: string,
    values: readonly unknown[],
    filter?: StoreFilter
  ): T[] {
    if (values.length === 0) return [];
    const table = this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const inWhere = buildJsonInWhere(field, values, where.clause.length > 0);
    const orderBy = buildOrderBy(filter);
    const limitOffset = buildLimitOffset(filter);
    const sql = `SELECT data FROM ${table}${where.clause}${inWhere.clause}${orderBy.clause}${limitOffset}`;
    const rows = this.db
      .prepare(sql)
      .all(...where.params, ...inWhere.params, ...orderBy.params) as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  getById<T>(collection: string, id: string): T | null {
    const table = this.ensureTable(collection);
    const row = this.db
      .prepare(`SELECT data FROM ${table} WHERE id = ?`)
      .get(id) as { data: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as T;
  }

  put<T extends { id: string }>(collection: string, item: T): T {
    const table = this.ensureTable(collection);
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`
        )
        .run(item.id, JSON.stringify(item));
      this.writeVersion({ kind: "record", collection, id: item.id });
    })();
    return item;
  }

  remove(collection: string, id: string): boolean {
    const table = this.ensureTable(collection);
    return this.db.transaction(() => {
      const removed =
        this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes >
        0;
      if (removed) this.clearVersion({ kind: "record", collection, id });
      return removed;
    })();
  }

  count(collection: string, filter?: StoreFilter): number {
    const table = this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM ${table}${where.clause}`)
      .get(...where.params) as { cnt: number };
    return row.cnt;
  }

  getVersioned<T>(target: StoreTarget): VersionedStoreValue<T> | null {
    return this.readVersionedTarget<T>(target);
  }

  mutateAtomically(request: AtomicMutationRequest): AtomicMutationResult {
    const validated = validateAtomicRequest(request, this.atomicLimits);
    const transaction = this.db.transaction(() => this.decideAtomic(validated));
    try {
      return transaction.immediate();
    } catch (error) {
      if (isSqliteBusyOrLocked(error)) {
        throw new AtomicMutationBackendError(
          "unavailable",
          true,
          "SQLite is busy or locked."
        );
      }
      throw error;
    }
  }

  private decideAtomic(
    validated: ReturnType<typeof validateAtomicRequest>
  ): AtomicMutationResult {
    const idempotencyKey = validated.idempotency?.key;
    const now = idempotencyKey === undefined ? 0 : this.now();
    if (idempotencyKey !== undefined) {
      this.pruneReceiptBatch(now);
      const prior = this.readReceipt(idempotencyKey, now);
      if (prior) {
        if (prior.requestDigest !== validated.requestDigest) {
          return {
            status: "idempotency-conflict",
            key: idempotencyKey,
            expectedRequestDigest: prior.requestDigest,
            receivedRequestDigest: validated.requestDigest,
          };
        }
        const result = JSON.parse(prior.resultJson) as Extract<
          AtomicMutationResult,
          { status: "applied" | "replayed" }
        >;
        return {
          status: "replayed",
          requestDigest: result.requestDigest,
          versions: result.versions,
          ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
        };
      }
    }

    for (const condition of validated.conditions) {
      const observed = this.observe(condition.target);
      if (!conditionMatches(condition, observed)) {
        return {
          status: "conflict",
          condition: cloneCondition(condition),
          observed:
            observed === null
              ? "missing"
              : condition.expected === "version"
              ? observed.version
              : "present",
        };
      }
    }

    const versions: { target: StoreTarget; version: StoreVersion | null }[] =
      [];
    for (const operation of validated.operations) {
      const target = operationTarget(operation);
      switch (operation.op) {
        case "set": {
          this.db
            .prepare(
              `INSERT INTO _kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
            )
            .run(operation.key, JSON.stringify(operation.value));
          versions.push({ target, version: this.writeVersion(target) });
          break;
        }
        case "delete":
          this.db.prepare("DELETE FROM _kv WHERE key = ?").run(operation.key);
          this.clearVersion(target);
          versions.push({ target, version: null });
          break;
        case "put": {
          const table = this.ensureTable(operation.collection);
          this.db
            .prepare(
              `INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`
            )
            .run(operation.item.id, JSON.stringify(operation.item));
          versions.push({ target, version: this.writeVersion(target) });
          break;
        }
        case "remove": {
          const table = this.tableIfExists(operation.collection);
          if (table)
            this.db
              .prepare(`DELETE FROM ${table} WHERE id = ?`)
              .run(operation.id);
          this.clearVersion(target);
          versions.push({ target, version: null });
          break;
        }
      }
    }
    const applied: Extract<
      AtomicMutationResult,
      { status: "applied" | "replayed" }
    > & { status: "applied" } = {
      status: "applied",
      requestDigest: validated.requestDigest,
      versions,
      ...(validated.outcome === undefined
        ? {}
        : { outcome: cloneJson(validated.outcome) }),
    };
    if (idempotencyKey !== undefined)
      this.writeReceipt(idempotencyKey, validated.requestDigest, applied, now);
    return applied;
  }

  pruneExpiredReceipts(): number {
    if (this.receiptRetentionMs === undefined) return 0;
    let removed = 0;
    for (;;) {
      const batch = this.db.transaction(() => this.pruneReceiptBatch(this.now()));
      const count = batch.immediate();
      removed += count;
      if (count < RECEIPT_PRUNE_BATCH) return removed;
    }
  }

  // ─── Idempotency receipts ────────────────────────────────────────────────
  // Every receipt read and write goes through these three methods. The same
  // table and rules are shared with @mirk/store-libsql.

  /** The live receipt under `key`, or undefined when there is none or it has
   *  expired. */
  private readReceipt(
    key: string,
    now: number
  ): { requestDigest: string; resultJson: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT request_digest as requestDigest, result_json as resultJson, created_at as createdAt FROM _mirk_atomic_receipts WHERE idempotency_key = ?"
      )
      .get(key) as
      | { requestDigest: string; resultJson: string; createdAt: number | bigint | null }
      | undefined;
    if (!row) return undefined;
    const createdAt = row.createdAt === null ? null : Number(row.createdAt);
    return isReceiptExpired(createdAt, now, this.receiptRetentionMs)
      ? undefined
      : row;
  }

  /** Write a receipt, replacing an expired one under the same key. */
  private writeReceipt(
    key: string,
    requestDigest: string,
    result: AtomicMutationResult,
    now: number
  ): void {
    this.db
      .prepare(
        `INSERT INTO _mirk_atomic_receipts (idempotency_key, request_digest, result_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET request_digest = excluded.request_digest,
           result_json = excluded.result_json, created_at = excluded.created_at`
      )
      .run(key, requestDigest, JSON.stringify(result), now);
  }

  /** In the open transaction, stamp at most one batch of receipts that have no
   *  creation time with `now`, then delete at most one batch of expired
   *  receipts. Returns how many were deleted. */
  private pruneReceiptBatch(now: number): number {
    if (this.receiptRetentionMs === undefined) return 0;
    this.db
      .prepare(
        `UPDATE _mirk_atomic_receipts SET created_at = ? WHERE idempotency_key IN (
           SELECT idempotency_key FROM _mirk_atomic_receipts WHERE created_at IS NULL LIMIT ?)`
      )
      .run(now, RECEIPT_PRUNE_BATCH);
    return Number(this.db
      .prepare(
        `DELETE FROM _mirk_atomic_receipts WHERE idempotency_key IN (
           SELECT idempotency_key FROM _mirk_atomic_receipts WHERE created_at < ? ORDER BY created_at LIMIT ?)`
      )
      .run(now - this.receiptRetentionMs, RECEIPT_PRUNE_BATCH).changes);
  }

  private observe(target: StoreTarget): VersionedStoreValue<unknown> | null {
    return this.readVersionedTarget(target);
  }

  private readVersionedTarget<T>(
    target: StoreTarget
  ): VersionedStoreValue<T> | null {
    if (target.kind === "key") {
      const row = this.db
        .prepare(
          `SELECT k.value, v.version
           FROM _kv AS k
           LEFT JOIN _mirk_atomic_versions AS v
             ON v.kind = 'key' AND v.collection = '' AND v.target_key = k.key
          WHERE k.key = ?`
        )
        .get(target.key) as
        | { value: string; version?: string | null }
        | undefined;
      if (!row) return null;
      const version =
        row.version == null
          ? this.writeVersion(target)
          : (row.version as StoreVersion);
      return { value: JSON.parse(row.value) as T, version };
    }
    const table = this.tableIfExists(target.collection);
    if (!table) return null;
    const row = this.db
      .prepare(
        `SELECT c.data, v.version
         FROM ${table} AS c
         LEFT JOIN _mirk_atomic_versions AS v
           ON v.kind = 'record' AND v.collection = ? AND v.target_key = c.id
        WHERE c.id = ?`
      )
      .get(target.collection, target.id) as
      | { data: string; version?: string | null }
      | undefined;
    if (!row) return null;
    const version =
      row.version == null
        ? this.writeVersion(target)
        : (row.version as StoreVersion);
    return { value: JSON.parse(row.data) as T, version };
  }

  private tableIfExists(collection: string): string | null {
    const table = this.tableName(collection);
    if (this.initializedTables.has(table)) return table;
    const row = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    return row === undefined ? null : table;
  }

  private writeVersion(target: StoreTarget): StoreVersion {
    const parts =
      target.kind === "key"
        ? ["key", "", target.key]
        : ["record", target.collection, target.id];
    // One statement, so another process cannot mint between the increment
    // and the read when this runs outside a transaction.
    const row = this.db
      .prepare(
        "UPDATE _mirk_atomic_sequence SET value = value + 1 WHERE id = 1 RETURNING value"
      )
      .get() as { value: number };
    const version = `${this.versionPrefix}-v${row.value}` as StoreVersion;
    this.db
      .prepare(
        `INSERT INTO _mirk_atomic_versions (kind, collection, target_key, version) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, collection, target_key) DO UPDATE SET version = excluded.version`
      )
      .run(...parts, version);
    return version;
  }

  private clearVersion(target: StoreTarget): void {
    const parts =
      target.kind === "key"
        ? ["key", "", target.key]
        : ["record", target.collection, target.id];
    this.db
      .prepare(
        "DELETE FROM _mirk_atomic_versions WHERE kind = ? AND collection = ? AND target_key = ?"
      )
      .run(...parts);
  }
}

function operationTarget(operation: {
  op: string;
  key?: string;
  collection?: string;
  id?: string;
  item?: { id: string };
}): StoreTarget {
  if (operation.op === "set" || operation.op === "delete")
    return { kind: "key", key: operation.key! };
  if (operation.op === "put")
    return {
      kind: "record",
      collection: operation.collection!,
      id: operation.item!.id,
    };
  return {
    kind: "record",
    collection: operation.collection!,
    id: operation.id!,
  };
}

function cloneCondition(condition: StoreCondition): StoreCondition {
  return condition.expected === "version"
    ? {
        target: { ...condition.target },
        expected: "version",
        version: condition.version,
      }
    : { target: { ...condition.target }, expected: condition.expected };
}

function conditionMatches(
  condition: StoreCondition,
  observed: VersionedStoreValue<unknown> | null
): boolean {
  if (condition.expected === "missing") return observed === null;
  if (condition.expected === "present") return observed !== null;
  return observed !== null && observed.version === condition.version;
}

// ─── Vector facet (VectorStore) ──────────────────────────────────────────────

interface VectorRow {
  id: string;
  vec: Buffer;
  metadata: string | null;
}

class SqliteVectorFacet implements VectorStore {
  readonly meta: VectorStoreMeta = {
    backend: "sqlite",
    dimensions: 0,
    accelerated: false,
  };
  private dimensions = -1;

  constructor(
    private readonly db: SqliteDb,
    private readonly path: string,
    dimensions?: number
  ) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS vectors (
         collection TEXT NOT NULL,
         id TEXT NOT NULL,
         vec BLOB NOT NULL,
         metadata TEXT,
         PRIMARY KEY (collection, id)
       );
       CREATE INDEX IF NOT EXISTS vectors_collection ON vectors(collection);
       CREATE TABLE IF NOT EXISTS _vec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`
    );
    // Persist + enforce dimensionality so a store created at N dims can't be
    // reopened at M (which would let stale-length rows score a silent 0).
    const stored = this.db
      .prepare(`SELECT value FROM _vec_meta WHERE key = 'dimensions'`)
      .get() as { value: string } | undefined;
    if (stored) {
      this.dimensions = Number(stored.value);
      if (dimensions !== undefined && dimensions !== this.dimensions) {
        throw new VectorInputError(
          "dimensions-changed",
          `Vector store at ${path} was created with ${this.dimensions} dimensions, opened with ${dimensions}.`
        );
      }
      this.refreshVectorMeta();
    } else if (dimensions !== undefined) {
      this.initializeDims(dimensions);
    }
  }

  private initializeDims(dimensions: number): void {
    assertPositiveDimensions(dimensions);
    if (this.dimensions >= 0) {
      if (dimensions !== this.dimensions) {
        throw new VectorInputError(
          "dimensions-changed",
          `Vector store at ${this.path} was created with ${this.dimensions} dimensions, opened with ${dimensions}.`
        );
      }
      return;
    }
    this.dimensions = dimensions;
    this.db
      .prepare(
        `INSERT INTO _vec_meta (key, value) VALUES ('dimensions', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(String(dimensions));
    this.refreshVectorMeta();
  }

  private refreshVectorMeta(): void {
    this.meta.dimensions = Math.max(this.dimensions, 0);
  }

  private requireKnownDims(v: Vector): void {
    if (this.dimensions < 0) {
      throw new VectorInputError(
        "dimensions-unknown",
        "SqliteAdapter.vector has no dimensions yet — pass { dimensions } when opening or upsert a vector first."
      );
    }
    assertDimensions(v, this.dimensions);
  }

  private ensureDimsForWrite(v: Vector): void {
    if (this.dimensions < 0) this.initializeDims(v.length);
    assertDimensions(v, this.dimensions);
  }

  upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>
  ): void {
    this.ensureDimsForWrite(doc.vector);
    this.db
      .prepare(
        `INSERT INTO vectors(collection, id, vec, metadata) VALUES (?, ?, ?, ?)
         ON CONFLICT(collection, id) DO UPDATE SET vec = excluded.vec, metadata = excluded.metadata`
      )
      .run(
        collection,
        doc.id,
        vectorToBuffer(doc.vector),
        doc.metadata === undefined ? null : JSON.stringify(doc.metadata)
      );
  }

  upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>
  ): void {
    const first = docs[0];
    if (!first) return;
    const dimensions =
      this.dimensions >= 0 ? this.dimensions : first.vector.length;
    assertPositiveDimensions(dimensions);
    for (const doc of docs) {
      assertDimensions(doc.vector, dimensions);
    }
    if (this.dimensions < 0) this.initializeDims(dimensions);
    const tx = this.db.transaction(
      (items: ReadonlyArray<VectorDocument<M>>) => {
        for (const doc of items) this.upsert(collection, doc);
      }
    );
    tx(docs);
  }

  get<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string
  ): VectorDocument<M> | null {
    const row = this.db
      .prepare(
        `SELECT id, vec, metadata FROM vectors WHERE collection = ? AND id = ?`
      )
      .get(collection, id) as VectorRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      vector: bufferToVector(row.vec),
      metadata:
        row.metadata === null ? undefined : (JSON.parse(row.metadata) as M),
    };
  }

  has(collection: string, id: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM vectors WHERE collection = ? AND id = ?`)
        .get(collection, id) !== undefined
    );
  }

  remove(collection: string, id: string): boolean {
    return (
      this.db
        .prepare(`DELETE FROM vectors WHERE collection = ? AND id = ?`)
        .run(collection, id).changes > 0
    );
  }

  count(collection: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM vectors WHERE collection = ?`)
      .get(collection) as { n: number };
    return row.n;
  }

  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    opts?: VectorSearchOptions
  ): VectorSearchResult<M>[] {
    this.requireKnownDims(query);
    return this.searchJs<M>(
      collection,
      query,
      opts?.topK ?? 10,
      opts?.minScore,
      opts?.where,
      opts?.whereNot
    );
  }

  private searchJs<M extends Record<string, unknown>>(
    collection: string,
    query: Vector,
    topK: number,
    minScore: number | undefined,
    where?: Record<string, unknown>,
    whereNot?: Record<string, unknown>
  ): VectorSearchResult<M>[] {
    const rows = this.db
      .prepare(`SELECT id, vec, metadata FROM vectors WHERE collection = ?`)
      .all(collection) as VectorRow[];
    const scored: VectorSearchResult<M>[] = [];
    for (const row of rows) {
      const meta =
        row.metadata === null ? undefined : (JSON.parse(row.metadata) as M);
      // Pre-KNN metadata filters — applied before scoring.
      if (where && !matchesWhere(meta, where)) continue;
      if (whereNot && matchesWhere(meta, whereNot)) continue;
      const vec = bufferToVector(row.vec);
      if (!isUsableVector(vec)) continue; // directionless — no cosine direction
      const score = cosineSimilarity(query, vec);
      if (!Number.isFinite(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      scored.push({ id: row.id, score, metadata: meta });
    }
    scored.sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id));
    return scored.slice(0, topK);
  }
}

// ─── Search facet (SearchStore) ─────────────────────────────────────────────
//
// FTS5 + bm25 over the same connection as .kv/.vector. Per collection: one
// stable field schema, a docs table {id, <field columns>, meta_json} as the FTS5
// external-content source, with triggers keeping the index in lockstep (the same
// pattern used by downstream knowledge indexes). search runs `MATCH ? ORDER BY bm25(fts,
// ...weights)`, maps bm25 (lower=better) to score=-bm25 (higher=better), and
// applies the meta `filter` in JS via matchesWhere — the identical semantics to
// the in-memory reference.

interface SearchMatchRow {
  id: string;
  meta_json: string | null;
  bm: number;
}

interface SearchSchema {
  fields: string[];
  columns: string[];
}

function searchColumnName(field: string, index: number): string {
  if (field === DEFAULT_SEARCH_FIELD) return DEFAULT_SEARCH_FIELD;
  return `f${index}_${hashName(field)}`;
}

function searchSchema(fields: readonly string[]): SearchSchema {
  return { fields: [...fields], columns: fields.map(searchColumnName) };
}

function quoteSqlIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function searchFieldDefs(schema: SearchSchema): string {
  return schema.columns
    .map((column) => `${quoteSqlIdent(column)} TEXT NOT NULL`)
    .join(",\n        ");
}

function rowColumnRefs(prefix: "new" | "old", schema: SearchSchema): string {
  return schema.columns
    .map((column) => `${prefix}.${quoteSqlIdent(column)}`)
    .join(", ");
}

class SqliteSearchFacet implements SearchStore {
  private readonly ensured = new Set<string>();
  private readonly resolvedTables = new Map<string, string>();
  private readonly schemaTable = "_mirk_search_schema";

  constructor(private readonly db: SqliteDb) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.schemaTable} (
        collection TEXT PRIMARY KEY,
        fields_json TEXT NOT NULL
      );
    `);
  }

  /** Physical docs table for a collection, via the `_mirk_tables` registry
   *  under kind `search`. `register` false is for read paths: they answer the
   *  same question without writing a registry row for a collection that may
   *  never have been indexed. */
  private baseTable(collection: string, register: boolean): string {
    const cached = this.resolvedTables.get(collection);
    if (cached !== undefined) return cached;
    const table = runTableResolution(
      this.db,
      SEARCH_TABLE_KIND,
      collection,
      SEARCH_DOCS_TABLE_PREFIX,
      register
    );
    if (register && !this.db.inTransaction)
      this.resolvedTables.set(collection, table);
    return table;
  }

  /** One registry row governs both tables: the FTS name is derived from the
   *  resolved docs name, and the triggers are named from the docs name below. */
  private ftsTable(docsTable: string): string {
    return ftsTableFor(docsTable);
  }

  private tableExists(table: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?"
        )
        .get(table) !== undefined
    );
  }

  private loadSchema(collection: string): SearchSchema | undefined {
    const row = this.db
      .prepare(
        `SELECT fields_json FROM ${this.schemaTable} WHERE collection = ?`
      )
      .get(collection) as { fields_json: string } | undefined;
    if (row) {
      const fields = JSON.parse(row.fields_json) as string[];
      return searchSchema(fields);
    }

    // Upgrade path for databases created by the earlier single-column search
    // facet: the collection tables already exist, but there is no schema row.
    // Treat them as the default `{ text }` schema and persist that fact.
    const docs = this.baseTable(collection, false);
    if (!this.tableExists(docs)) return undefined;
    const pragma = this.db
      .prepare(`PRAGMA table_info(${quoteSqlIdent(docs)})`)
      .all() as Array<{ name: string }>;
    if (!pragma.some((col) => col.name === DEFAULT_SEARCH_FIELD))
      return undefined;
    const fields = [DEFAULT_SEARCH_FIELD];
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ${this.schemaTable}(collection, fields_json) VALUES (?, ?)`
      )
      .run(collection, JSON.stringify(fields));
    return searchSchema(fields);
  }

  private schemaForIndex(
    collection: string,
    normalized: NormalizedSearchFields
  ): SearchSchema {
    const existing = this.loadSchema(collection);
    if (existing) {
      assertSameSearchFields(existing.fields, normalized.names, collection);
      return existing;
    }
    const fields = [...normalized.names];
    this.db
      .prepare(
        `INSERT INTO ${this.schemaTable}(collection, fields_json) VALUES (?, ?)`
      )
      .run(collection, JSON.stringify(fields));
    return searchSchema(fields);
  }

  private ensure(
    collection: string,
    schema: SearchSchema
  ): { docs: string; fts: string } {
    const docs = this.baseTable(collection, true);
    const fts = this.ftsTable(docs);
    const key = `${docs}:${schema.fields.join("\u0000")}`;
    if (this.ensured.has(key)) return { docs, fts };

    const qDocs = quoteSqlIdent(docs);
    const qFts = quoteSqlIdent(fts);
    const qColumns = schema.columns.map(quoteSqlIdent).join(", ");
    const newColumns = rowColumnRefs("new", schema);
    const oldColumns = rowColumnRefs("old", schema);
    const fieldDefs = searchFieldDefs(schema);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${qDocs} (
        id TEXT PRIMARY KEY,
        ${fieldDefs},
        meta_json TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS ${qFts} USING fts5(
        ${qColumns}, content='${docs}', content_rowid='rowid', tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdent(
        `${docs}_ai`
      )} AFTER INSERT ON ${qDocs} BEGIN
        INSERT INTO ${qFts}(rowid, ${qColumns}) VALUES (new.rowid, ${newColumns});
      END;
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdent(
        `${docs}_ad`
      )} AFTER DELETE ON ${qDocs} BEGIN
        INSERT INTO ${qFts}(${quoteSqlIdent(
      fts
    )}, rowid, ${qColumns}) VALUES('delete', old.rowid, ${oldColumns});
      END;
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdent(
        `${docs}_au`
      )} AFTER UPDATE ON ${qDocs} BEGIN
        INSERT INTO ${qFts}(${quoteSqlIdent(
      fts
    )}, rowid, ${qColumns}) VALUES('delete', old.rowid, ${oldColumns});
        INSERT INTO ${qFts}(rowid, ${qColumns}) VALUES (new.rowid, ${newColumns});
      END;
    `);
    this.ensured.add(key);
    return { docs, fts };
  }

  index<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: SearchDocument<M>
  ): void {
    const normalized = normalizeSearchDocument(doc);
    const schema = this.schemaForIndex(collection, normalized);
    const { docs } = this.ensure(collection, schema);
    const qDocs = quoteSqlIdent(docs);
    const qColumns = schema.columns.map(quoteSqlIdent);
    const insertColumns = ["id", ...schema.columns, "meta_json"]
      .map(quoteSqlIdent)
      .join(", ");
    const placeholders = Array.from(
      { length: schema.columns.length + 2 },
      () => "?"
    ).join(", ");
    const updateSet = [
      ...qColumns.map((col) => `${col} = excluded.${col}`),
      "meta_json = excluded.meta_json",
    ].join(", ");
    const metaJson = doc.meta === undefined ? null : JSON.stringify(doc.meta);
    this.db
      .prepare(
        `INSERT INTO ${qDocs}(${insertColumns}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${updateSet}`
      )
      .run(
        doc.id,
        ...schema.fields.map((field) => normalized.values[field] ?? ""),
        metaJson
      );
  }

  indexMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<SearchDocument<M>>
  ): void {
    const tx = this.db.transaction(
      (items: ReadonlyArray<SearchDocument<M>>) => {
        for (const doc of items) this.index(collection, doc);
      }
    );
    tx(docs);
  }

  remove(collection: string, id: string): boolean {
    const schema = this.loadSchema(collection);
    if (!schema) return false;
    const { docs } = this.ensure(collection, schema);
    return (
      this.db.prepare(`DELETE FROM ${quoteSqlIdent(docs)} WHERE id = ?`).run(id)
        .changes > 0
    );
  }

  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: string,
    opts?: SearchOptions
  ): SearchResult<M>[] {
    const sanitized = sanitizeFtsQuery(query);
    assertValidFieldWeightValues(opts?.fieldWeights);
    if (sanitized.length === 0) return [];
    const schema = this.loadSchema(collection);
    if (!schema) return [];
    const { docs, fts } = this.ensure(collection, schema);
    const weights = fieldWeightsFor(schema.fields, opts?.fieldWeights);
    const weightArgs =
      weights.length > 0
        ? `, ${weights.map((weight) => String(weight)).join(", ")}`
        : "";
    // Fetch ALL matches ordered by bm25 (lower=better), then apply the meta
    // filter in JS (matching the in-memory reference) and limit — so filter is
    // applied before limit, consistent with /vector's pre-KNN filtering.
    const rows = this.db
      .prepare(
        `SELECT d.id AS id, d.meta_json AS meta_json, bm25(${fts}${weightArgs}) AS bm
         FROM ${quoteSqlIdent(fts)}
         JOIN ${quoteSqlIdent(docs)} d ON d.rowid = ${fts}.rowid
         WHERE ${fts} MATCH ?
         ORDER BY bm, d.id`
      )
      .all(sanitized) as SearchMatchRow[];
    const limit = opts?.limit ?? 10;
    const where = opts?.filter?.where;
    const out: SearchResult<M>[] = [];
    for (const r of rows) {
      const meta = (r.meta_json === null ? {} : JSON.parse(r.meta_json)) as M;
      if (where && !matchesWhere(meta, where)) continue;
      out.push({ id: r.id, score: -r.bm, meta });
    }
    return out.slice(0, limit);
  }
}

// SQL building (jsonPath / buildWhereClause / buildOrderBy / buildLimitOffset /
// hashName) and the `_mirk_tables` physical-name resolution procedure live in
// ../sql.ts — shared verbatim with @mirk/store-libsql so the two SQLite-dialect
// adapters can't drift in filter semantics or in table naming. See that module.
