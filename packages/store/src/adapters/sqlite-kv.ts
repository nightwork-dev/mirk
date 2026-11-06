import { type SqliteDb } from "./sqlite-driver.js";
import type {
  SyncStore,
  SyncStoreInQuery,
  SyncStoreIndexes,
  StoreMeta,
  StoreFilter,
} from "../types.js";
import type {
  AtomicMutationLimits,
  AtomicMutationRequest,
  AtomicMutationResult,
  StoreCondition,
  StoreTarget,
  StoreVersion,
  SyncAtomicMutationStore,
  SyncReceiptPruning,
  VersionedStoreValue,
} from "../atomic.js";
import {
  AtomicMutationBackendError,
  cloneJson,
  IN_PROCESS_ATOMIC_LIMITS,
  isReceiptExpired,
  RECEIPT_PRUNE_BATCH,
  validateAtomicRequest,
} from "../atomic.js";
import { isSqliteBusyOrLocked } from "../sqlite-busy.js";
import {
  buildWhereClause,
  buildOrderBy,
  buildLimitOffset,
  buildInClause,
  buildEnsureIndexSql,
  COLLECTION_TABLE_KIND,
  COLLECTION_TABLE_PREFIX,
} from "../sql.js";
import { randomUUID } from "node:crypto";
import { runTableResolution } from "./sqlite-registry.js";
export class SqliteKvFacet
  implements
    SyncStore,
    SyncStoreInQuery,
    SyncStoreIndexes,
    SyncAtomicMutationStore,
    SyncReceiptPruning
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
    private readonly now: () => number = Date.now,
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
        "INSERT OR IGNORE INTO _mirk_atomic_identity (id, value) VALUES (1, ?)",
      )
      .run(versionIdentity ?? randomUUID());
    // Receipts written before receipts expired carry no creation time.
    const receiptColumns = this.db
      .prepare("PRAGMA table_info(_mirk_atomic_receipts)")
      .all() as { name: string }[];
    if (!receiptColumns.some((column) => column.name === "created_at")) {
      this.db.exec(
        "ALTER TABLE _mirk_atomic_receipts ADD COLUMN created_at INTEGER",
      );
    }
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS _mirk_atomic_receipts_created_at ON _mirk_atomic_receipts (created_at)",
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
      true,
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
      )`,
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
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
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
          `SELECT key FROM _kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key`,
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
    filter?: StoreFilter,
  ): T[] {
    if (values.length === 0) return [];
    const table = this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const inWhere = buildInClause(field, values, where.clause.length > 0);
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

  ensureIndex(collection: string, field: string): void {
    this.db.exec(buildEnsureIndexSql(this.ensureTable(collection), field));
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
           ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
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
          "SQLite is busy or locked.",
        );
      }
      throw error;
    }
  }

  private decideAtomic(
    validated: ReturnType<typeof validateAtomicRequest>,
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
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
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
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
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
      const batch = this.db.transaction(() =>
        this.pruneReceiptBatch(this.now()),
      );
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
    now: number,
  ): { requestDigest: string; resultJson: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT request_digest as requestDigest, result_json as resultJson, created_at as createdAt FROM _mirk_atomic_receipts WHERE idempotency_key = ?",
      )
      .get(key) as
      | {
          requestDigest: string;
          resultJson: string;
          createdAt: number | bigint | null;
        }
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
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO _mirk_atomic_receipts (idempotency_key, request_digest, result_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET request_digest = excluded.request_digest,
           result_json = excluded.result_json, created_at = excluded.created_at`,
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
           SELECT idempotency_key FROM _mirk_atomic_receipts WHERE created_at IS NULL LIMIT ?)`,
      )
      .run(now, RECEIPT_PRUNE_BATCH);
    return Number(
      this.db
        .prepare(
          `DELETE FROM _mirk_atomic_receipts WHERE idempotency_key IN (
           SELECT idempotency_key FROM _mirk_atomic_receipts WHERE created_at < ? ORDER BY created_at LIMIT ?)`,
        )
        .run(now - this.receiptRetentionMs, RECEIPT_PRUNE_BATCH).changes,
    );
  }

  private observe(target: StoreTarget): VersionedStoreValue<unknown> | null {
    return this.readVersionedTarget(target);
  }

  private readVersionedTarget<T>(
    target: StoreTarget,
  ): VersionedStoreValue<T> | null {
    if (target.kind === "key") {
      const row = this.db
        .prepare(
          `SELECT k.value, v.version
           FROM _kv AS k
           LEFT JOIN _mirk_atomic_versions AS v
             ON v.kind = 'key' AND v.collection = '' AND v.target_key = k.key
          WHERE k.key = ?`,
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
        WHERE c.id = ?`,
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
        "UPDATE _mirk_atomic_sequence SET value = value + 1 WHERE id = 1 RETURNING value",
      )
      .get() as { value: number };
    const version = `${this.versionPrefix}-v${row.value}` as StoreVersion;
    this.db
      .prepare(
        `INSERT INTO _mirk_atomic_versions (kind, collection, target_key, version) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, collection, target_key) DO UPDATE SET version = excluded.version`,
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
        "DELETE FROM _mirk_atomic_versions WHERE kind = ? AND collection = ? AND target_key = ?",
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
  observed: VersionedStoreValue<unknown> | null,
): boolean {
  if (condition.expected === "missing") return observed === null;
  if (condition.expected === "present") return observed !== null;
  return observed !== null && observed.version === condition.version;
}
