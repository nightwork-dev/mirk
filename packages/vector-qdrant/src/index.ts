import { Buffer } from "node:buffer";
import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import {
  assertDimensions,
  compareCodePoints,
  cosineSimilarity,
  isUsableVector,
  VectorInputError,
} from "@mirk/store/vector";
import type {
  AsyncVectorStore,
  VectorDocument,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStoreMeta,
  VectorSpace,
  VectorSpaceOptions,
  VectorQuery,
} from "@mirk/store/vector";

import { DEFAULT_PAGE_SIZE, PAYLOAD_COLLECTION, jsonToken, encodePayload, decodePoint, normalizedIndexVector, scopedFilter, hasNonFiniteComponent, namedParams, nativeName, ensureIndexes, fieldMatch, isAlreadyExistsError, QdrantCollectionError, QdrantProtocolError, pointIdFor, candidateScoreBound } from "./wire.js";
export { QdrantCollectionError, QdrantProtocolError, pointIdFor, candidateScoreBound } from "./wire.js";
/** AsyncVectorStore backed by one host-selected, dedicated Qdrant collection. */
export class QdrantVectorStore implements AsyncVectorStore {
  readonly meta: VectorStoreMeta;
  private readonly client: QdrantClient;
  private readonly collectionName: string;
  private readonly spaces = new Map<string, number>();
  private readonly namespace: string;
  private readonly pageSize: number;

  private constructor(
    client: QdrantClient,
    collectionName: string,
    namespace: string,
    pageSize: number,
  ) {
    this.client = client;
    this.collectionName = collectionName;
    this.namespace = namespace;
    this.pageSize = pageSize;
    this.meta = { backend: "qdrant", accelerated: true };
  }

  static async open(
    client: QdrantClient,
    options: { collectionName: string; namespace?: string; pageSize?: number },
  ): Promise<QdrantVectorStore> {
    const { collectionName } = options;
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new QdrantCollectionError(`Qdrant pageSize must be a positive integer; got ${pageSize}`);
    }

    const existence = await client.collectionExists(collectionName);
    if (!existence.exists) {
      try {
        await client.createCollection(collectionName, {
          vectors: {},
        });
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    }

    const info = await client.getCollection(collectionName);
    const marker = info.config.metadata?.mirkMigration as { complete?: boolean } | undefined;
    if (marker && marker.complete !== true) throw new QdrantCollectionError("Migration incomplete; resume migrateLegacyQdrantVectors before opening");
    namedParams(info);
    await ensureIndexes(client, collectionName, info);
    const store = new QdrantVectorStore(client, collectionName, options.namespace ?? "default", pageSize);
    await store.listSpaces();
    return store;
  }

  /** @internal Only the migration coordinator admits a partial destination. */
  static async openMigrationDestination(client: QdrantClient, collectionName: string): Promise<QdrantVectorStore> {
    const info = await client.getCollection(collectionName);
    namedParams(info);
    await ensureIndexes(client, collectionName, info);
    return new QdrantVectorStore(client, collectionName, "default", DEFAULT_PAGE_SIZE);
  }

  async listSpaces(): Promise<VectorSpace[]> {
    const params = namedParams(await this.client.getCollection(this.collectionName));
    this.spaces.clear();
    for (const [key, config] of Object.entries(params)) {
      if (!key.startsWith("mirk_")) continue;
      let identity: unknown;
      try { identity = JSON.parse(Buffer.from(key.slice(5), "base64url").toString()); } catch { continue; }
      if (!Array.isArray(identity) || identity[0] !== this.namespace || typeof identity[1] !== "string") continue;
      if (config.distance !== "Dot" || (config.datatype != null && config.datatype !== "float32") || config.multivector_config != null) {
        throw new QdrantCollectionError(`Incompatible Qdrant space ${identity[1]}`);
      }
      this.spaces.set(identity[1], config.size);
    }
    return [...this.spaces].sort(([a], [b]) => compareCodePoints(a, b)).map(([name, dimensions]) => ({ name, dimensions, metric: "cosine", encoding: "float32" }));
  }

