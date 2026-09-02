// ─── @mirk/store/sql ─────────────────────────────────────────────────────────
// Pure SQL-string builders for the JSON-document KV collection layer, SHARED by
// every SQLite-dialect source adapter: the better-sqlite3 `@mirk/store/sqlite`
// adapter and the libSQL `@mirk/store-libsql` adapter. They both speak identical
// JSON1 semantics (json_extract / json_type / LIKE ESCAPE), so a single definition
// keeps them in lockstep — a divergent copy is a silent filter-semantics bug.
//
// ZERO driver deps: returns SQL text + bind params as plain values, so importing
// it can never drag better-sqlite3 or @libsql/client into a consumer's graph.

import type { StoreFilter } from "./types.js";

/** A bound SQL parameter — the common subset both better-sqlite3 and @libsql/client
 *  accept. Booleans never appear here: `where` compares them by json_type alone, and
 *  the IN builder converts them to 0/1 (better-sqlite3 rejects a raw boolean). */
export type SqlParam = string | number | bigint | null;

/** A field name is ONE top-level JSON key, never a nested path. Build the JSON path
 *  `$."field"` (with `"` in the field doubled per SQLite JSON-path quoting) so a
 *  dotted name (`"a.b"`) resolves to the single top-level key `a.b`, matching the
 *  in-memory reference's `record[key]` lookup — not the nested path `$.a.b`. Returned
 *  as a value to BIND, never interpolated into SQL: field names are caller-supplied,
 *  so inlining them would be a SQL-injection vector. */
export function jsonPath(field: string): string {
  return `$."${field.replace(/"/g, '""')}"`;
}

/** The message BOTH backends raise for a `where` value that is not a JSON scalar.
 *  There is no deep equality anywhere in the port, so an object or array value is
 *  a caller error rather than a filter that matches nothing. */
export const NON_SCALAR_FILTER_MESSAGE = "Store filters only support JSON scalar values.";

export function buildWhereClause(filter?: StoreFilter): { clause: string; params: SqlParam[] } {
  if (!filter?.where || Object.keys(filter.where).length === 0) {
    return { clause: "", params: [] };
  }
  const conditions: string[] = [];
  const params: SqlParam[] = [];
  for (const [key, value] of Object.entries(filter.where)) {
    const path = jsonPath(key);
    // Every comparison is guarded by json_type. json_extract collapses a JSON
    // boolean to SQL 1/0, so an unguarded `= ?` makes `where {v: true}` match a
    // stored 1 and `where {v: 1}` match a stored true. The in-memory reference's
    // `record[key] !== value` keeps them apart; the type guard keeps SQLite in step.
    if (value === null) {
      // json_type is `'null'` ONLY for an explicit JSON null, and SQL NULL (not
      // the string 'null') for a missing path, so this matches an explicit null
      // and not a missing field. `= NULL` would never match at all.
      conditions.push(`json_type(data, ?) = 'null'`);
      params.push(path);
    } else if (typeof value === "boolean") {
      conditions.push(`json_type(data, ?) = '${value ? "true" : "false"}'`);
      params.push(path);
    } else if (typeof value === "string") {
      conditions.push(`json_type(data, ?) = 'text' AND json_extract(data, ?) = ?`);
      params.push(path, path, value);
    } else if (typeof value === "number" || typeof value === "bigint") {
      conditions.push(
        `json_type(data, ?) IN ('integer', 'real') AND json_extract(data, ?) = ?`,
      );
      params.push(path, path, value);
    } else {
      throw new Error(NON_SCALAR_FILTER_MESSAGE);
    }
  }
  return { clause: ` WHERE ${conditions.join(" AND ")}`, params };
}

export function buildOrderBy(filter?: StoreFilter): { clause: string; params: SqlParam[] } {
  // `rowid` is the FINAL key so ties resolve to insertion order, matching the
  // in-memory reference's stable sort. With no `sortBy` it is the only key, which
  // pins the default `list()` order to insertion order instead of leaving it to
  // whatever the query planner happens to scan.
  if (!filter?.sortBy) return { clause: " ORDER BY rowid", params: [] };
  const dir = filter.sortDir === "desc" ? "DESC" : "ASC";
  const path = jsonPath(filter.sortBy);
  // `... IS NULL` first puts null/missing fields LAST in BOTH directions, matching
  // the in-memory reference (which pushes undefined/null after defined values).
  return {
    clause: ` ORDER BY json_extract(data, ?) IS NULL, json_extract(data, ?) ${dir}, rowid`,
    params: [path, path],
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
