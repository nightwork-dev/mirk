// ─── @mirk/store/vector types ───────────────────────────────────────────────
// Synchronous vector similarity store. One interface, swappable embedded backends.
//
// Sync by design: the embedded backends (in-memory, sqlite) are synchronous —
// better-sqlite3 is synchronous, and forcing async on a local call buys nothing.
// AsyncVectorStore is the Promise-returning twin for remote backends (e.g. Qdrant).
// Hand-written rather than derived via a mapped type because per-method generics
// (`search<M>`, `get<M>`, …) collapse to `unknown` under inference — same reason as
// the KV AsyncStore twin in src/types.ts.

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
  /** Pre-KNN filter: only consider documents whose metadata satisfies ALL of these
   *  exact-match conditions. Applied before scoring, so topK is out of the passing
   *  set only. `where` and `whereNot` are independent — both may be provided. */
  where?: Record<string, unknown>;
  /** Pre-KNN filter: exclude documents whose metadata satisfies ANY of these
   *  exact-match conditions. Applied before scoring. */
  whereNot?: Record<string, unknown>;
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

  /** Check whether a document exists by (collection, id). */
  has(collection: string, id: string): boolean;

  /** Remove a document by id. Returns true if it existed. */
  remove(collection: string, id: string): boolean;

  /** Number of documents in a collection. */
  count(collection: string): number;

  /** k-nearest-neighbour search by cosine similarity, highest score first.
   *  Supports pre-KNN filtering via opts.where / opts.whereNot. */
  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    opts?: VectorSearchOptions,
  ): VectorSearchResult<M>[];
}

/** The async face of the same vector store. Remote backends (e.g. Qdrant) implement
 *  this natively; sync backends reach it via {@link toAsyncVector}.
 *
 *  Hand-written rather than derived from VectorStore via a mapped type: per-method
 *  generics (`get<M>`, `search<M>`, …) collapse to `unknown` under inference — same
 *  constraint as the KV AsyncStore twin in src/types.ts. */
export interface AsyncVectorStore {
  readonly meta: VectorStoreMeta;

  upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): Promise<void>;

  upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): Promise<void>;

  get<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string,
  ): Promise<VectorDocument<M> | null>;

  has(collection: string, id: string): Promise<boolean>;

  remove(collection: string, id: string): Promise<boolean>;

  count(collection: string): Promise<number>;

  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    opts?: VectorSearchOptions,
  ): Promise<VectorSearchResult<M>[]>;
}
