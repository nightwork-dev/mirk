import type { InStatement, ResultSet } from "@libsql/client";
import type { StoreFilter, StoreMeta } from "@mirk/store";
import {
  buildWhereClause,
  buildOrderBy,
  buildLimitOffset,
  buildInClause,
  buildEnsureIndexSql,
  COLLECTION_TABLE_KIND,
} from "@mirk/store/sql";
import { LibsqlAtomicFacet } from "./libsql-atomic.js";
import type { LibsqlKvStore } from "./libsql-types.js";
import { LibsqlAdapterError } from "./libsql-errors.js";
import { runTableResolution } from "./libsql-registry.js";

export class LibsqlKvFacet extends LibsqlAtomicFacet implements LibsqlKvStore {
  readonly meta: StoreMeta = { backend: "libsql" };
  protected readonly initializedTables = new Map<string, string>();
  /** Physical table for a collection, via the `_mirk_tables` registry, created
   *  if missing. The hash-derived name is only the first CANDIDATE: a name whose
   *  candidate is already claimed by a different collection gets `_2`, `_3`, …
   *  so two names that sanitize and hash alike never share one table. The
   *  table is remembered only once the transaction that created it commits. */
  protected async ensureTable(collection: string): Promise<string> {
    if (collection.length === 0)
      throw new LibsqlAdapterError(
        "invalid-collection-name",
        "Invalid collection name",
      );
    const cached = this.initializedTables.get(collection);
    if (cached !== undefined) return cached;
    return this.write(async () => {
      const table = await runTableResolution(
        this.db,
        this.names,
        COLLECTION_TABLE_KIND,
        collection,
        true,
      );
      await this.db.execute(collectionTableDdl(table));
      this.db.transactions.afterCommit(() =>
        this.initializedTables.set(collection, table),
      );
      return table;
    });
  }

  /** The tables of `collections` for one atomic request. Tables this adapter
   *  has not committed yet are looked up together in the registry, and
   *  `ensure` holds the statements that make sure they exist; ones the
   *  registry does not hold yet are created now. */
  protected async atomicTables(
    collections: ReadonlySet<string>,
    registered: ResultSet | undefined,
  ): Promise<{ tables: Map<string, string>; ensure: InStatement[] }> {
    const tables = new Map<string, string>();
    const ensure: InStatement[] = [];
    for (const row of registered?.rows ?? []) {
      const collection = row.name as string;
      const table = row.table_name as string;
      tables.set(collection, table);
      ensure.push(collectionTableDdl(table));
      this.db.transactions.afterCommit(() =>
        this.initializedTables.set(collection, table),
      );
    }
    for (const collection of collections) {
      if (tables.has(collection)) continue;
      tables.set(
        collection,
        this.initializedTables.get(collection) ??
          (await this.ensureTable(collection)),
      );
    }
    return { tables, ensure };
  }

  protected registeredTablesStatement(collections: string[]): InStatement {
    return {
      sql: this.names.registrySql(
        "SELECT name, table_name FROM _mirk_tables WHERE kind = ? AND name IN (SELECT value FROM json_each(?))",
      ),
      args: [COLLECTION_TABLE_KIND, JSON.stringify(collections)],
    };
  }

  async get<T>(key: string): Promise<T | null> {
    const rs = await this.db.execute({
      sql: `SELECT value FROM ${this.names.kv} WHERE key = ?`,
      args: [key],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return JSON.parse(row.value as string) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const encoded = JSON.stringify(value);
    await this.write(() => this.writeKey(key, encoded));
  }

  async has(key: string): Promise<boolean> {
    const rs = await this.db.execute({
      sql: `SELECT 1 FROM ${this.names.kv} WHERE key = ?`,
      args: [key],
    });
    return rs.rows.length > 0;
  }

  async delete(key: string): Promise<boolean> {
    return this.write(() => this.deleteKey(key));
  }

  async keys(prefix?: string): Promise<string[]> {
    if (prefix) {
      // Escape LIKE wildcards so the prefix matches LITERALLY (startsWith), not as
      // a pattern — matches the in-memory reference's `key.startsWith(prefix)`.
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rs = await this.db.execute({
        sql: `SELECT key FROM ${this.names.kv} WHERE key LIKE ? ESCAPE '\\' ORDER BY key`,
        args: [`${escaped}%`],
      });
      return rs.rows.map((r) => r.key as string);
    }
    const rs = await this.db.execute(
      `SELECT key FROM ${this.names.kv} ORDER BY key`,
    );
    return rs.rows.map((r) => r.key as string);
  }

  async list<T>(collection: string, filter?: StoreFilter): Promise<T[]> {
    const table = await this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const orderBy = buildOrderBy(filter);
    const limitOffset = buildLimitOffset(filter);
    const sql = `SELECT data FROM ${table}${where.clause}${orderBy.clause}${limitOffset}`;
    const rs = await this.db.execute({
      sql,
      args: [...where.params, ...orderBy.params],
    });
    return rs.rows.map((r) => JSON.parse(r.data as string) as T);
  }

  async listWhereIn<T>(
    collection: string,
    field: string,
    values: readonly unknown[],
    filter?: StoreFilter,
  ): Promise<T[]> {
    if (values.length === 0) return [];
    const where = buildWhereClause(filter);
    const inWhere = buildInClause(field, values, where.clause.length > 0);
    const table = await this.ensureTable(collection);
    const orderBy = buildOrderBy(filter);
    const limitOffset = buildLimitOffset(filter);
    const rs = await this.db.execute({
      sql: `SELECT data FROM ${table}${where.clause}${inWhere.clause}${orderBy.clause}${limitOffset}`,
      args: [...where.params, ...inWhere.params, ...orderBy.params],
    });
    return rs.rows.map((r) => JSON.parse(r.data as string) as T);
  }

  async ensureIndex(collection: string, field: string): Promise<void> {
    const table = await this.ensureTable(collection);
    await this.write(async () => {
      await this.db.execute(buildEnsureIndexSql(table, field));
    });
  }

  async getById<T>(collection: string, id: string): Promise<T | null> {
    const table = await this.ensureTable(collection);
    const rs = await this.db.execute({
      sql: `SELECT data FROM ${table} WHERE id = ?`,
      args: [id],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return JSON.parse(row.data as string) as T;
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    const encoded = JSON.stringify(item);
    await this.write(() => this.writeRecord(collection, item.id, encoded));
    return item;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    return this.write(() => this.deleteRecord(collection, id));
  }

  async count(collection: string, filter?: StoreFilter): Promise<number> {
    const table = await this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const rs = await this.db.execute({
      sql: `SELECT COUNT(*) as cnt FROM ${table}${where.clause}`,
      args: where.params,
    });
    // bigint-safe: libSQL may return integer columns as bigint.
    return Number(rs.rows[0]!.cnt);
  }
}
function collectionTableDdl(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`;
}
