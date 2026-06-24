// ─── @mirk/store/kv ─────────────────────────────────────────────────────────
// KV + collection store interface (the port) + the in-memory reference impl.
// ZERO native deps — importing this never pulls better-sqlite3. Source adapters
// (e.g. @mirk/store/sqlite) implement these interfaces; they are NOT re-exported
// here.

export type {
  SyncStore,
  AsyncStore,
  SyncStoreInQuery,
  AsyncStoreInQuery,
  StoreFilter,
  StoreMeta,
} from "./types.js";
export { toAsync } from "./to-async.js";
export { InMemoryStore as InMemoryKv } from "./backends/memory.js";
