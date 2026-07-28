import { Pool, type PoolConfig, type QueryResult } from "pg";

import type {
  AsyncStore,
  AsyncStoreInQuery,
  StoreFilter,
  StoreMeta,
} from "@mirk/store";

export interface PostgresAdapterOptions {
  /** PostgreSQL connection string used when the adapter owns its pool. */
  connectionString?: string;
  /** Additional node-postgres pool configuration. */
  poolConfig?: Omit<PoolConfig, "connectionString">;
  /** Caller-owned pool shared with other adapters or application queries. */
  pool?: Pool;
  /** PostgreSQL schema for Mirk's fixed tables. Defaults to `mirk`. */
  schema?: string;
}

interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

type PostgresStore = AsyncStore & AsyncStoreInQuery;

export class PostgresAdapter {
  readonly kv: PostgresStore;
  private closed = false;

  private constructor(
    private readonly pool: Pool,
    private readonly ownsPool: boolean,
    schema: string,
  ) {
    this.kv = new PostgresStoreFacet(pool, schema);
  }

  static async open(options: PostgresAdapterOptions = {}): Promise<PostgresAdapter> {
    if (options.pool && (options.connectionString !== undefined || options.poolConfig !== undefined)) {
      throw new Error("Pass either `pool` or owned-pool connection options, not both.");
    }
    const schema = options.schema ?? "mirk";
    if (schema.length === 0) throw new Error("PostgreSQL schema must not be empty.");
    const ownsPool = options.pool === undefined;
    const pool = options.pool ?? new Pool({ ...options.poolConfig, connectionString: options.connectionString });
    const adapter = new PostgresAdapter(pool, ownsPool, schema);
    try {
      await (adapter.kv as PostgresStoreFacet).init();
      return adapter;
    } catch (error) {
      if (ownsPool) await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await this.pool.end();
  }
}

class PostgresStoreFacet implements PostgresStore {
  readonly meta: StoreMeta = { backend: "postgres" };
  private readonly kvTable: string;
  private readonly recordsTable: string;

  constructor(private readonly database: Queryable, schema: string) {
    const quotedSchema = quoteIdentifier(schema);
    this.kvTable = `${quotedSchema}.kv`;
    this.recordsTable = `${quotedSchema}.records`;
  }

