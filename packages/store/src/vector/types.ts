// ─── @mirk/store/vector types ───────────────────────────────────────────────
// Synchronous vector similarity store. One interface, swappable embedded backends.
//
// Sync by design: the embedded backends (in-memory, sqlite) are synchronous —
// better-sqlite3 is synchronous, and forcing async on a local call buys nothing.
// A remote/async backend (e.g. Qdrant) would add a parallel async interface; it
// is deliberately deferred until a remote consumer is real.

/** An embedding. Float32Array — compact, and the on-disk encoding is little-endian
 *  float32 so vectors stay portable across backends. */
export type Vector = Float32Array;

export interface VectorStoreMeta {
  /** Backend identifier (e.g. "memory", "sqlite"). */
  backend: string;
  /** Embedding dimensions this store is configured for. */
  dimensions: number;
  /** True when a native acceleration path (sqlite-vec) is active; false when the
   *  store does exact JS-side cosine search. Informational — results are the same
   *  ranking either way, only the speed differs. */
  accelerated: boolean;
}

export interface VectorDocument<M extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique id within the collection. */
  id: string;
  /** The embedding. Length must equal the store's configured dimensions. */
  vector: Vector;
  /** Typed context stored alongside the vector. Persisted as JSON by disk-backed
   *  backends, so it must be JSON-serializable; values JSON can't represent
   *  (`undefined`, functions) are dropped on persistence — don't rely on them. */
  metadata?: M;
}

export interface VectorSearchResult<M extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  /** Cosine similarity in [-1, 1]. Higher is more similar. */
  score: number;
  metadata?: M;
}

export interface VectorSearchOptions {
  /** Maximum results to return. Default: 10. */
  topK?: number;
  /** Minimum cosine similarity; results below are excluded. Default: no floor. */
  minScore?: number;
}

/** A synchronous vector similarity store with per-collection documents.
 *
 *  All operations are synchronous. Construction may be async for backends that
 *  load native bindings (see each backend's static `open`); once opened, every
 *  call is pure sync. */
export interface VectorStore {
  readonly meta: VectorStoreMeta;

  /** Insert or replace a document by (collection, id). Throws on dimension mismatch. */
  upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): void;

  /** Insert or replace many documents in one collection. */
  upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): void;

  /** Fetch a document by id, or null. */
  get<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string,
  ): VectorDocument<M> | null;

  /** Remove a document by id. Returns true if it existed. */
  remove(collection: string, id: string): boolean;

  /** Number of documents in a collection. */
  count(collection: string): number;

  /** k-nearest-neighbour search by cosine similarity, highest score first. */
  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    opts?: VectorSearchOptions,
  ): VectorSearchResult<M>[];
}
