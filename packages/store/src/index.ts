// ─── @mirk/store ───────────────────────────────────────────────────────────
// One namespace, code-split subpaths. This root carries ONLY the interface ports
// and their in-memory reference impls — ZERO native deps. Source adapters live in
// subpaths and are NEVER re-exported here, so importing @mirk/store (or /kv, or
// /vector) never drags a native binding (better-sqlite3, …) into a consumer:
//
//   @mirk/store          — interfaces + in-memory refs (this file)
//   @mirk/store/kv       — KvStore port + InMemoryKv
//   @mirk/store/vector   — VectorStore port + InMemoryVectorStore + cosine helpers
//   @mirk/store/sqlite   — SqliteAdapter (KvStore + VectorStore over one connection)
//
// KV is synchronous (SyncStore); AsyncStore is the same surface returning Promises,
// reachable from any sync store via toAsync. The one-way bridge: sync ⊂ async.

// KV port + in-memory reference
export type {
  SyncStore,
  AsyncStore,
  SyncStoreInQuery,
  AsyncStoreInQuery,
  StoreMeta,
  StoreFilter,
} from './types.js';
export { toAsync } from './to-async.js';
export { InMemoryStore as InMemoryKv } from './backends/memory.js';

// Vector port + in-memory reference + shared helpers
export type {
  Vector,
  VectorStore,
  AsyncVectorStore,
  VectorStoreMeta,
  VectorDocument,
  VectorSearchResult,
  VectorSearchOptions,
} from './vector/types.js';
export {
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
  assertDimensions,
  isUsableVector,
} from './vector/cosine.js';
export { InMemoryVectorStore } from './vector/memory.js';
export { toAsyncVector } from './vector/to-async-vector.js';
export { matchesWhere } from './vector/filter.js';

// Search port + in-memory reference + shared tokenization helpers
export type {
  SearchStore,
  SearchDocument,
  SearchOptions,
  SearchResult,
} from './search/types.js';
export { InMemorySearchStore } from './search/memory.js';
export { tokenize, sanitizeFtsQuery } from './search/tokenize.js';