  async init(): Promise<void> {
    const schema = this.kvTable.slice(0, this.kvTable.lastIndexOf("."));
    await this.database.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS ${this.kvTable} (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS ${this.recordsTable} (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB NOT NULL,
        ordinal BIGINT GENERATED ALWAYS AS IDENTITY,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      )
    `);
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.database.query<{ value: T }>(
      `SELECT value FROM ${this.kvTable} WHERE key = $1`,
      [key],
    );
    return result.rows[0]?.value ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.database.query(
      `INSERT INTO ${this.kvTable} (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
      [key, encodeJson(value)],
    );
  }

  async has(key: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM ${this.kvTable} WHERE key = $1`,
      [key],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM ${this.kvTable} WHERE key = $1`,
      [key],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async keys(prefix?: string): Promise<string[]> {
    const result = prefix === undefined
      ? await this.database.query<{ key: string }>(`SELECT key FROM ${this.kvTable} ORDER BY key`)
      : await this.database.query<{ key: string }>(
          `SELECT key FROM ${this.kvTable}
           WHERE left(key, char_length($1)) = $1 ORDER BY key`,
          [prefix],
        );
    return result.rows.map((row) => row.key);
  }

  async list<T>(collection: string, filter?: StoreFilter): Promise<T[]> {
    const query = buildListQuery(this.recordsTable, collection, filter);
    const result = await this.database.query<{ data: T }>(query.sql, query.values);
    return result.rows.map((row) => row.data);
  }

  async listWhereIn<T>(
    collection: string,
    field: string,
    values: readonly unknown[],
    filter?: StoreFilter,
  ): Promise<T[]> {
    if (values.length === 0) return [];
    const query = buildListQuery(this.recordsTable, collection, filter, { field, values });
    const result = await this.database.query<{ data: T }>(query.sql, query.values);
    return result.rows.map((row) => row.data);
  }

  async getById<T>(collection: string, id: string): Promise<T | null> {
    const result = await this.database.query<{ data: T }>(
      `SELECT data FROM ${this.recordsTable} WHERE collection = $1 AND id = $2`,
      [collection, id],
    );
    return result.rows[0]?.data ?? null;
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    await this.database.query(
      `INSERT INTO ${this.recordsTable} (collection, id, data, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = now()`,
      [collection, item.id, encodeJson(item)],
    );
    return item;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM ${this.recordsTable} WHERE collection = $1 AND id = $2`,
      [collection, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async count(collection: string, filter?: StoreFilter): Promise<number> {
    const query = buildWhere(collection, filter?.where);
    const result = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.recordsTable}${query.sql}`,
      query.values,
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}

function buildListQuery(
  table: string,
  collection: string,
  filter?: StoreFilter,
  inQuery?: { field: string; values: readonly unknown[] },
): { sql: string; values: unknown[] } {
  const where = buildWhere(collection, filter?.where, inQuery);
  let sql = `SELECT data FROM ${table}${where.sql}`;
  const values = where.values;
  if (filter?.sortBy) {
    values.push(filter.sortBy);
    const field = `$${values.length}`;
    const direction = filter.sortDir === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY CASE WHEN NOT (data ? ${field}) OR data -> ${field} = 'null'::jsonb THEN 1 ELSE 0 END ASC, CASE WHEN NOT (data ? ${field}) OR data -> ${field} = 'null'::jsonb THEN NULL ELSE data -> ${field} END ${direction} NULLS LAST, ordinal ASC`;
  } else {
    sql += " ORDER BY ordinal ASC";
  }
  if (filter?.limit !== undefined) {
    assertNonNegativeInteger("limit", filter.limit);
    values.push(filter.limit);
    sql += ` LIMIT $${values.length}`;
  }
  if (filter?.offset !== undefined) {
    assertNonNegativeInteger("offset", filter.offset);
    values.push(filter.offset);
    sql += ` OFFSET $${values.length}`;
  }
  return { sql, values };
}

function buildWhere(
  collection: string,
  where?: Record<string, unknown>,
  inQuery?: { field: string; values: readonly unknown[] },
): { sql: string; values: unknown[] } {
  const values: unknown[] = [collection];
  const clauses = ["collection = $1"];
  for (const [field, value] of Object.entries(where ?? {})) {
    values.push(field);
    const fieldParameter = `$${values.length}`;
    values.push(encodeJson(value));
    const valueParameter = `$${values.length}`;
    clauses.push(`data ? ${fieldParameter} AND data -> ${fieldParameter} = ${valueParameter}::jsonb`);
  }
  if (inQuery) {
    values.push(inQuery.field);
    const fieldParameter = `$${values.length}`;
    values.push(encodeJson(inQuery.values));
    const valuesParameter = `$${values.length}`;
    clauses.push(
      `data ? ${fieldParameter} AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(${valuesParameter}::jsonb) candidate
         WHERE data -> ${fieldParameter} = candidate
       )`,
    );
  }
  return { sql: ` WHERE ${clauses.join(" AND ")}`, values };
}

function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, nested) => {
    if (
      nested === undefined ||
      typeof nested === "function" ||
      typeof nested === "symbol" ||
      typeof nested === "bigint" ||
      (typeof nested === "number" && !Number.isFinite(nested))
    ) {
      throw new TypeError("Postgres store values must be JSON-serializable.");
    }
    return nested;
  });
  if (encoded === undefined) throw new TypeError("Postgres store values must be JSON-serializable.");
  return encoded;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer.`);
  }
}
