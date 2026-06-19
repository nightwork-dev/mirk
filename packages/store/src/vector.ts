// ─── @mirk/store/vector ─────────────────────────────────────────────────────
// Vector similarity interface (the port) + the in-memory reference impl + the
// shared cosine/encoding helpers. ZERO native deps. Source adapters (e.g.
// @mirk/store/sqlite) implement VectorStore; they are NOT re-exported here.

export type {
  Vector,
  VectorStore,
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
} from "./vector/cosine.js";
export { InMemoryVectorStore } from "./vector/memory.js";
