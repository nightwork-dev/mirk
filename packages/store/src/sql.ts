// ─── @mirk/store/sql ─────────────────────────────────────────────────────────
// Pure SQL-string builders for the JSON-document KV collection layer, SHARED by
// every SQLite-dialect source adapter: the better-sqlite3 `@mirk/store/sqlite`
// adapter and the libSQL `@mirk/store-libsql` adapter. They both speak identical
// JSON1 semantics (json_extract / json_type / LIKE ESCAPE), so a single definition
// keeps them in lockstep — a divergent copy is a silent filter-semantics bug.
//
// ZERO driver deps: returns SQL text + bind params as plain values, so importing
// it can never drag better-sqlite3 or @libsql/client into a consumer's graph.

import { compareCodePoints } from "./order.js";
import type { StoreFilter } from "./types.js";

/** A bound SQL parameter — the common subset both better-sqlite3 and @libsql/client
 *  accept. Booleans never appear here (better-sqlite3 rejects a raw boolean): `where`
 *  compares them by json_type alone, and the IN builder writes them as SQL 1/0. */
export type SqlParam = string | number | bigint | null;

/** A field name is ONE top-level JSON key, never a nested path. Build the JSON path
 *  `$."field"` so a dotted name (`"a.b"`) resolves to the single top-level key `a.b`,
 *  matching the in-memory reference's `record[key]` lookup — not the nested path
 *  `$.a.b`. SQLite decodes a quoted path label as a JSON string, so the label is
 *  written as one, with JSON escapes for `\` and control characters. A `"` is
 *  written `\u0022`: SQLite 3.45, libSQL's engine, ends the label at `\"`. */
export function jsonPath(field: string): string {
  return `$."${JSON.stringify(field).slice(1, -1).replaceAll('\\"', "\\u0022")}"`;
}

/** The message BOTH backends raise for a `where` value that is not a JSON scalar.
 *  There is no deep equality anywhere in the port, so an object or array value is
 *  a caller error rather than a filter that matches nothing. */
export const NON_SCALAR_FILTER_MESSAGE = "Store filters only support JSON scalar values.";

export const INVALID_RANGE_BOUND_MESSAGE = "Store range bounds must be finite numbers or strings.";
export const NON_FINITE_NUMBER_MESSAGE = "Store filters only support finite numbers.";

/** The most values one `listWhereIn` call takes. Each is one bound parameter on
 *  SQLite and libSQL, whose limit is 32,766 per statement; PostgreSQL binds one
 *  array. One limit for every backend keeps a call portable. */
export const MAX_IN_VALUES = 10_000;
export const TOO_MANY_IN_VALUES_MESSAGE = `Store IN queries accept at most ${MAX_IN_VALUES} values.`;

export type StoreFilterErrorCode =
  | "non-scalar-filter"
  | "non-scalar-in-value"
  | "invalid-range-bound"
  | "non-finite-number"
  | "too-many-in-values";

/** Thrown for a `where` or IN value that is not a JSON scalar or a range, a
 *  number that is not finite, a range bound that is not a finite number or a
 *  string, and an IN list longer than `MAX_IN_VALUES`. */
