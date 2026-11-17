// Keeps one synchronous SQLite connection's query statistics fresh, by the
// rule in `../sql-statistics.ts`. Shared by the better-sqlite3 and node:sqlite
// adapters through `SqliteAdapterCore`.

import type { SqliteDb } from "./sqlite-driver.js";
import {
  statisticsRefresh,
  TOTAL_CHANGES_SQL,
  type StatisticsRefresh,
  type StatisticsRefreshReason,
} from "../sql-statistics.js";

/** Run one statement and return its rows. better-sqlite3 refuses `all()` on a
 *  statement that returns no data, and marks those `reader: false`. */
function rowsOf(db: SqliteDb, sql: string): readonly unknown[] {
  const statement = db.prepare(sql) as ReturnType<SqliteDb["prepare"]> & { reader?: boolean };
  if (statement.reader === false) {
    statement.run();
    return [];
  }
  return statement.all();
}

export class SqliteStatistics {
  private readonly engineVersion: string;
  private changesAtRefresh = 0;
  private rowsDescribed = 0;
  private lastRefresh: StatisticsRefresh | undefined;
  private pending: StatisticsRefreshReason | undefined;

  constructor(
    private readonly db: SqliteDb,
    private readonly afterChanges: number,
    private readonly busyTimeoutMs: number,
  ) {
    this.engineVersion = String((db.prepare("SELECT sqlite_version() AS v").get() as { v: unknown }).v);
  }

  get last(): StatisticsRefresh | undefined {
    return this.lastRefresh;
  }

  /** Refresh now. Waits for the write lock like any write, and throws if the
   *  refresh fails. */
  refresh(): StatisticsRefresh {
    return this.run("request");
  }

  /** An automatic refresh. It waits for no other writer and never throws: a
   *  failure is reported in `last.skipped`, and the next trigger tries again.
   *  Off when `afterChanges` is 0. Inside a transaction it waits for the
   *  commit. */
  auto(reason: StatisticsRefreshReason): void {
    if (this.afterChanges === 0) return;
    if (this.db.inTransaction) {
      this.pending ??= reason;
      return;
    }
    this.pending = undefined;
    const started = performance.now();
    try {
      this.db.pragma("busy_timeout = 0");
      try {
        this.run(reason);
      } finally {
        this.db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);
      }
    } catch (error) {
      this.lastRefresh = {
        reason,
        tables: [],
        durationMs: performance.now() - started,
        skipped: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Called after each outermost transaction: refreshes once this connection
   *  has changed `afterChanges` rows since the last refresh. */
  afterWrite(): void {
    if (this.afterChanges === 0 || this.db.inTransaction) return;
    if (this.pending !== undefined) this.auto(this.pending);
    else if (this.totalChanges() - this.changesAtRefresh >= this.afterChanges) this.auto("writes");
  }

  private totalChanges(): number {
    return Number((this.db.prepare(TOTAL_CHANGES_SQL).get() as { n: number | bigint }).n);
  }

  private run(reason: StatisticsRefreshReason): StatisticsRefresh {
    const started = performance.now();
    const plan = statisticsRefresh(
      this.engineVersion,
      reason,
      this.totalChanges() - this.changesAtRefresh,
      this.rowsDescribed,
    );
    let step = plan.next();
    while (!step.done) step = plan.next(rowsOf(this.db, step.value.sql));
    this.rowsDescribed = step.value.rowsDescribed;
    this.changesAtRefresh = this.totalChanges();
    this.lastRefresh = { reason, tables: step.value.tables, durationMs: performance.now() - started };
    return this.lastRefresh;
  }
}
