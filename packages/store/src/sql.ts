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
 * Resolve the physical table for one logical name. Three steps, per the port
 * ruling:
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
