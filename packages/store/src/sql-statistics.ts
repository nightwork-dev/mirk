// ─── Query statistics for SQLite-dialect adapters ───────────────────────────
// SQLite picks an index from the statistics `ANALYZE` stores in sqlite_stat1.
// With none, it guesses, and on a filter over two indexed fields it can pick the
// one that matches most of the table. This module is the one rule every
// SQLite-dialect adapter uses to keep those statistics fresh. Like
// `tableResolution`, it yields the statements it needs, so the synchronous and
// asynchronous adapters share one definition.
//
// From SQLite 3.46.0 the engine has the rule itself: `PRAGMA optimize` checks
// every table (mask 0x10000), analyzes a table whose indexes have no statistics
// or whose row count changed tenfold since its last ANALYZE, and bounds that
// ANALYZE with a temporary analysis limit (https://sqlite.org/pragma.html#pragma_optimize).
// Older engines, such as libSQL's 3.45, analyze only tables the current
// connection has queried and do not bound the work, so for them this module
// runs a bounded ANALYZE on the tables that need it.

/** What started a statistics refresh. */
export type StatisticsRefreshReason = "open" | "index" | "writes" | "close" | "request";

/** What one statistics refresh did. */
export interface StatisticsRefresh {
  readonly reason: StatisticsRefreshReason;
  /** Physical tables whose statistics were rebuilt. Empty when none needed it. */
  readonly tables: readonly string[];
  readonly durationMs: number;
  /** Set when an automatic refresh did not run, for example because another
   *  connection held the write lock. The next trigger tries again. */
  readonly skipped?: string;
}

/** An automatic refresh is considered after this many rows have changed on a
 *  connection since its last refresh. The check itself costs microseconds; the
 *  engine then decides whether any table needs ANALYZE. */
export const DEFAULT_REFRESH_STATISTICS_AFTER_CHANGES = 1_000;

/** The rows ANALYZE reads per index on an engine older than 3.46.0, which does
 *  not bound the work itself. SQLite suggests 100 or 1000. */
export const LEGACY_ANALYSIS_LIMIT = 1_000;

/** True when the engine's `PRAGMA optimize` checks every table and bounds its
 *  own ANALYZE (SQLite 3.46.0 and later). */
export function engineOptimizeIsBounded(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return major > 3 || (major === 3 && minor >= 46);
}

/** Validate the `refreshStatisticsAfterChanges` option: a whole number, 0 to
 *  turn automatic refreshes off. */
export function resolveRefreshStatisticsAfterChanges(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REFRESH_STATISTICS_AFTER_CHANGES;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("refreshStatisticsAfterChanges must be a whole number of rows, 0 or more.");
  }
  return value;
}

/** One statement the refresh needs run. The driver sends back its rows as
 *  plain objects (an empty array for a statement that returns none). */
export interface StatisticsStatement {
  readonly sql: string;
}

export interface StatisticsOutcome {
  readonly tables: string[];
  /** Rows the statistics describe after the refresh, summed over tables. */
  readonly rowsDescribed: number;
}

const ROWS_DESCRIBED_SQL =
  "SELECT coalesce(sum(n), 0) AS n FROM (SELECT max(CAST(stat AS INTEGER)) AS n FROM sqlite_stat1 GROUP BY tbl)";
const STAT_TABLE_SQL = "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'";
const INDEXED_TABLES_SQL =
  "SELECT DISTINCT tbl_name AS name FROM sqlite_master WHERE type = 'index' AND tbl_name NOT LIKE 'sqlite_%'";
const UNANALYZED_TABLES_SQL =
  "SELECT DISTINCT m.tbl_name AS name FROM sqlite_master m WHERE m.type = 'index' AND m.tbl_name NOT LIKE 'sqlite_%' " +
  "AND NOT EXISTS (SELECT 1 FROM sqlite_stat1 s WHERE s.idx = m.name)";

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function firstValue(row: unknown): unknown {
  if (row === null || typeof row !== "object") return undefined;
  return Object.values(row as Record<string, unknown>)[0];
}

/** Table names from `PRAGMA optimize` debug rows: `ANALYZE "main"."t"`. */
export function tablesFromOptimizePlan(rows: readonly unknown[]): string[] {
  const tables: string[] = [];
  for (const row of rows) {
    const text = firstValue(row);
    if (typeof text !== "string") continue;
    const match = /^ANALYZE\s+"[^"]*(?:""[^"]*)*"\."((?:[^"]|"")*)"/.exec(text);
    if (match) tables.push(match[1]!.replaceAll('""', '"'));
  }
  return tables;
}

/**
 * Refresh query statistics. On SQLite 3.46.0 and later this is the engine's
 * own `PRAGMA optimize`: mask 0x10002 checks every table, and at close the
 * default mask runs as SQLite recommends. A debug pass (mask bit 0x01) first
 * names the tables, so the caller can report them.
 *
 * On an older engine a table is analyzed when it has an index and rows, and
 * either an index has no statistics, the caller asked, or (after writes) this
 * connection changed at least as many rows as the statistics describe. The
 * ANALYZE runs under `LEGACY_ANALYSIS_LIMIT`, and the connection's previous
 * analysis limit is restored afterwards (not when a statement fails).
 */
export function* statisticsRefresh(
  engineVersion: string,
  reason: StatisticsRefreshReason,
  changesSinceRefresh: number,
  rowsDescribed: number,
): Generator<StatisticsStatement, StatisticsOutcome, readonly unknown[]> {
  if (engineOptimizeIsBounded(engineVersion)) {
    const mask = reason === "close" ? 0xfffe : 0x10002;
    const planned = tablesFromOptimizePlan(yield { sql: `PRAGMA optimize(${mask | 1})` });
    if (planned.length > 0) yield { sql: `PRAGMA optimize(${mask})` };
    return { tables: planned, rowsDescribed };
  }

  const hasStats = (yield { sql: STAT_TABLE_SQL }).length > 0;
  const everyTable = reason === "request" || !hasStats || (reason === "writes" && changesSinceRefresh >= rowsDescribed);
  const candidates = (yield { sql: everyTable ? INDEXED_TABLES_SQL : UNANALYZED_TABLES_SQL })
    .map(firstValue)
    .filter((name): name is string => typeof name === "string");
  const tables: string[] = [];
  for (const table of candidates) {
    if ((yield { sql: `SELECT 1 AS ok FROM ${quoteIdent(table)} LIMIT 1` }).length > 0) tables.push(table);
  }
  if (tables.length === 0) return { tables, rowsDescribed };
  const previous = Number(firstValue((yield { sql: "PRAGMA analysis_limit" })[0]) ?? 0);
  yield { sql: `PRAGMA analysis_limit = ${LEGACY_ANALYSIS_LIMIT}` };
  for (const table of tables) yield { sql: `ANALYZE ${quoteIdent(table)}` };
  yield { sql: `PRAGMA analysis_limit = ${Number.isSafeInteger(previous) && previous >= 0 ? previous : 0}` };
  const described = Number(firstValue((yield { sql: ROWS_DESCRIBED_SQL })[0]) ?? 0);
  return { tables, rowsDescribed: Number.isFinite(described) ? described : 0 };
}

/** The statement that reads how many rows this connection has changed since
 *  it opened. */
export const TOTAL_CHANGES_SQL = "SELECT total_changes() AS n";
