import type { SqliteDb } from "./sqlite-driver.js";
import { AtomicMutationBackendError, type JsonCompatible, type JsonValue } from "../atomic.js";
import type { LogEntry, LogListOptions, LogStore } from "../log/types.js";
import { assertSequence, assertStream, encodeRecord, listBounds } from "../log/validate.js";
import { isSqliteBusyOrLocked } from "../sqlite-busy.js";

// ─── Log facet (LogStore) ────────────────────────────────────────────────────

export class SqliteLogFacet implements LogStore {
  constructor(private readonly db: SqliteDb) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS _mirk_log (
         stream TEXT NOT NULL,
         sequence INTEGER NOT NULL CHECK (sequence >= 1),
         record TEXT NOT NULL,
         PRIMARY KEY (stream, sequence)
       ) WITHOUT ROWID`
    );
  }

  /** One statement: the sequence is derived from the stream's own rows inside
   *  the INSERT, so there is no separate counter that could commit without its
   *  record, and a rolled-back append's number is free again. */
  append(stream: string, record: JsonValue): number;
  append<T>(stream: string, record: T & JsonCompatible<T>): number;
  append(stream: string, record: unknown): number {
    assertStream(stream);
    const text = encodeRecord(record);
    let row: { sequence: number | bigint };
    try {
      row = this.db
        .prepare(
          `INSERT INTO _mirk_log (stream, sequence, record)
           SELECT ?, COALESCE(MAX(sequence), 0) + 1, ? FROM _mirk_log WHERE stream = ?
           RETURNING sequence`
        )
        .get(stream, text, stream) as { sequence: number | bigint };
    } catch (error) {
      // Another writer held the lock past busyTimeoutMs, or committed after a
      // deferred transaction's first read, so this one cannot write. Nothing
      // was appended; retrying the whole transaction is safe.
      if (isSqliteBusyOrLocked(error)) {
        throw new AtomicMutationBackendError(
          "unavailable",
          true,
          "SQLite is busy or locked."
        );
      }
      throw error;
    }
    return Number(row.sequence);
  }

  get<T = JsonValue>(stream: string, sequence: number): LogEntry<T> | null {
    assertStream(stream);
    assertSequence(sequence);
    const row = this.db
      .prepare("SELECT record FROM _mirk_log WHERE stream = ? AND sequence = ?")
      .get(stream, sequence) as { record: string } | undefined;
    return row === undefined ? null : { sequence, record: JSON.parse(row.record) as T };
  }

  list<T = JsonValue>(stream: string, options?: LogListOptions): LogEntry<T>[] {
    assertStream(stream);
    const { after, limit } = listBounds(options);
    const rows = this.db
      .prepare(
        "SELECT sequence, record FROM _mirk_log WHERE stream = ? AND sequence > ? ORDER BY sequence LIMIT ?"
      )
      .all(stream, after, limit ?? -1) as { sequence: number; record: string }[];
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      record: JSON.parse(row.record) as T,
    }));
  }

  deleteStream(stream: string): boolean {
    assertStream(stream);
    try {
      return Number(this.db.prepare("DELETE FROM _mirk_log WHERE stream = ?").run(stream).changes) > 0;
    } catch (error) {
      if (isSqliteBusyOrLocked(error)) throw new AtomicMutationBackendError("unavailable", true, "SQLite is busy or locked.");
      throw error;
    }
  }

  lastSequence(stream: string): number {
    assertStream(stream);
    const row = this.db
      .prepare("SELECT COALESCE(MAX(sequence), 0) AS last FROM _mirk_log WHERE stream = ?")
      .get(stream) as { last: number };
    return Number(row.last);
  }
}
