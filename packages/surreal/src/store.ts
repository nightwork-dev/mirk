import { compareCodePoints } from "@mirk/store";
import { sortAndPageStoreItems } from "@mirk/store/kv";
import type { AsyncStore, AsyncStoreInQuery, AsyncStoreIndexes, StoreFilter, StoreMeta } from "@mirk/store/kv";
import { assertInValues, inRange, whereCondition, type WhereCondition } from "@mirk/store/sql";

import { KV_TABLE, assertSafeTableIdentifier, collectionTable } from "./internal/identifiers.js";
import { cloneJson } from "./internal/clone-json.js";
import { decodeLoneSurrogates, encodeLoneSurrogates } from "./internal/lone-surrogates.js";
import { firstStatement } from "./internal/query-result.js";
import type { SurrealConnection } from "./index.js";

export { SurrealIdentifierError, type SurrealIdentifierErrorCode } from "./internal/identifiers.js";
export { SurrealValueError, type SurrealValueErrorCode } from "./internal/clone-json.js";

export interface SurrealStoreOptions {
  namespace?: string;
}

interface CountRow {
  count?: number;
}

interface KvRow {
  value?: unknown;
  mirk_codec?: unknown;
}

interface CollectionRow {
  mirk_id?: unknown;
  mirk_ordinal?: unknown;
  mirk_codec?: unknown;
  data: unknown;
}

const ORDER_SEQUENCE = "mirk_collection_order";
const COLLECTION_FIELDS = "mirk_id, mirk_ordinal, mirk_codec, data";

