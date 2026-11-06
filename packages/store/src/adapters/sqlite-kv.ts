import { type SqliteDb } from "./sqlite-driver.js";
import type {
  SyncStore,
  SyncStoreInQuery,
  SyncStoreIndexes,
  StoreMeta,
  StoreFilter,
} from "../types.js";
import type { AtomicMutationLimits } from "../atomic.js";
import { IN_PROCESS_ATOMIC_LIMITS } from "../atomic.js";
import {
  buildWhereClause,
  buildOrderBy,
  buildLimitOffset,
  buildInClause,
  buildEnsureIndexSql,
  COLLECTION_TABLE_KIND,
  COLLECTION_TABLE_PREFIX,
} from "../sql.js";
import { runTableResolution } from "./sqlite-registry.js";
import { SqliteAtomicFacet } from "./sqlite-atomic.js";
export class SqliteKvFacet
  extends SqliteAtomicFacet
  implements SyncStore, SyncStoreInQuery, SyncStoreIndexes
{
  readonly meta: StoreMeta = { backend: "sqlite" };
  private readonly initializedTables = new Set<string>();
  private readonly resolvedTables = new Map<string, string>();
  constructor(
    db: SqliteDb,
    atomicLimits: AtomicMutationLimits = IN_PROCESS_ATOMIC_LIMITS,
    versionIdentity?: string,
    receiptRetentionMs?: number,
    now: () => number = Date.now,
  ) {
    super(db, atomicLimits, versionIdentity, receiptRetentionMs, now);
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
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

  protected ensureTable(collection: string): string {
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

  protected tableIfExists(collection: string): string | null {
    const table = this.tableName(collection);
    if (this.initializedTables.has(table)) return table;
    const row = this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    return row === undefined ? null : table;
  }
}
