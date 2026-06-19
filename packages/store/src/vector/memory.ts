// ─── InMemoryVectorStore ────────────────────────────────────────────────────
// Brute-force exact cosine similarity. Non-persistent. For tests and small,
// transient datasets. Zero dependencies.

import type {
  VectorStore,
  VectorStoreMeta,
  VectorDocument,
  VectorSearchResult,
  VectorSearchOptions,
  Vector,
} from "./types.js";
import { cosineSimilarity, assertDimensions } from "./cosine.js";

export interface InMemoryVectorStoreOptions {
  /** Embedding dimensions. All vectors must match this length. */
  dimensions: number;
}

type AnyDoc = VectorDocument<Record<string, unknown>>;

export class InMemoryVectorStore implements VectorStore {
  readonly meta: VectorStoreMeta;
  private readonly dimensions: number;
  private readonly collections = new Map<string, Map<string, AnyDoc>>();

  constructor(opts: InMemoryVectorStoreOptions) {
    this.dimensions = opts.dimensions;
    this.meta = { backend: "memory", dimensions: opts.dimensions, accelerated: false };
  }

  upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): void {
    assertDimensions(doc.vector, this.dimensions);
    this.collectionFor(collection).set(doc.id, doc as AnyDoc);
  }

  upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): void {
    // Atomic: validate every vector before mutating, so a mid-array mismatch
    // inserts nothing (matching the sqlite backend's transactional upsertMany).
    for (const doc of docs) assertDimensions(doc.vector, this.dimensions);
    const coll = this.collectionFor(collection);
    for (const doc of docs) coll.set(doc.id, doc as AnyDoc);
  }

  get<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string,
  ): VectorDocument<M> | null {
    const doc = this.collections.get(collection)?.get(id);
    return (doc ?? null) as VectorDocument<M> | null;
  }

  remove(collection: string, id: string): boolean {
    return this.collections.get(collection)?.delete(id) ?? false;
  }

  count(collection: string): number {
    return this.collections.get(collection)?.size ?? 0;
  }

  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    opts?: VectorSearchOptions,
  ): VectorSearchResult<M>[] {
    assertDimensions(query, this.dimensions);
    const topK = opts?.topK ?? 10;
    const minScore = opts?.minScore;
    const coll = this.collections.get(collection);
    if (!coll) return [];
    const scored: VectorSearchResult<M>[] = [];
    for (const doc of coll.values()) {
      const score = cosineSimilarity(query, doc.vector);
      if (!Number.isFinite(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      scored.push({ id: doc.id, score, metadata: doc.metadata as M | undefined });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private collectionFor(name: string): Map<string, AnyDoc> {
    let coll = this.collections.get(name);
    if (!coll) {
      coll = new Map();
      this.collections.set(name, coll);
    }
    return coll;
  }
}
