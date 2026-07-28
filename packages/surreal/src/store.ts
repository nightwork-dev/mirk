import type { AsyncStore, AsyncStoreInQuery, StoreFilter, StoreMeta } from "@mirk/store/kv";

import { KV_TABLE, assertSafeTableIdentifier, collectionTable } from "./internal/identifiers.js";
import { firstStatement } from "./internal/query-result.js";
import type { SurrealConnection } from "./index.js";

export interface SurrealStoreOptions {
  namespace?: string;
}

interface CountRow {
  count?: number;
}

export class SurrealStoreAdapter implements AsyncStore, AsyncStoreInQuery {
  readonly meta: StoreMeta = { backend: "surrealdb" };
  private readonly initializedCollections = new Set<string>();
  private initialized = false;

  private constructor(private readonly connection: SurrealConnection) {}

  static async open(
    connection: SurrealConnection,
    _options: SurrealStoreOptions = {},
  ): Promise<SurrealStoreAdapter> {
    const adapter = new SurrealStoreAdapter(connection);
    await adapter.init();
    return adapter;
  }

  async get<T>(key: string): Promise<T | null> {
    const rows = firstStatement<T[]>(
      await this.connection.query("SELECT VALUE value FROM type::record($table, $id)", {
        table: KV_TABLE,
        id: key,
      }),
    );
    return rows[0] ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.connection.query(
      "UPSERT type::record($table, $id) CONTENT { key: $key, value: $value }",
      { table: KV_TABLE, id: key, key, value },
    );
  }

  async has(key: string): Promise<boolean> {
    const rows = firstStatement<unknown[]>(
      await this.connection.query("SELECT VALUE key FROM type::record($table, $id)", {
        table: KV_TABLE,
        id: key,
      }),
    );
    return rows.length > 0;
  }

  async delete(key: string): Promise<boolean> {
    const rows = firstStatement<unknown[]>(
      await this.connection.query("DELETE type::record($table, $id) RETURN BEFORE", {
        table: KV_TABLE,
        id: key,
      }),
    );
    return rows.length > 0;
  }

  async keys(prefix?: string): Promise<string[]> {
    const rows = firstStatement<string[]>(
      await this.connection.query("SELECT VALUE key FROM type::table($table)", {
        table: KV_TABLE,
      }),
    );
    return rows
      .filter((key) => prefix === undefined || key.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b));
  }

  async list<T>(collection: string, filter?: StoreFilter): Promise<T[]> {
    const table = await this.ensureCollection(collection);
    const rows = await this.selectFiltered<T>(table, filter);
    return applySortLimitOffset(rows, filter);
  }

  async listWhereIn<T>(
    collection: string,
    field: string,
    values: readonly unknown[],
    filter?: StoreFilter,
  ): Promise<T[]> {
    if (values.length === 0) return [];
    const table = await this.ensureCollection(collection);
    const query = buildSelectQuery(filter, "$inField INSIDE object::keys(data) AND data[$inField] INSIDE $inValues");
    const rows = firstStatement<T[]>(
      await this.connection.query(query.sql, {
        table,
        inField: field,
        inValues: [...values],
        ...query.bindings,
      }),
    );
    return applySortLimitOffset(rows, filter);
  }

  async getById<T>(collection: string, id: string): Promise<T | null> {
    const table = await this.ensureCollection(collection);
    const rows = firstStatement<T[]>(
      await this.connection.query("SELECT VALUE data FROM type::record($table, $id)", {
        table,
        id,
      }),
    );
    return rows[0] ?? null;
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    const table = await this.ensureCollection(collection);
    const data = cloneJson(item);
    await this.connection.query(
      "UPSERT type::record($table, $id) CONTENT { mirk_id: $id, data: $data }",
      { table, id: item.id, data },
    );
    return item;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const table = await this.ensureCollection(collection);
    const rows = firstStatement<unknown[]>(
      await this.connection.query("DELETE type::record($table, $id) RETURN BEFORE", {
        table,
        id,
      }),
    );
    return rows.length > 0;
  }

  async count(collection: string, filter?: StoreFilter): Promise<number> {
    const table = await this.ensureCollection(collection);
    const query = buildCountQuery(filter);
    const rows = firstStatement<CountRow[]>(
      await this.connection.query(query.sql, { table, ...query.bindings }),
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.defineTable(KV_TABLE);
    this.initialized = true;
  }

  private async ensureCollection(collection: string): Promise<string> {
    const table = collectionTable(collection);
    if (this.initializedCollections.has(table)) return table;
    await this.defineTable(table);
    this.initializedCollections.add(table);
    return table;
  }

  private async defineTable(table: string): Promise<void> {
    await this.connection.query(`DEFINE TABLE IF NOT EXISTS ${assertSafeTableIdentifier(table)} SCHEMALESS`);
  }

  private async selectFiltered<T>(table: string, filter?: StoreFilter): Promise<T[]> {
    const query = buildSelectQuery(filter);
    return firstStatement<T[]>(
      await this.connection.query(query.sql, { table, ...query.bindings }),
    );
  }
}