export class StoreFilterError extends Error {
  declare readonly name: "StoreFilterError";
  constructor(readonly code: StoreFilterErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(StoreFilterError.prototype, "name", {
  value: "StoreFilterError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export type StoreRangeOperator = "gt" | "gte" | "lt" | "lte";

/** A `where` value that compares instead of matching exactly:
 *  `{ seenAt: { gte: since } }`. A number bound compares only numbers, a string
 *  bound only strings by code point, and null or missing never match. */
export type StoreRange = { readonly [operator in StoreRangeOperator]?: number | string };

export const STORE_RANGE_OPERATORS: readonly StoreRangeOperator[] = ["gt", "gte", "lt", "lte"];

/** One `where` entry, classified. */
export type WhereCondition =
  | { readonly kind: "equals"; readonly value: string | number | bigint | boolean | null }
  | { readonly kind: "range"; readonly bounds: readonly (readonly [StoreRangeOperator, number | string])[] };

/** Classify a `where` value. A plain object whose keys are all range operators
 *  is a range; any other non-scalar is the `non-scalar-filter` error, and a range
 *  bound that is not a finite number or a string is `invalid-range-bound`. */
export function whereCondition(value: unknown): WhereCondition {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new StoreFilterError("non-finite-number", NON_FINITE_NUMBER_MESSAGE);
    }
    return { kind: "equals", value };
  }
  if (typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new StoreFilterError("non-scalar-filter", NON_SCALAR_FILTER_MESSAGE);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([key]) => (STORE_RANGE_OPERATORS as readonly string[]).includes(key))) {
    throw new StoreFilterError("non-scalar-filter", NON_SCALAR_FILTER_MESSAGE);
  }
  const bounds = entries.map(([operator, bound]) => {
    if (typeof bound === "string" || (typeof bound === "number" && Number.isFinite(bound))) {
      return [operator as StoreRangeOperator, bound] as const;
    }
    throw new StoreFilterError("invalid-range-bound", INVALID_RANGE_BOUND_MESSAGE);
  });
  return { kind: "range", bounds };
}

/** Validate every `where` value up front, so a bad filter throws even when the
 *  collection is empty. */
export function assertWhere(where: Record<string, unknown>): void {
  for (const value of Object.values(where)) whereCondition(value);
}

/** True when a stored value lies inside every bound of a range. */
export function inRange(stored: unknown, bounds: WhereCondition & { kind: "range" }): boolean {
  return bounds.bounds.every(([operator, bound]) => {
    let order: number;
    if (typeof bound === "number") {
      if (typeof stored !== "number") return false;
      order = stored < bound ? -1 : stored > bound ? 1 : 0;
    } else {
      if (typeof stored !== "string") return false;
      order = compareCodePoints(stored, bound);
    }
    if (operator === "gt") return order > 0;
    if (operator === "gte") return order >= 0;
    if (operator === "lt") return order < 0;
    return order <= 0;
  });
}

const RANGE_SQL: Record<StoreRangeOperator, string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" };

export function buildWhereClause(filter?: StoreFilter): { clause: string; params: SqlParam[] } {
  if (!filter?.where || Object.keys(filter.where).length === 0) {
    return { clause: "", params: [] };
  }
  const conditions: string[] = [];
  const params: SqlParam[] = [];
  for (const [key, value] of Object.entries(filter.where)) {
    const path = jsonPathLiteral(key);
    const extract = `json_extract(data, ${path})`;
    const type = `json_type(data, ${path})`;
    // Every comparison leads with `json_extract(data, <literal>)`, so an expression
    // index on it (see `buildEnsureIndexSql`) can serve it, and is guarded by
    // json_type: json_extract collapses a JSON boolean to SQL 1/0, and the
    // reference keeps `true` and `1` apart. json_type is `'null'` only for an
    // explicit JSON null and SQL NULL for a missing path, so null never matches
    // a missing field.
    const condition = whereCondition(value);
    if (condition.kind === "range") {
      // `unlikely` tells the planner a range is selective. Without ANALYZE
      // statistics it would otherwise scan in rowid order to skip the sort.
      for (const [operator, bound] of condition.bounds) {
        conditions.push(`unlikely(${extract} ${RANGE_SQL[operator]} ?)`);
        params.push(bound);
      }
      const kinds = new Set(condition.bounds.map(([, bound]) => typeof bound));
      // A number bound compares only numbers and a string bound only strings, so
      // bounds of both kinds match nothing.
      conditions.push(kinds.size > 1 ? "0" : kinds.has("number") ? `${type} IN ('integer', 'real')` : `${type} = 'text'`);
      continue;
    }
    const match = condition.value;
    if (match === null) {
      conditions.push(`${extract} IS NULL AND ${type} = 'null'`);
    } else if (typeof match === "boolean") {
      conditions.push(`${extract} = ${match ? 1 : 0} AND ${type} = '${match}'`);
    } else if (typeof match === "string") {
      conditions.push(`${extract} = ? AND ${type} = 'text'`);
      params.push(match);
    } else {
      conditions.push(`${extract} = ? AND ${type} IN ('integer', 'real')`);
      params.push(match);
    }
  }
  return { clause: ` WHERE ${conditions.join(" AND ")}`, params };
}

/** The name of the expression index `ensureIndex` declares on one collection
 *  table: `ix_<table>_<hex of the field's UTF-8>`. The hex holds no `_`, so the
 *  last `_` splits the name back into table and field: two declarations never
 *  share a name. The Python port derives the same name, so each language sees
 *  the other's index as already present. */
export function indexNameFor(table: string, field: string): string {
  let hex = "";
  for (const byte of new TextEncoder().encode(field)) hex += byte.toString(16).padStart(2, "0");
  return `ix_${table}_${hex}`;
}

/** The one idempotent statement behind `ensureIndex(collection, field)`: an
 *  expression index over the same `json_extract(data, <literal>)` that where,
 *  listWhereIn and sortBy write. */
export function buildEnsureIndexSql(table: string, field: string): string {
  return `CREATE INDEX IF NOT EXISTS ${indexNameFor(table, field)} ON ${table} (json_extract(data, ${jsonPathLiteral(field)}))`;
}

/** `jsonPath(field)` as a quoted SQL string literal, for SQL that must name the
 *  path in its text: an expression index on `json_extract(data, <literal>)` only
 *  serves a query that spells the same literal, never a bound parameter. Single
 *  quotes are doubled, which is the only escape a SQLite string literal has, and
 *  the JSON escapes in `jsonPath` leave no NUL or other raw control character. */
export function jsonPathLiteral(field: string): string {
  return `'${jsonPath(field).replace(/'/g, "''")}'`;
}

export const NON_SCALAR_IN_MESSAGE = "Store IN queries only support JSON scalar values.";

/** Validate a `listWhereIn` value list: at most `MAX_IN_VALUES` values, each a
 *  JSON scalar, each number finite. */
export function assertInValues(values: readonly unknown[]): void {
  if (values.length > MAX_IN_VALUES) {
    throw new StoreFilterError("too-many-in-values", TOO_MANY_IN_VALUES_MESSAGE);
  }
  for (const value of values) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new StoreFilterError("non-finite-number", NON_FINITE_NUMBER_MESSAGE);
    } else if (value !== null && typeof value !== "string" && typeof value !== "bigint" && typeof value !== "boolean") {
      throw new StoreFilterError("non-scalar-in-value", NON_SCALAR_IN_MESSAGE);
    }
  }
}

