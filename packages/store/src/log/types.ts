// ─── @mirk/store/log types ──────────────────────────────────────────────────
// An append-only, per-stream ordered log of JSON records. Synchronous by
// design, like every embedded port; AsyncLogStore is the Promise-returning
// twin, reached from a sync store through toAsyncLog.

import type { JsonCompatible, JsonValue } from "../atomic.js";

/** One committed record and the sequence number it was given. */
export interface LogEntry<T = JsonValue> {
  /** Position in its stream. The first append to a stream gets 1. */
  sequence: number;
  record: T;
}

export interface LogListOptions {
  /** Return entries whose sequence is greater than this. Default 0, which
   *  starts at the first entry. */
  after?: number;
  /** Return at most this many entries. Default: no limit. */
  limit?: number;
}

/**
 * An append-only log of JSON records, partitioned into named streams.
 *
 * - Sequences are per stream, start at 1, and increase by exactly 1 for each
 *   committed append. There are no gaps among committed appends.
 * - The sequence and the record are written together: no reader, and no crash,
 *   can observe one without the other.
 * - An append that does not commit (it threw, or its transaction rolled back)
 *   leaves no trace, and its sequence is given to the next append.
 * - Records are never changed or removed through this port.
 */
export interface LogStore {
  /** Append a record to the end of `stream` and return its sequence. A
   *  caller's own JSON-shaped type is accepted without a cast. */
  append(stream: string, record: JsonValue): number;
  append<T>(stream: string, record: T & JsonCompatible<T>): number;
  /** The entry at `sequence`, or null when the stream has no such entry. */
  get<T = JsonValue>(stream: string, sequence: number): LogEntry<T> | null;
  /** Entries after `options.after`, in sequence order, at most `options.limit`. */
  list<T = JsonValue>(stream: string, options?: LogListOptions): LogEntry<T>[];
  /** The highest committed sequence in `stream`, or 0 when it is empty. */
  lastSequence(stream: string): number;
}

/** The async face of the same log. Sync stores reach it via {@link toAsyncLog}. */
export interface AsyncLogStore {
  append(stream: string, record: JsonValue): Promise<number>;
  append<T>(stream: string, record: T & JsonCompatible<T>): Promise<number>;
  get<T = JsonValue>(stream: string, sequence: number): Promise<LogEntry<T> | null>;
  list<T = JsonValue>(stream: string, options?: LogListOptions): Promise<LogEntry<T>[]>;
  lastSequence(stream: string): Promise<number>;
}
