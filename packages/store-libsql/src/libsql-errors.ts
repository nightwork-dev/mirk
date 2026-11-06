export type LibsqlAdapterErrorCode =
  | "migration-refused"
  | "unsupported-backup"
  | "backup-failed"
  | "migration-required"
  | "malformed-schema"
  | "unsupported-schema-version"
  | "invalid-collection-name"
  | "invalid-option"
  | "adapter-closed"
  | "busy"
  | "transaction-expired"
  | "connection-lost"
  | "commit-indeterminate";

/** Thrown for invalid adapter input, incompatible on-disk state, and write
 *  transactions that could not run or finish. The codes for failed
 *  transactions are:
 *
 * - `busy`: the write lock was not acquired within `busyTimeoutMs`. Nothing
 *   was written.
 * - `transaction-expired`: the server ended the transaction, for example
 *   because it was held too long. Its writes were rolled back.
 * - `connection-lost`: the connection failed before the commit was sent. The
 *   transaction's writes were not committed.
 * - `commit-indeterminate`: the connection failed while the commit was in
 *   flight. The writes may or may not have committed; read durable state to
 *   find out.
 *
 * The driver's own error is the `cause`. */
export class LibsqlAdapterError extends Error {
  declare readonly name: "LibsqlAdapterError";
  readonly code: LibsqlAdapterErrorCode;

  constructor(
    code: LibsqlAdapterErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
  }
}

export type FailureCode = "busy" | "transaction-expired" | "connection-lost";

const FAILURE_MESSAGES: Record<FailureCode | "commit-indeterminate", string> = {
  busy: "The libSQL database stayed locked by another writer for longer than busyTimeoutMs.",
  "transaction-expired":
    "The libSQL server ended the transaction; its writes were rolled back.",
  "connection-lost":
    "The libSQL connection failed before the transaction committed.",
  "commit-indeterminate":
    "The libSQL connection failed during COMMIT; the transaction may or may not have committed.",
};

export function failure(
  code: FailureCode | "commit-indeterminate",
  cause: unknown,
): LibsqlAdapterError {
  return new LibsqlAdapterError(code, FAILURE_MESSAGES[code], { cause });
}

/** Rethrow driver failures that end a transaction as typed adapter errors;
 *  SQL errors pass through unchanged. */
export async function guard<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof LibsqlAdapterError) throw error;
    const code = classifyFailure(error);
    throw code === undefined ? error : failure(code, error);
  }
}

const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
  "HRANA_WEBSOCKET_ERROR",
  "HRANA_CLOSED_ERROR",
]);

/** Classifies a driver error by its code and message only, so this module
 *  stays free of a runtime dependency on a particular libSQL client. */
export function classifyFailure(error: unknown): FailureCode | undefined {
  for (
    let current = error, depth = 0;
    current !== undefined && current !== null && depth < 5;
    depth++
  ) {
    if (typeof current !== "object") return undefined;
    const { code, rawCode, message, name } = current as {
      code?: unknown;
      rawCode?: unknown;
      message?: unknown;
      name?: unknown;
    };
    const text = typeof message === "string" ? message : "";
    if (/transaction was rolled back|stream was idle/.test(text))
      return "transaction-expired";
    if (
      code === "SQLITE_BUSY" ||
      rawCode === 5 ||
      /SQLITE_BUSY|database is locked/.test(text)
    )
      return "busy";
    if (
      code === "TRANSACTION_TIMEOUT" ||
      code === "STREAM_EXPIRED" ||
      code === "TRANSACTION_CLOSED" ||
      (code === "SERVER_ERROR" && /HTTP status 404\b/.test(text))
    ) {
      return "transaction-expired";
    }
    if (
      (typeof code === "string" && TRANSPORT_CODES.has(code)) ||
      code === "SERVER_ERROR" ||
      name === "AbortError" ||
      name === "TimeoutError" ||
      (name === "TypeError" && text === "fetch failed")
    ) {
      return "connection-lost";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
Object.defineProperty(LibsqlAdapterError.prototype, "name", {
  value: "LibsqlAdapterError",
  writable: true,
  configurable: true,
  enumerable: false,
});