export class SurrealStoreAdapter implements AsyncStore, AsyncStoreInQuery, AsyncStoreIndexes {
  readonly meta: StoreMeta = { backend: "surrealdb" };
  private readonly initializedCollections = new Map<string, Promise<void>>();
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
    const rows = firstStatement<KvRow[]>(
      await this.connection.query("SELECT * FROM type::record($table, $id)", {
        table: KV_TABLE,
        id: recordKey(key),
      }),
    );
    const row = rows[0];
    if (row === undefined || row.value === undefined) return null;
    return decodeLoneSurrogates(row.value as T, row.mirk_codec);
  }

  async set<T>(key: string, value: T): Promise<void> {
    const encoded = encodeLoneSurrogates(value);
    await this.connection.query("UPSERT type::record($table, $id) CONTENT $content", {
      table: KV_TABLE,
      id: recordKey(key),
      content: {
        key,
        value: encoded.value,
        ...(encoded.marker ? { mirk_codec: encoded.marker } : {}),
      },
    });
  }

  async has(key: string): Promise<boolean> {
    const rows = firstStatement<unknown[]>(
      await this.connection.query("SELECT VALUE key FROM type::record($table, $id)", {
        table: KV_TABLE,
        id: recordKey(key),
      }),
    );
    return rows.length > 0;
  }

  async delete(key: string): Promise<boolean> {
    const rows = firstStatement<unknown[]>(
      await this.connection.query("DELETE type::record($table, $id) RETURN BEFORE", {
        table: KV_TABLE,
        id: recordKey(key),
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
      .sort(compareCodePoints);
  }

  async list<T>(collection: string, filter?: StoreFilter): Promise<T[]> {
    const table = await this.ensureCollection(collection);
    const query = buildSelectQuery(filter);
    const rows = firstStatement<CollectionRow[]>(
      await this.connection.query(query.sql, { table, ...query.bindings }),
    );
    return sortAndPageStoreItems(inRanges(inInsertionOrder<T>(rows), query.ranges), filter);
  }

  async listWhereIn<T>(
    collection: string,
    field: string,
    values: readonly unknown[],
    filter?: StoreFilter,
  ): Promise<T[]> {
    if (values.length === 0) return [];
    const query = buildSelectQuery(filter, "$inField INSIDE object::keys(data) AND data[$inField] INSIDE $inValues");
    assertInValues(values);
    const table = await this.ensureCollection(collection);
    const rows = firstStatement<CollectionRow[]>(
      await this.connection.query(query.sql, {
        table,
        inField: field,
        inValues: values.map((value) => encodeLoneSurrogates(value).value),
        ...query.bindings,
      }),
    );
    return sortAndPageStoreItems(inRanges(inInsertionOrder<T>(rows), query.ranges), filter);
  }

  /** Accepted and a no-op: this adapter declares no field indexes. */
  async ensureIndex(collection: string, _field: string): Promise<void> {
    await this.ensureCollection(collection);
  }

  async getById<T>(collection: string, id: string): Promise<T | null> {
    const table = await this.ensureCollection(collection);
    const rows = firstStatement<CollectionRow[]>(
      await this.connection.query(`SELECT ${COLLECTION_FIELDS} FROM type::record($table, $id)`, {
        table,
        id: recordKey(id),
      }),
    );
    const row = rows[0];
    return row === undefined ? null : decodeLoneSurrogates(row.data as T, row.mirk_codec);
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    const table = await this.ensureCollection(collection);
    const data = encodeLoneSurrogates(cloneJson(item, "SurrealStoreAdapter values must be JSON-safe."));
    await this.connection.query(
      `UPSERT type::record($table, $key) SET
        mirk_ordinal = IF data = NONE { sequence::nextval('${ORDER_SEQUENCE}') } ELSE { mirk_ordinal },
        mirk_id = $id,
        mirk_codec = $codec,
        data = $data
      RETURN NONE`,
      {
        table,
        key: recordKey(item.id),
        id: item.id,
        data: data.value,
        codec: data.marker,
      },
    );
    return item;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const table = await this.ensureCollection(collection);
    const rows = firstStatement<unknown[]>(
      await this.connection.query("DELETE type::record($table, $id) RETURN BEFORE", {
        table,
        id: recordKey(id),
      }),
    );
    return rows.length > 0;
  }

  async count(collection: string, filter?: StoreFilter): Promise<number> {
    const table = await this.ensureCollection(collection);
    const query = buildCountQuery(filter);
    if (query.ranges.length > 0) return (await this.list(collection, { where: filter?.where })).length;
    const rows = firstStatement<CountRow[]>(
      await this.connection.query(query.sql, { table, ...query.bindings }),
    );
    return Number(rows[0]?.count ?? 0);
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.defineTable(KV_TABLE);
    await this.connection.query(`DEFINE SEQUENCE IF NOT EXISTS ${ORDER_SEQUENCE}`);
    this.initialized = true;
  }

  private async ensureCollection(collection: string): Promise<string> {
    const table = collectionTable(collection);
    let defined = this.initializedCollections.get(table);
    if (defined === undefined) {
      defined = this.defineTable(table);
      this.initializedCollections.set(table, defined);
      defined.catch(() => this.initializedCollections.delete(table));
    }
    await defined;
    return table;
  }

  private async defineTable(table: string): Promise<void> {
    await this.connection.query(`DEFINE TABLE IF NOT EXISTS ${assertSafeTableIdentifier(table)} SCHEMALESS`);
  }
}

/** SurrealDB rejects an empty string as a record id, so the empty id is stored
 *  under the array key `[""]`, which no string id can equal. */
function recordKey(id: string): string | string[] {
  return id === "" ? [""] : id;
}

/**
 * Rows with an ordinal come in ordinal order. Rows without a usable ordinal were
 * written before ordinals existed; they come first, in code point order of their
 * id, because they predate every row that has one.
 */
function inInsertionOrder<T>(rows: CollectionRow[]): T[] {
  return rows
    .map((row) => ({ row, ordinal: ordinalOf(row.mirk_ordinal), id: idOf(row) }))
    .sort((a, b) => {
      if (a.ordinal === undefined || b.ordinal === undefined) {
        if (a.ordinal !== b.ordinal) return a.ordinal === undefined ? -1 : 1;
        return compareCodePoints(a.id, b.id);
      }
      return a.ordinal - b.ordinal || compareCodePoints(a.id, b.id);
    })
    .map(({ row }) => decodeLoneSurrogates(row.data as T, row.mirk_codec));
}

function ordinalOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function idOf(row: CollectionRow): string {
  return typeof row.mirk_id === "string" ? row.mirk_id : "";
}

type Range = readonly [field: string, condition: WhereCondition & { kind: "range" }];

interface Query {
  sql: string;
  bindings: Record<string, unknown>;
  /** Range conditions, applied to the fetched rows. */
  ranges: Range[];
}

function buildSelectQuery(filter?: StoreFilter, baseWhere?: string): Query {
  const where = buildWhereClauses(filter, baseWhere);
  return {
    sql: `SELECT ${COLLECTION_FIELDS} FROM type::table($table)${where.clause}`,
    bindings: where.bindings,
    ranges: where.ranges,
  };
}

function buildCountQuery(filter?: StoreFilter): Query {
  const where = buildWhereClauses(filter);
  return {
    sql: `SELECT count() FROM type::table($table)${where.clause} GROUP ALL`,
    bindings: where.bindings,
    ranges: where.ranges,
  };
}

function buildWhereClauses(
  filter?: StoreFilter,
  baseWhere?: string,
): { clause: string; bindings: Record<string, unknown>; ranges: Range[] } {
  const clauses: string[] = [];
  const bindings: Record<string, unknown> = {};
  const ranges: Range[] = [];
  if (baseWhere) clauses.push(baseWhere);

  for (const [index, [field, value]] of Object.entries(filter?.where ?? {}).entries()) {
    const condition = whereCondition(value);
    const fieldKey = `whereField${index}`;
    bindings[fieldKey] = field;
    if (condition.kind === "range") {
      clauses.push(`$${fieldKey} INSIDE object::keys(data)`);
      ranges.push([field, condition]);
      continue;
    }
    const valueKey = `whereValue${index}`;
    clauses.push(`$${fieldKey} INSIDE object::keys(data) AND data[$${fieldKey}] = $${valueKey}`);
    bindings[valueKey] = encodeLoneSurrogates(value).value;
  }

  return {
    clause: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`,
    bindings,
    ranges,
  };
}

function inRanges<T>(items: T[], ranges: Range[]): T[] {
  if (ranges.length === 0) return items;
  return items.filter((item) =>
    ranges.every(([field, condition]) => inRange((item as Record<string, unknown>)[field], condition)),
  );
}
