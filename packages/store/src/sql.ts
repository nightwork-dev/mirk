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
 *  accept. Booleans are pre-converted to 0/1 by the builders (better-sqlite3 rejects
 *  a raw boolean), so they never appear here. */
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

export function buildWhereClause(filter?: StoreFilter): { clause: string; params: SqlParam[] } {
  if (!filter?.where || Object.keys(filter.where).length === 0) {
    return { clause: "", params: [] };
  }
  const conditions: string[] = [];
  const params: SqlParam[] = [];
  for (const [key, value] of Object.entries(filter.where)) {
    const path = jsonPath(key);
    if (value === null) {
      // The in-memory reference matches a field whose value IS null, not a missing
      // field (`record[key] !== null` is false only for an explicit null). `= NULL`
      // never matches in SQL, so test the JSON type: json_type is `'null'` ONLY for
      // an explicit JSON null, and SQL NULL (not 'null') for a missing path.
      conditions.push(`json_type(data, ?) = 'null'`);
      params.push(path);
    } else {
      const bound = typeof value === "boolean" ? (value ? 1 : 0) : value;
      conditions.push(`json_extract(data, ?) = ?`);
      params.push(path, bound as string | number);
    }
  }
  return { clause: ` WHERE ${conditions.join(" AND ")}`, params };
}

export function buildOrderBy(filter?: StoreFilter): { clause: string; params: SqlParam[] } {
  if (!filter?.sortBy) return { clause: "", params: [] };
  const dir = filter.sortDir === "desc" ? "DESC" : "ASC";
  const path = jsonPath(filter.sortBy);
  // `... IS NULL` first puts null/missing fields LAST in BOTH directions, matching
  // the in-memory reference (which pushes undefined/null after defined values).
  return {
    clause: ` ORDER BY json_extract(data, ?) IS NULL, json_extract(data, ?) ${dir}`,
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
