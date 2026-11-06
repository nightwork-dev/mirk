import type { SqliteDb } from "./sqlite-driver.js";
import { AtomicMutationBackendError, type JsonCompatible, type JsonValue } from "../atomic.js";
import type { LogCursor, LogEntry, LogListOptions, LogStore } from "../log/types.js";
import { assertGeneration, assertSequence, assertStream, encodeRecord, listBounds, LogInputError } from "../log/validate.js";
import { isSqliteBusyOrLocked } from "../sqlite-busy.js";

export class SqliteLogFacet implements LogStore {
  constructor(private readonly db: SqliteDb) {
    this.db.prepare("SELECT generation FROM _mirk_log_streams LIMIT 0").all();
    this.db.prepare("SELECT value FROM _mirk_log_generation WHERE id = 1").get();
  }
  private write<T>(work: () => T): T {
    try { return this.db.transaction(work).immediate(); }
    catch (error) {
      if (isSqliteBusyOrLocked(error)) throw new AtomicMutationBackendError("unavailable", true, "SQLite is busy or locked.");
      throw error;
    }
  }
  append(stream: string, record: JsonValue): number;
  append<T>(stream: string, record: T & JsonCompatible<T>): number;
  append(stream: string, record: unknown): number {
    assertStream(stream);
    const text = encodeRecord(record);
    return this.write(() => {
      const live = this.db.prepare("SELECT generation FROM _mirk_log_streams WHERE stream = ?").get(stream);
      if (!live) {
        const allocated = this.db.prepare("UPDATE _mirk_log_generation SET value = value + 1 WHERE id = 1 AND value < 9007199254740991 RETURNING value").get() as { value: number | bigint } | undefined;
        if (!allocated) throw new LogInputError("generation-exhausted", "log generation counter exhausted");
        this.db.prepare("INSERT INTO _mirk_log_streams (stream, generation) VALUES (?, ?)").run(stream, allocated.value);
      }
      const row = this.db.prepare(`INSERT INTO _mirk_log (stream, sequence, record)
        SELECT ?, COALESCE(MAX(sequence), 0) + 1, ? FROM _mirk_log WHERE stream = ? RETURNING sequence`).get(stream, text, stream) as { sequence: number | bigint };
      return Number(row.sequence);
    });
  }
  get<T = JsonValue>(stream: string, sequence: number): LogEntry<T> | null {
    assertStream(stream); assertSequence(sequence);
    const row = this.db.prepare(`SELECT s.generation, l.record FROM _mirk_log_streams s JOIN _mirk_log l USING(stream)
      WHERE s.stream = ? AND l.sequence = ?`).get(stream, sequence) as { generation: number; record: string } | undefined;
    return row ? { generation: Number(row.generation), sequence, record: JSON.parse(row.record) as T } : null;
  }
  list<T = JsonValue>(stream: string, options?: LogListOptions): LogEntry<T>[] {
    assertStream(stream);
    const { after, limit } = listBounds(options);
    const rows = this.db.prepare(`SELECT s.generation, e.sequence, e.record
      FROM (SELECT 1) anchor
      LEFT JOIN _mirk_log_streams s ON s.stream = ?
      LEFT JOIN (SELECT sequence, record FROM _mirk_log WHERE stream = ? AND sequence > ? ORDER BY sequence LIMIT ?) e
        ON s.generation IS NOT NULL ORDER BY e.sequence`).all(stream, stream, after?.sequence ?? 0, limit ?? -1) as { generation: number | null; sequence: number | null; record: string | null }[];
    const generation = rows[0]?.generation;
    assertGeneration(after, generation === null || generation === undefined ? undefined : Number(generation));
    return rows.filter(row => row.sequence !== null).map(row => ({ generation: Number(row.generation), sequence: Number(row.sequence), record: JSON.parse(row.record!) as T }));
  }
  deleteStream(stream: string): boolean {
    assertStream(stream);
    return this.write(() => {
      this.db.prepare("DELETE FROM _mirk_log WHERE stream = ?").run(stream);
      return Number(this.db.prepare("DELETE FROM _mirk_log_streams WHERE stream = ?").run(stream).changes) > 0;
    });
  }
  lastCursor(stream: string): LogCursor | null {
    assertStream(stream);
    const row = this.db.prepare(`SELECT s.generation, MAX(l.sequence) AS sequence FROM _mirk_log_streams s
      JOIN _mirk_log l USING(stream) WHERE s.stream = ? GROUP BY s.generation`).get(stream) as LogCursor | undefined;
    return row ? { generation: Number(row.generation), sequence: Number(row.sequence) } : null;
  }
  lastSequence(stream: string): number { return this.lastCursor(stream)?.sequence ?? 0; }
}