function buildSelectQuery(
  filter?: StoreFilter,
  baseWhere?: string,
): { sql: string; bindings: Record<string, unknown> } {
  const where = buildWhereClauses(filter, baseWhere);
  return {
    sql: `SELECT VALUE data FROM type::table($table)${where.clause}`,
    bindings: where.bindings,
  };
}

function buildCountQuery(filter?: StoreFilter): { sql: string; bindings: Record<string, unknown> } {
  const where = buildWhereClauses(filter);
  return {
    sql: `SELECT count() FROM type::table($table)${where.clause} GROUP ALL`,
    bindings: where.bindings,
  };
}

function buildWhereClauses(
  filter?: StoreFilter,
  baseWhere?: string,
): { clause: string; bindings: Record<string, unknown> } {
  const clauses: string[] = [];
  const bindings: Record<string, unknown> = {};
  if (baseWhere) clauses.push(baseWhere);

  for (const [index, [field, value]] of Object.entries(filter?.where ?? {}).entries()) {
    const fieldKey = `whereField${index}`;
    const valueKey = `whereValue${index}`;
    clauses.push(`$${fieldKey} INSIDE object::keys(data) AND data[$${fieldKey}] = $${valueKey}`);
    bindings[fieldKey] = field;
    bindings[valueKey] = value;
  }

  return {
    clause: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    bindings,
  };
}

function applySortLimitOffset<T>(items: T[], filter?: StoreFilter): T[] {
  let result = items;
  if (filter?.sortBy !== undefined) {
    const field = filter.sortBy;
    const dir = filter.sortDir === "desc" ? -1 : 1;
    result = [...result].sort((a, b) => {
      const aHas = hasOwn(a, field);
      const bHas = hasOwn(b, field);
      const aVal = aHas ? (a as Record<string, unknown>)[field] : undefined;
      const bVal = bHas ? (b as Record<string, unknown>)[field] : undefined;
      const aMissing = !aHas || aVal === null;
      const bMissing = !bHas || bVal === null;
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (aVal === bVal) return 0;
      return comparePresentValues(aVal, bVal) * dir;
    });
  }
  if (filter?.offset !== undefined && filter.offset > 0) {
    result = result.slice(filter.offset);
  }
  if (filter?.limit !== undefined && filter.limit >= 0) {
    result = result.slice(0, filter.limit);
  }
  return result;
}

function comparePresentValues(a: unknown, b: unknown): number {
  return (a as any) < (b as any) ? -1 : 1;
}

function hasOwn(value: unknown, field: string): boolean {
  return typeof value === "object" && value !== null && Object.hasOwn(value, field);
}

function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("SurrealStoreAdapter values must be JSON-safe.");
  }
  return JSON.parse(serialized) as T;
}