  async ensureSpace(name: string, options: VectorSpaceOptions): Promise<void> {
    if (!name) throw new VectorInputError("invalid-space", "Space name must be nonempty");
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) throw new VectorInputError("invalid-dimensions", "Dimensions must be a positive integer");
    await this.listSpaces();
    const existing = this.spaces.get(name);
    if (existing !== undefined) {
      if (existing !== options.dimensions) throw new VectorInputError("space-definition-conflict", `Space ${name} already has ${existing} dimensions`);
      return;
    }
    try {
      await this.client.createVectorName(this.collectionName, nativeName(this.namespace, name), { dense: { size: options.dimensions, distance: "Dot" } }, { wait: true });
    } catch (error) {
      await this.listSpaces();
      const concurrent = this.spaces.get(name);
      if (concurrent !== undefined && concurrent !== options.dimensions) throw new VectorInputError("space-definition-conflict", `Space ${name} already has ${concurrent} dimensions`);
      if (concurrent === undefined) throw error;
    }
    await this.listSpaces();
  }

  private dimensionsFor(name: string): number {
    const dimensions = this.spaces.get(name);
    if (dimensions === undefined) throw new VectorInputError("unknown-space", `Unknown vector space: ${name}`);
    return dimensions;
  }

  private scope(collection: string): string { return JSON.stringify([this.namespace, collection]); }

  async upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): Promise<void> {
    await this.upsertMany(collection, [doc]);
  }

  async upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): Promise<void> {
    if (docs.length === 0) return;
    await this.listSpaces();
    for (const doc of docs) {
      if (Object.keys(doc.vectors).length === 0) throw new VectorInputError("empty-vectors", "A document needs at least one vector");
      for (const [name, vector] of Object.entries(doc.vectors)) assertDimensions(vector, this.dimensionsFor(name));
    }
    collection = this.scope(collection);
    const points: Schemas["PointStruct"][] = docs.map((doc) => ({
      id: pointIdFor(collection, doc.id),
      vector: Object.fromEntries(Object.entries(doc.vectors).map(([name, vector]) => [nativeName(this.namespace, name), normalizedIndexVector(vector)])),
      payload: encodePayload(collection, doc),
    }));
    await this.client.upsert(this.collectionName, {
      wait: true,
      points,
    });
  }

  async get<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string,
  ): Promise<VectorDocument<M> | null> {
    collection = this.scope(collection);
    await this.listSpaces();
    const records = await this.client.retrieve(this.collectionName, {
      ids: [pointIdFor(collection, id)],
      with_payload: true,
      with_vector: false,
    });
    const record = records[0];
    if (record === undefined) return null;
    const decoded = decodePoint(record, collection, this.spaces);
    if (decoded.id !== id) {
      throw new QdrantProtocolError("Qdrant point payload original id does not match the requested id");
    }
    return {
      id: decoded.id,
      vectors: decoded.vectors,
      ...(decoded.metadata === undefined ? {} : { metadata: decoded.metadata as M }),
    };
  }

  async has(collection: string, id: string): Promise<boolean> {
    return (await this.get(collection, id)) !== null;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const existing = await this.get(collection, id);
    if (existing === null) return false;
    await this.client.delete(this.collectionName, {
      points: [pointIdFor(this.scope(collection), id)],
      wait: true,
    });
    return true;
  }

  async count(collection: string): Promise<number> {
    const result = await this.client.count(this.collectionName, {
      exact: true,
      filter: { must: [fieldMatch(PAYLOAD_COLLECTION, jsonToken(this.scope(collection)))] },
    });
    return result.count;
  }

  async search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: VectorQuery,
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult<M>[]> {
    await this.listSpaces();
    const dimensions = this.dimensionsFor(query.space);
    assertDimensions(query.vector, dimensions);
    collection = this.scope(collection);
    const topK = options?.topK ?? 10;
    if (Number.isNaN(topK) || topK === 0 || topK === -Infinity || (topK > 0 && topK < 1)) return [];
    if (!Number.isFinite(topK) && topK !== Infinity && topK !== -Infinity) return [];
    if (hasNonFiniteComponent(query.vector)) return [];

    const minScore = options?.minScore;
    const indexedQuery = normalizedIndexVector(query.vector);
    const filter = scopedFilter(collection, options ?? {}, query.space);
    const bound = candidateScoreBound(dimensions);
    const positiveK = Number.isFinite(topK) && topK > 0 ? Math.trunc(topK) : undefined;
    let candidates: VectorSearchResult<M>[] = [];
    let requestLimit = this.pageSize;

    while (true) {
      const response = await this.client.query(this.collectionName, {
        query: indexedQuery,
        using: nativeName(this.namespace, query.space),
        filter,
        params: { exact: true, quantization: { ignore: true } },
        // Qdrant's tie ordering can vary between segments when offsetting a
        // page. Always request a native prefix from offset zero and grow the
        // prefix geometrically; each response replaces the previous one.
        limit: requestLimit,
        offset: 0,
        with_payload: true,
        // Native search scores the normalized index vector. Public scores are
        // recomputed from the original float32 payload below.
      });
      const points = response.points;
      if (points.length === 0) break;
      const pageCandidates: VectorSearchResult<M>[] = [];
      const pageIds = new Set<string>();
      for (const point of points) {
        const decoded = decodePoint(point, collection, this.spaces);
        if (pageIds.has(decoded.id)) throw new QdrantProtocolError("Qdrant returned duplicate points in a native prefix");
        pageIds.add(decoded.id);
        const vector = decoded.vectors[query.space];
        if (vector === undefined || !isUsableVector(vector)) throw new QdrantProtocolError("Qdrant returned a missing or unusable vector");
        if (!Number.isFinite(point.score)) throw new QdrantProtocolError("Qdrant returned a non-finite native score");
        const score = cosineSimilarity(query.vector, vector);
        if (!Number.isFinite(score)) continue;
        if (minScore !== undefined && score < minScore) continue;
        pageCandidates.push({
          id: decoded.id,
          score,
          ...(decoded.metadata === undefined ? {} : { metadata: decoded.metadata as M }),
        });
      }
      candidates = pageCandidates;
      if (points.length < requestLimit) break;

      const sorted = [...candidates].sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id));
      const kthScore = positiveK !== undefined && sorted.length >= positiveK
        ? sorted[positiveK - 1]?.score
        : undefined;
      const cutoff = Math.max(
        Number.isFinite(minScore ?? Number.NaN) ? (minScore as number) : -Infinity,
        kthScore ?? -Infinity,
      );
      const lastNativeScore = points[points.length - 1]?.score;
      if (lastNativeScore !== undefined && cutoff !== -Infinity && lastNativeScore < cutoff - bound) break;
      const nextLimit = requestLimit > Number.MAX_SAFE_INTEGER / 2
        ? Number.MAX_SAFE_INTEGER
        : requestLimit * 2;
      if (nextLimit === requestLimit) throw new QdrantProtocolError("Qdrant native prefix limit did not grow");
      requestLimit = nextLimit;
    }

    candidates.sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id));
    return candidates.slice(0, topK);
  }
}

export type { AsyncVectorStore, Vector, VectorDocument, VectorSearchOptions, VectorSearchResult, VectorStoreMeta, VectorSpace, VectorSpaceOptions, VectorQuery } from "@mirk/store/vector";

export { migrateLegacyQdrantVectors, type QdrantMigrationOptions, type QdrantMigrationProgress } from "./migration.js";
