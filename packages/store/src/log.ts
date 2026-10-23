// ─── @mirk/store/log ────────────────────────────────────────────────────────
// Append-only ordered log interface (the port) + the in-memory reference impl.
// ZERO native deps. Source adapters (e.g. @mirk/store/sqlite) implement
// LogStore; they are NOT re-exported here.

export type { LogStore, AsyncLogStore, LogEntry, LogListOptions } from "./log/types.js";
export { InMemoryLogStore } from "./log/memory.js";
export { toAsyncLog } from "./log/to-async-log.js";
export { LogInputError } from "./log/validate.js";
export type { LogInputErrorCode } from "./log/validate.js";
export type { JsonValue, JsonCompatible } from "./atomic.js";
