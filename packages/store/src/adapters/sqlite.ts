// ─── @mirk/store/sqlite ─────────────────────────────────────────────────────
// The sqlite SOURCE ADAPTER. One better-sqlite3 connection, multiple capability
// facets: `.kv` is a SyncStore (KV + collections), `.vector` is a VectorStore.
//
// Why facets and not "class implements SyncStore, VectorStore": the two ports
// both declare get/remove/count with DIFFERENT shapes (kv `get(key)` vs vector
// `get(collection, id)`), so a single class can't implement both. A multi-
// capability handle exposing one facet per capability is the collision-free
// shape — and it's exactly how one source (SurrealDB: kv + vector + blob +
// graph) serves many capabilities over one connection.
//
// better-sqlite3 is the ONLY native reference in @mirk/store, reachable solely
// through this subpath. Vector search uses sqlite-vec (vec0, cosine metric) when
// the optional sqlite-vec peer is installed (meta.accelerated=true), else an exact
// JS-cosine fallback with identical rankings (meta.accelerated=false).

import Database from "better-sqlite3";

import type {
  SyncStore,
  SyncStoreInQuery,
  StoreMeta,
  StoreFilter,
} from "../types.js";
import type {
  AtomicMutationRequest,
  AtomicMutationResult,
  StoreCondition,
  StoreTarget,
  StoreVersion,
  SyncAtomicMutationStore,
  VersionedStoreValue,
} from "../atomic.js";
import {
  AtomicMutationBackendError,
  cloneJson,
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
import {
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
  assertDimensions,
  isUsableVector,
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
} from "../sql.js";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";

const nodeRequire = createRequire(import.meta.url);

/** Try to load the sqlite-vec extension into a connection. Optional + graceful:
 *  returns false (no acceleration) on any failure — not installed, ABI mismatch,
 *  or loadExtension disabled. Synchronous via createRequire (the adapter ctor is
 *  sync); sqlite-vec is a string require, so the bundler leaves it external. */
function tryLoadSqliteVec(db: Database.Database): boolean {
  try {
    const vec = nodeRequire("sqlite-vec") as {
      load?: (db: Database.Database) => void;
      getLoadablePath?: () => string;
    };
    if (typeof vec.load === "function") {
      vec.load(db);
      return true;
    }
    if (typeof vec.getLoadablePath === "function") {
      db.loadExtension(vec.getLoadablePath());
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function assertPositiveDimensions(dimensions: number): void {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(
      `Vector dimensions must be a positive integer; got ${dimensions}.`
    );
  }
}

function sqlParam(value: unknown): SqlParam {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  throw new Error("Store IN queries only support JSON scalar values.");
}

function buildJsonInWhere(
  field: string,
  values: readonly unknown[],
  hasPriorWhere: boolean
): { clause: string; params: SqlParam[] } {
  const path = jsonPath(field);
  const params: SqlParam[] = [];
  const nonNull = values.filter((value) => value !== null).map(sqlParam);
  const hasNull = values.some((value) => value === null);
  const parts: string[] = [];

  if (nonNull.length > 0) {
    parts.push(
      `json_extract(data, ?) IN (${nonNull.map(() => "?").join(", ")})`
    );
    params.push(path, ...nonNull);
  }
  if (hasNull) {
    parts.push(`json_type(data, ?) = 'null'`);
    params.push(path);
  }

  return {
    clause: `${hasPriorWhere ? " AND" : " WHERE"} (${parts.join(" OR ")})`,
    params,
  };
}

export interface SqliteAdapterOptions {
  /** Path to the SQLite database file. Use ":memory:" for in-memory. */
  path: string;
  /** Existing better-sqlite3 instance to reuse (shares one connection). */
  db?: Database.Database;
  /** Embedding dimensions. Optional: when omitted, `.vector` persists the
   *  dimensions from the first upsert/upsertMany call. KV/search work without it. */
  dimensions?: number;
  /** Force the exact JS-cosine search path even when sqlite-vec is installed.
   *  Mainly for parity testing; production should leave this off. */
  forceJsCosine?: boolean;
  /** Maximum time SQLite waits for another process's writer before returning SQLITE_BUSY. */
  busyTimeoutMs?: number;
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
export class SqliteAdapter {
  private readonly db: Database.Database;
  private readonly dbPath: string;
  readonly kv!: SyncStore & SyncAtomicMutationStore;
  readonly vector!: VectorStore;
  readonly search!: SearchStore;

  constructor(opts: SqliteAdapterOptions) {
    const ownsDb = opts.db === undefined;
    if (
      opts.busyTimeoutMs !== undefined &&
      (!Number.isSafeInteger(opts.busyTimeoutMs) || opts.busyTimeoutMs < 0)
    ) {
      throw new Error(
        `busyTimeoutMs must be a non-negative safe integer; got ${opts.busyTimeoutMs}.`
      );
    }
    this.dbPath = opts.path;
    this.db =
      opts.db ??
      new Database(opts.path, { timeout: opts.busyTimeoutMs ?? 30_000 });
    try {
      const busyTimeoutMs = opts.busyTimeoutMs ?? 30_000;
      this.db.pragma(`busy_timeout = ${busyTimeoutMs}`);
      // Opening two adapters concurrently can contend on the WAL mode pragma
      // and bootstrap DDL. Keep startup within the caller's bounded timeout,
      // just as individual atomic writes are kept bounded below.
      let kv: SqliteKvFacet | undefined;
      let vector: SqliteVectorFacet | undefined;
      let search: SqliteSearchFacet | undefined;
      runSqliteBusyRetry(() => {
        this.db.pragma("journal_mode = WAL");
        kv = new SqliteKvFacet(this.db);
        vector = new SqliteVectorFacet(
          this.db,
          opts.path,
          opts.dimensions,
          opts.forceJsCosine
        );
        search = new SqliteSearchFacet(this.db);
      }, busyTimeoutMs);
      this.kv = kv!;
      this.vector = vector!;
      this.search = search!;
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
    const transaction = this.db.transaction(work);
    return transaction[mode]();
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
  implements SyncStore, SyncStoreInQuery, SyncAtomicMutationStore
{
  readonly meta: StoreMeta = { backend: "sqlite" };
  private readonly initializedTables = new Set<string>();
  private readonly versionPrefix: string;

  constructor(private readonly db: Database.Database) {
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
        result_json TEXT NOT NULL
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
      .run(randomUUID());
    this.versionPrefix = (
      this.db
        .prepare("SELECT value FROM _mirk_atomic_identity WHERE id = 1")
        .get() as { value: string }
    ).value;
  }

  private tableName(collection: string): string {
    if (collection.length === 0) throw new Error("Invalid collection name");
    const sanitized = collection.replace(/[^a-zA-Z0-9_]/g, "_");
    // Suffix a hash of the ORIGINAL name so two distinct collections that sanitize
    // to the same string (e.g. "foo-bar" vs "foo_bar") never alias to one table.
    return `c_${sanitized}_${hashName(collection)}`;
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
    const validated = validateAtomicRequest(request);
    const transaction = this.db.transaction(() => this.decideAtomic(validated));
    try {
      return transaction.immediate();
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (
        code?.startsWith("SQLITE_BUSY") ||
        code?.startsWith("SQLITE_LOCKED")
      ) {
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
    if (idempotencyKey !== undefined) {
      const prior = this.db
        .prepare(
          "SELECT request_digest as requestDigest, result_json as resultJson FROM _mirk_atomic_receipts WHERE idempotency_key = ?"
        )
        .get(idempotencyKey) as
        | { requestDigest: string; resultJson: string }
        | undefined;
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
    if (idempotencyKey !== undefined) {
      this.db
        .prepare(
          "INSERT INTO _mirk_atomic_receipts (idempotency_key, request_digest, result_json) VALUES (?, ?, ?)"
        )
        .run(idempotencyKey, validated.requestDigest, JSON.stringify(applied));
    }
    return applied;
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
    this.db
      .prepare(
        "UPDATE _mirk_atomic_sequence SET value = value + 1 WHERE id = 1"
      )
      .run();
    const row = this.db
      .prepare("SELECT value FROM _mirk_atomic_sequence WHERE id = 1")
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

function runSqliteBusyRetry<T>(work: () => T, waitMs: number): T {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      return work();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        typeof code !== "string" ||
        (!code.startsWith("SQLITE_BUSY") &&
          !code.startsWith("SQLITE_LOCKED")) ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      const remaining = Math.max(1, deadline - Date.now());
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(50, remaining)
      );
    }
  }
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
  /** True when sqlite-vec loaded and the vec0 acceleration path is live. */
  private accelerated = false;
  private readonly vecTablesEnsured = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly path: string,
    dimensions?: number,
    private readonly forceJsCosine = false
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
        throw new Error(
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
        throw new Error(
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
    // Optional vec0 acceleration: load sqlite-vec unless forced off and dims are set.
    // Any failure leaves the exact JS-cosine path (results are identical — see search).
    this.accelerated =
      !this.forceJsCosine && this.dimensions >= 0 && tryLoadSqliteVec(this.db);
    this.meta.dimensions = Math.max(this.dimensions, 0);
    this.meta.accelerated = this.accelerated;
  }

  private requireKnownDims(v: Vector): void {
    if (this.dimensions < 0) {
      throw new Error(
        "SqliteAdapter.vector has no dimensions yet — pass { dimensions } when opening or upsert a vector first."
      );
    }
    assertDimensions(v, this.dimensions);
  }

  private ensureDimsForWrite(v: Vector): void {
    if (this.dimensions < 0) this.initializeDims(v.length);
    assertDimensions(v, this.dimensions);
  }

  // ── vec0 acceleration helpers ───────────────────────────────────────────
  private vecTableName(collection: string): string {
    return `vectors_vec_${collection.replace(/[^a-zA-Z0-9_]/g, "_")}_${hashName(
      collection
    )}`;
  }

  private ensureVecTable(collection: string): string {
    const table = this.vecTableName(collection);
    if (this.vecTablesEnsured.has(table)) return table;
    // cosine metric (NOT vec0's L2 default) so rankings match the exact JS cosine path.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[${this.dimensions}] distance_metric=cosine)`
    );
    this.vecTablesEnsured.add(table);
    // Backfill any vectors written while sqlite-vec was unavailable (a prior fallback
    // session, or before the peer was installed) so accelerated search is complete.
    const existing = this.db
      .prepare(`SELECT rowid, vec FROM vectors WHERE collection = ?`)
      .all(collection) as Array<{ rowid: number; vec: Buffer }>;
    if (existing.length > 0) {
      const del = this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
      const ins = this.db.prepare(
        `INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`
      );
      const backfill = this.db.transaction(() => {
        for (const r of existing) {
          const rid = BigInt(r.rowid);
          del.run(rid);
          if (isUsableVector(bufferToVector(r.vec))) ins.run(rid, r.vec);
        }
      });
      backfill();
    }
    return table;
  }

  /** Keep a (collection,id)'s vec0 row in sync. vec0 is keyed by the vectors row's
   *  rowid (stable under ON CONFLICT DO UPDATE); the rowid binds as BigInt. */
  private syncVec(collection: string, id: string, vector: Vector): void {
    const table = this.ensureVecTable(collection);
    const row = this.db
      .prepare(`SELECT rowid FROM vectors WHERE collection = ? AND id = ?`)
      .get(collection, id) as { rowid: number } | undefined;
    if (!row) return;
    const rid = BigInt(row.rowid);
    this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(rid);
    // Zero / non-finite vectors have no cosine direction — keep them OUT of vec0
    // (the JS path excludes them too) so the two paths stay in parity.
    if (isUsableVector(vector)) {
      this.db
        .prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`)
        .run(rid, vectorToBuffer(vector));
    }
  }

  upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>
  ): void {
    this.ensureDimsForWrite(doc.vector);
    // Atomic: the base-table write and the vec0 sync must not desync on a crash.
    // (Nested inside upsertMany's transaction → savepoint, which is fine.)
    const write = this.db.transaction(() => {
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
      if (this.accelerated) this.syncVec(collection, doc.id, doc.vector);
    });
    write();
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
    if (this.accelerated) {
      const row = this.db
        .prepare(`SELECT rowid FROM vectors WHERE collection = ? AND id = ?`)
        .get(collection, id) as { rowid: number } | undefined;
      if (row) {
        this.db
          .prepare(
            `DELETE FROM ${this.ensureVecTable(collection)} WHERE rowid = ?`
          )
          .run(BigInt(row.rowid));
      }
    }
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
    const topK = opts?.topK ?? 10;
    const minScore = opts?.minScore;
    const hasFilters = !!(opts?.where || opts?.whereNot);
    // When pre-KNN filters are present, use the JS path: metadata lives on the main
    // `vectors` table (not in vec0), so the accelerated path can't apply them before
    // scoring. The JS path fetches all rows and filters first — correct semantics,
    // identical results to the in-memory backend.
    // A zero / non-finite query has no cosine direction (vec0's behavior there is
    // backend-defined) — also use the deterministic JS path in that case.
    if (this.accelerated && isUsableVector(query) && !hasFilters) {
      try {
        return this.searchVec<M>(collection, query, topK, minScore);
      } catch {
        // Any vec runtime error → fall through to the exact JS path (same result).
      }
    }
    return this.searchJs<M>(
      collection,
      query,
      topK,
      minScore,
      opts?.where,
      opts?.whereNot
    );
  }

  private searchVec<M extends Record<string, unknown>>(
    collection: string,
    query: Vector,
    topK: number,
    minScore: number | undefined
  ): VectorSearchResult<M>[] {
    const table = this.ensureVecTable(collection);
    // `minScore` is a filter, and every filter runs BEFORE topK on every path
    // (the JS path filters then slices). Pushing `LIMIT topK` into the KNN query
    // would slice first and return fewer rows than the JS path whenever one of
    // the topK nearest falls below the floor. vec0 requires a LIMIT on a KNN
    // query, so widen it to the whole collection and slice after filtering.
    const sqlLimit = minScore === undefined ? topK : this.count(collection);
    const rows = this.db
      .prepare(
        `SELECT v.id AS id, v.metadata AS metadata, vv.distance AS distance
         FROM ${table} vv JOIN vectors v ON v.rowid = vv.rowid
         WHERE vv.embedding MATCH ? ORDER BY vv.distance LIMIT ?`
      )
      .all(vectorToBuffer(query), sqlLimit) as Array<{
      id: string;
      metadata: string | null;
      distance: number;
    }>;
    const out: VectorSearchResult<M>[] = [];
    for (const r of rows) {
      if (r.distance === null) continue; // a directionless (zero) vector — excluded
      const score = 1 - r.distance; // cosine distance → similarity; matches the JS path
      if (!Number.isFinite(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      out.push({
        id: r.id,
        score,
        metadata:
          r.metadata === null ? undefined : (JSON.parse(r.metadata) as M),
      });
    }
    out.sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id));
    return out.slice(0, topK);
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
      if (!isUsableVector(vec)) continue; // directionless — excluded (matches the vec0 path)
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
  private readonly schemaTable = "_mirk_search_schema";

  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.schemaTable} (
        collection TEXT PRIMARY KEY,
        fields_json TEXT NOT NULL
      );
    `);
  }

  private baseTable(collection: string): string {
    return `search_docs_${collection.replace(/[^a-zA-Z0-9_]/g, "_")}_${hashName(
      collection
    )}`;
  }

  private ftsTable(collection: string): string {
    return `search_fts_${collection.replace(/[^a-zA-Z0-9_]/g, "_")}_${hashName(
      collection
    )}`;
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
    const docs = this.baseTable(collection);
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
    const docs = this.baseTable(collection);
    const fts = this.ftsTable(collection);
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
// hashName) lives in ../sql.ts — shared verbatim with @mirk/store-libsql so the
// two SQLite-dialect adapters can't drift in filter semantics. See that module.
