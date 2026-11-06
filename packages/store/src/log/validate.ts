import { canonicalJson } from "../canonical.js";
import type { LogCursor, LogListOptions } from "./types.js";

export type LogInputErrorCode =
  | "invalid-stream"
  | "invalid-sequence"
  | "invalid-cursor"
  | "stale-cursor"
  | "generation-exhausted"
  | "invalid-limit"
  | "invalid-record";

/** Thrown when a log call's arguments are unusable. Nothing is written. */
export class LogInputError extends Error {
  declare readonly name: "LogInputError";
  constructor(readonly code: LogInputErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(LogInputError.prototype, "name", {
  value: "LogInputError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export function assertStream(stream: unknown): asserts stream is string {
  if (typeof stream !== "string" || stream.length === 0) {
    throw new LogInputError("invalid-stream", "log stream must be a non-empty string");
  }
}

export function assertSequence(sequence: unknown): asserts sequence is number {
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    throw new LogInputError("invalid-sequence", "log sequence must be a positive safe integer");
  }
}

/** The validated `after` and `limit` of a list call. `limit` is undefined for
 *  no limit. */
export function listBounds(options: LogListOptions | undefined): {
  after: LogCursor | undefined;
  limit: number | undefined;
} {
  const after = options?.after;
  const limit = options?.limit;
  if (after !== undefined && (
    after === null || typeof after !== "object" || Array.isArray(after) ||
    !Number.isSafeInteger(after.generation) || after.generation < 1 ||
    !Number.isSafeInteger(after.sequence) || after.sequence < 0
  )) {
    throw new LogInputError("invalid-cursor", "log after must be a cursor with positive safe generation and non-negative safe sequence");
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new LogInputError("invalid-limit", "log limit must be a non-negative safe integer");
  }
  return { after, limit };
}

export function assertGeneration(cursor: LogCursor | undefined, generation: number | undefined): void {
  if (cursor && cursor.generation !== generation) throw new LogInputError("stale-cursor", "log cursor belongs to a missing or replaced stream");
}

/** The stored text of a record: the strict JSON rules atomic writes use, then
 *  the record's own key order. */
export function encodeRecord(record: unknown): string {
  try {
    canonicalJson(record);
  } catch (error) {
    throw new LogInputError(
      "invalid-record",
      `log record is not JSON-safe: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return JSON.stringify(record);
}
