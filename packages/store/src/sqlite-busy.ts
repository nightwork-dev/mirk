// Internal: shared by the SQLite adapter and the SQLite coordination store.
// No imports, so it adds nothing to either entry's dependency graph, and it is
// not exported from any package entry.

/** True for SQLite's busy and locked error codes, including extended codes
 *  such as `SQLITE_BUSY_SNAPSHOT` and `SQLITE_LOCKED_SHAREDCACHE`. */
export function isSqliteBusyOrLocked(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
  );
}

/** Run `work`, retrying synchronously while it throws a busy or locked error
 *  and `waitMs` has not elapsed. Each pause is the remaining time clamped to
 *  `[minSleepMs, maxSleepMs]`. */
export function runSqliteBusyRetry<T>(
  work: () => T,
  waitMs: number,
  minSleepMs: number,
  maxSleepMs: number
): T {
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      return work();
    } catch (error) {
      if (!isSqliteBusyOrLocked(error) || Date.now() >= deadline) throw error;
      const pause = Math.min(
        maxSleepMs,
        Math.max(minSleepMs, deadline - Date.now())
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
    }
  }
}
