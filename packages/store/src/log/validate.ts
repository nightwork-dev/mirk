import { canonicalJson } from "../canonical.js";
import type { LogListOptions } from "./types.js";

export type LogInputErrorCode =
  | "invalid-stream"
  | "invalid-sequence"
  | "invalid-after"
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
  after: number;
  limit: number | undefined;
} {
  const after = options?.after === undefined ? 0 : options.after;
  const limit = options?.limit;
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new LogInputError("invalid-after", "log after must be a non-negative safe integer");
  }
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new LogInputError("invalid-limit", "log limit must be a non-negative safe integer");
  }
  return { after, limit };
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