/** The `listWhereIn` condition as one index-friendly expression.
 *
 *  Strings and numbers go into a single `json_extract(data, path) IN (...)`.
 *  SQLite never equates a TEXT with an INTEGER or REAL, so "1" and 1 stay apart
 *  without help, but json_extract collapses a JSON boolean to 1/0; the
 *  `json_type ... IN ('integer', 'real', 'text')` guard keeps a stored true out
 *  of `[1]`. A boolean value is its own `= 1`/`= 0` term guarded by its
 *  json_type, and null is `IS NULL` guarded by `json_type = 'null'`, which a
 *  missing field (json_type SQL NULL) never satisfies. Every term leads with
 *  `json_extract(data, path)`, so an expression index on it serves each one.
 *
 *  The path is inlined as a literal so that index can match; see
 *  `jsonPathLiteral`. */
export function buildInClause(
  field: string,
  values: readonly unknown[],
  hasPriorWhere: boolean,
): { clause: string; params: SqlParam[] } {
  assertInValues(values);
  const path = jsonPathLiteral(field);
  const scalars: SqlParam[] = [];
  const kinds = new Set<"true" | "false" | "null">();
  for (const value of values) {
    if (value === null) kinds.add("null");
    else if (typeof value === "boolean") kinds.add(value ? "true" : "false");
    else scalars.push(value as string | number | bigint);
  }

  const extract = `json_extract(data, ${path})`;
  const type = `json_type(data, ${path})`;
  const terms: string[] = [];
  const params: SqlParam[] = [];
  if (scalars.length > 0) {
    terms.push(`(${extract} IN (${scalars.map(() => "?").join(", ")}) AND ${type} IN ('integer', 'real', 'text'))`);
    params.push(...scalars);
  }
  for (const kind of kinds) {
    const match = kind === "null" ? "IS NULL" : kind === "true" ? "= 1" : "= 0";
    terms.push(`(${extract} ${match} AND ${type} = '${kind}')`);
  }
  const condition = terms.length === 1 ? terms[0]! : `(${terms.join(" OR ")})`;
  return { clause: `${hasPriorWhere ? " AND" : " WHERE"} ${condition}`, params };
}

