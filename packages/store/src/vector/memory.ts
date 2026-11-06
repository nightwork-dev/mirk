// ─── InMemoryVectorStore ────────────────────────────────────────────────────
// Brute-force exact cosine similarity. Non-persistent. For tests and small,
// transient datasets. Zero dependencies.

import type {
  VectorStore,
  VectorStoreMeta,
  VectorDocument,
  VectorSearchResult,
  VectorSearchOptions,
  VectorQuery,
  VectorSpace,
  VectorSpaceOptions,
} from "./types.js";
import { matchesWhere } from "./filter.js";
import { compareCodePoints } from "../order.js";
import { cosineSimilarity, assertDimensions, isUsableVector, VectorInputError } from "./cosine.js";

type AnyDoc = VectorDocument<Record<string, unknown>>;

export class InMemoryVectorStore implements VectorStore {
  readonly meta: VectorStoreMeta;
  private readonly spaces = new Map<string, VectorSpace>();
  private readonly collections = new Map<string, Map<string, AnyDoc>>();

  constructor() {
    this.meta = { backend: "memory", accelerated: false };
  }

  ensureSpace(name: string, options: VectorSpaceOptions): void {
    validateSpace(name, options);
    const found = this.spaces.get(name);
    if (found && found.dimensions !== options.dimensions) throw new VectorInputError("space-definition-conflict", `Space ${name} already has ${found.dimensions} dimensions`);
    this.spaces.set(name, { name, dimensions: options.dimensions, metric: "cosine", encoding: "float32" });
  }

  listSpaces(): VectorSpace[] { return [...this.spaces.values()].sort((a,b) => compareCodePoints(a.name,b.name)).map(space => ({...space})); }

  private validate(doc: AnyDoc): void {
    if (!Object.keys(doc.vectors).length) throw new VectorInputError("empty-vectors", "A document needs at least one vector");
    for (const [space, vector] of Object.entries(doc.vectors)) assertDimensions(vector, this.requireSpace(space).dimensions);
  }

  private requireSpace(name: string): VectorSpace {
    const space = this.spaces.get(name);
    if (!space) throw new VectorInputError("unknown-space", `Unknown vector space: ${name}`);
    return space;
  }

  upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): void {
    this.validate(doc);
    this.collectionFor(collection).set(doc.id, doc as AnyDoc);
  }

  upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): void {
    // Atomic: validate every vector before mutating, so a mid-array mismatch
    // inserts nothing (matching the sqlite backend's transactional upsertMany).
    for (const doc of docs) this.validate(doc);
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

  has(collection: string, id: string): boolean {
    return this.collections.get(collection)?.has(id) ?? false;
  }

  remove(collection: string, id: string): boolean {
    return this.collections.get(collection)?.delete(id) ?? false;
  }

  count(collection: string): number {
    return this.collections.get(collection)?.size ?? 0;
  }

  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: VectorQuery,
    opts?: VectorSearchOptions,
  ): VectorSearchResult<M>[] {
    assertDimensions(query.vector, this.requireSpace(query.space).dimensions);
    const topK = opts?.topK ?? 10;
    const minScore = opts?.minScore;
    const coll = this.collections.get(collection);
    if (!coll) return [];
    const scored: VectorSearchResult<M>[] = [];
    for (const doc of coll.values()) {
      // Pre-KNN metadata filters — applied before scoring so topK is out of the
      // passing set only.
      if (opts?.where && !matchesWhere(doc.metadata, opts.where)) continue;
      if (opts?.whereNot && matchesWhere(doc.metadata, opts.whereNot)) continue;
      // A zero / non-finite stored vector has no cosine direction — exclude it, so
      // this backend matches the sqlite adapter (both JS and vec0 paths exclude them).
      const vector = doc.vectors[query.space];
      if (!vector || !isUsableVector(vector)) continue;
      const score = cosineSimilarity(query.vector, vector);
      if (!Number.isFinite(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      scored.push({ id: doc.id, score, metadata: doc.metadata as M | undefined });
    }
    // Ties break deterministically by id in Unicode code point order — the same
    // tiebreak the sqlite adapter applies, so equal-score results order alike.
    scored.sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id));
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

export function validateSpace(name: string, options: VectorSpaceOptions): void {
  if (!name) throw new VectorInputError("invalid-space", "Space name must be nonempty");
  if (!Number.isSafeInteger(options.dimensions) || options.dimensions <= 0) throw new VectorInputError("invalid-dimensions", `Vector dimensions must be a positive integer; got ${options.dimensions}.`);
}
