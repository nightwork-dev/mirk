// ─── @mirk/store/vector ─────────────────────────────────────────────────────
// Vector similarity interface (the port) + the in-memory reference impl + the
// shared cosine/encoding helpers. ZERO native deps. Source adapters (e.g.
// @mirk/store/sqlite) implement VectorStore; they are NOT re-exported here.

export type {
  Vector,
  VectorStore,
  AsyncVectorStore,
  VectorStoreMeta,
  VectorDocument,
  VectorSearchResult,
  VectorSearchOptions,
} from "./vector/types.js";
export {
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
  assertDimensions,
  isUsableVector,
} from "./vector/cosine.js";
export { InMemoryVectorStore } from "./vector/memory.js";
export { toAsyncVector } from "./vector/to-async-vector.js";
// The canonical pre-KNN metadata filter — exported so source adapters (sqlite,
// libsql) share ONE definition rather than re-implementing the match semantics.
export { matchesWhere } from "./vector/filter.js";
