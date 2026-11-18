// Keeps a libSQL database's query statistics fresh, by the rule in
// `@mirk/store/sql`. A refresh runs inside a write transaction the adapter
// already holds, just before it commits, so it never waits for the write lock
// and runs on the same connection or remote stream as the work before it.

import {
  statisticsRefresh,
  type StatisticsRefresh,
  type StatisticsRefreshReason,
} from "@mirk/store/sql";

/** The statements a refresh needs, run in the open transaction. */
export interface StatisticsConnection {
  execute(sql: string): Promise<{ rows: readonly unknown[] }>;
}

const SAVEPOINT = "mirk_statistics";

export class LibsqlStatistics {
  private engineVersion: string | undefined;
  private changes = 0;
  private rowsDescribed = 0;
  private pending: StatisticsRefreshReason | undefined;
  private lastRefresh: StatisticsRefresh | undefined;

  constructor(private readonly afterChanges: number) {}

  get last(): StatisticsRefresh | undefined {
    return this.lastRefresh;
  }

  /** Count rows a transaction changed. */
  noteChanges(rows: number): void {
    this.changes += rows;
  }

  /** Ask for a refresh at the next commit, for example after a new index. */
  request(reason: StatisticsRefreshReason): void {
    if (this.afterChanges > 0) this.pending ??= reason;
  }

  /** The automatic refresh due at this commit, if any. */
  due(): StatisticsRefreshReason | undefined {
    if (this.afterChanges === 0) return undefined;
    if (this.pending !== undefined) return this.pending;
    return this.changes >= this.afterChanges ? "writes" : undefined;
  }

  /** Refresh inside the open transaction, in a savepoint so a failure leaves
   *  the transaction's own work intact. An automatic refresh reports a failure
   *  in `last.skipped`; a requested one throws it. */
  async run(open: StatisticsConnection, reason: StatisticsRefreshReason): Promise<StatisticsRefresh> {
    const started = performance.now();
    this.pending = undefined;
    try {
      this.engineVersion ??= String(firstValue((await open.execute("SELECT sqlite_version() AS v")).rows[0]));
      await open.execute(`SAVEPOINT ${SAVEPOINT}`);
      try {
        const plan = statisticsRefresh(this.engineVersion, reason, this.changes, this.rowsDescribed);
        let step = plan.next();
        while (!step.done) step = plan.next((await open.execute(step.value.sql)).rows);
        await open.execute(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        this.rowsDescribed = step.value.rowsDescribed;
        this.changes = 0;
        this.lastRefresh = { reason, tables: step.value.tables, durationMs: performance.now() - started };
      } catch (error) {
        await open.execute(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        await open.execute(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        throw error;
      }
    } catch (error) {
      if (reason === "request") throw error;
      // Wait for another `afterChanges` rows before trying again, so a refresh
      // that keeps failing does not run inside every commit.
      this.changes = 0;
      this.lastRefresh = {
        reason,
        tables: [],
        durationMs: performance.now() - started,
        skipped: error instanceof Error ? error.message : String(error),
      };
    }
    return this.lastRefresh!;
  }
}

function firstValue(row: unknown): unknown {
  if (row === null || typeof row !== "object") return undefined;
  return (row as ArrayLike<unknown>)[0] ?? Object.values(row as Record<string, unknown>)[0];
}