export function buildOrderBy(filter?: StoreFilter): { clause: string; params: SqlParam[] } {
  // `rowid` is the FINAL key so ties resolve to insertion order, matching the
  // in-memory reference's stable sort. With no `sortBy` it is the only key, which
  // pins the default `list()` order to insertion order instead of leaving it to
  // whatever the query planner happens to scan.
  if (!filter?.sortBy) return { clause: " ORDER BY rowid", params: [] };
  const dir = filter.sortDir === "desc" ? "DESC" : "ASC";
  // NULLS LAST puts null and missing fields last in BOTH directions, matching
  // the in-memory reference, and unlike a leading `IS NULL` key it lets an
  // expression index on the same literal deliver the order.
  return {
    clause: ` ORDER BY json_extract(data, ${jsonPathLiteral(filter.sortBy)}) ${dir} NULLS LAST, rowid`,
    params: [],
  };
}

export function buildLimitOffset(filter?: StoreFilter): string {
  let sql = "";
  if (filter?.limit !== undefined) {
    sql += ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`;
  }
  if (filter?.offset !== undefined && filter.offset > 0) {
    if (!sql.includes("LIMIT")) sql += " LIMIT -1";
    sql += ` OFFSET ${Math.max(0, Math.floor(filter.offset))}`;
  }
  return sql;
}

/** Deterministic 32-bit FNV-1a hash → base36. Used to make collection table names
 *  injective (distinct collection names never alias to one physical table). */
export function hashName(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ─── Physical table registry (`_mirk_tables`) ────────────────────────────────
// A hash cannot be injective, so a hash-derived physical table name aliases two
// logical names sooner or later (`"%$;**@"` and `"~,~$(*"` both sanitize to
// `______` and both hash to `jqoxun`). Injectivity comes from a REGISTRY table
// that records the mapping, with the hash-derived name kept only as the first
// candidate so files written before the registry existed keep working.
//
// The procedure below is shared verbatim by @mirk/store/sqlite (sync,
// better-sqlite3) and @mirk/store-libsql (async, @libsql/client). It is written
// as a generator that YIELDS the queries it needs, so the one correctness-
// critical loop has exactly one definition and each adapter only supplies a
// six-line driver in its own execution model.

/** The `_mirk_meta.schema_version` this build writes and understands. */
export const MIRK_SCHEMA_VERSION = 2;

export const MIRK_REGISTRY_DDL = `
  CREATE TABLE IF NOT EXISTS _mirk_tables (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    table_name TEXT NOT NULL UNIQUE,
    PRIMARY KEY (kind, name)
  );
  CREATE TABLE IF NOT EXISTS _mirk_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export const SELECT_SCHEMA_VERSION_SQL =
  "SELECT value FROM _mirk_meta WHERE key = 'schema_version'";
export const INSERT_SCHEMA_VERSION_SQL =
  "INSERT OR IGNORE INTO _mirk_meta (key, value) VALUES ('schema_version', ?)";
export const SELECT_REGISTERED_TABLE_SQL =
  "SELECT table_name FROM _mirk_tables WHERE kind = ? AND name = ?";
/** `table_name` is UNIQUE across every kind, so the claim check is global. */
export const SELECT_TABLE_CLAIM_SQL =
  "SELECT kind, name FROM _mirk_tables WHERE table_name = ?";
export const INSERT_REGISTERED_TABLE_SQL =
  "INSERT INTO _mirk_tables (kind, name, table_name) VALUES (?, ?, ?)";
export const SELECT_TABLE_EXISTS_SQL =
  "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?";

/** Registry `kind` values. Collections and search docs tables are namespaced
 *  separately because they carry different prefixes for the same logical name. */
export const COLLECTION_TABLE_KIND = "collection";
export const SEARCH_TABLE_KIND = "search";
export const COLLECTION_TABLE_PREFIX = "c_";
export const SEARCH_DOCS_TABLE_PREFIX = "search_docs_";
export const SEARCH_FTS_TABLE_PREFIX = "search_fts_";

/** The pre-registry physical name: `<prefix><sanitized>_<fnv32>`. Still the
 *  FIRST candidate, which is what makes an existing file adoptable in place. */
export function legacyTableName(prefix: string, name: string): string {
  return `${prefix}${name.replace(/[^a-zA-Z0-9_]/g, "_")}_${hashName(name)}`;
}

/** Attempt 1 is the legacy name itself; later attempts append `_2`, `_3`, … */
export function candidateTableName(legacy: string, attempt: number): string {
  return attempt <= 1 ? legacy : `${legacy}_${attempt}`;
}

/** The FTS5 table paired with a search docs table. Derived from the docs name
 *  rather than resolved separately, so one registry row governs both. */
export function ftsTableFor(docsTable: string): string {
  return `${SEARCH_FTS_TABLE_PREFIX}${docsTable.slice(SEARCH_DOCS_TABLE_PREFIX.length)}`;
}

export function schemaVersionTooNewMessage(found: string, supported: number): string {
  return `Mirk SQLite file schema version ${found} is newer than this adapter understands (${supported}).`;
}

/** A version string is "too new" only when it PARSES to a larger number. An
 *  unparseable value is left to the adapter that wrote it rather than turned
 *  into a refusal to open. */
export function isSchemaVersionTooNew(
  found: string | null | undefined,
  supported: number = MIRK_SCHEMA_VERSION,
): boolean {
  if (found === null || found === undefined) return false;
  const parsed = Number.parseInt(found, 10);
  return Number.isFinite(parsed) && parsed > supported;
}

/** One query the resolution procedure needs answered. */
export type TableRegistryQuery =
  | { readonly q: "registered"; readonly kind: string; readonly name: string }
  | { readonly q: "claimant"; readonly table: string }
  | { readonly q: "tableExists"; readonly table: string }
  | {
      readonly q: "register";
      readonly kind: string;
      readonly name: string;
      readonly table: string;
    };

/** The answer shapes, in the same order: the recorded table name or undefined,
 *  the claiming logical name or undefined, whether the physical table exists,
 *  and nothing for a `register`. */
export type TableRegistryAnswer = string | undefined | boolean | void;

/**
 * Resolve the physical table for one logical name. Three steps:
 *
 *   1. Registry hit — use the recorded `table_name`.
 *   2. Miss, and the legacy `<prefix><sanitized>_<fnv32>` table is unclaimed —
 *      take it. An existing table there was written by a pre-registry adapter
 *      under THIS name, so taking it adopts the data and a file keeps working
 *      without a rewrite. The legacy name is the ONLY adoptable candidate.
 *   3. Legacy name claimed by a different logical name — append `_2`, `_3`, …
 *      A suffixed candidate is skipped when it is claimed by another name OR
 *      when a physical table already exists there without a registry row. Such
 *      a table is a stray from an interrupted run and holds rows this name has
 *      no claim to; `CREATE TABLE IF NOT EXISTS` would silently adopt them.
 *
 * `register` false answers the same question WITHOUT writing, for read paths
 * that must not create a registry row for a collection that may not exist.
 */
export function* tableResolution(
  kind: string,
  name: string,
  prefix: string,
  register: boolean,
): Generator<TableRegistryQuery, string, TableRegistryAnswer> {
  const recorded = (yield { q: "registered", kind, name }) as string | undefined;
  if (recorded !== undefined) return recorded;

  const legacy = legacyTableName(prefix, name);
  const legacyClaim = (yield { q: "claimant", table: legacy }) as string | undefined;
  if (legacyClaim === undefined) {
    if (register) yield { q: "register", kind, name, table: legacy };
    return legacy;
  }

  for (let attempt = 2; ; attempt++) {
    const candidate = candidateTableName(legacy, attempt);
    const claim = (yield { q: "claimant", table: candidate }) as string | undefined;
    if (claim !== undefined) continue;
    const exists = (yield { q: "tableExists", table: candidate }) as boolean;
    if (exists) continue;
    if (register) yield { q: "register", kind, name, table: candidate };
    return candidate;
  }
}

/** True for the constraint error two processes can produce when both resolve the
 *  same new logical name at once: one INSERT wins, the other violates
 *  `_mirk_tables`'s primary key or its UNIQUE `table_name`. The loser must
 *  RESTART resolution — the winner's row is now a registry hit — rather than
 *  surface a constraint error from an ordinary `put`. */
export function isTableRegistryConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("constraint failed") && message.includes("_mirk_tables");
}
