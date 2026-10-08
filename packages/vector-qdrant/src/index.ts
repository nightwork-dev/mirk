import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import {
  assertDimensions,
  bufferToVector,
  compareCodePoints,
  cosineSimilarity,
  isUsableVector,
  VectorInputError,
  vectorToBuffer,
} from "@mirk/store/vector";
import type {
  AsyncVectorStore,
  Vector,
  VectorDocument,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStoreMeta,
} from "@mirk/store/vector";

const WIRE_VERSION = "mirk-vector-qdrant-v1";
const DEFAULT_PAGE_SIZE = 256;
const PAYLOAD_COLLECTION = "_mirk_collection";
const PAYLOAD_ID = "_mirk_id";
const PAYLOAD_VECTOR = "_mirk_vector";
const PAYLOAD_USABLE = "_mirk_usable";
const PAYLOAD_HAS_METADATA = "_mirk_has_metadata";
const PAYLOAD_METADATA = "_mirk_metadata";
const PAYLOAD_TERMS = "_mirk_terms";
const INDEX_FIELDS = [
  [PAYLOAD_COLLECTION, "keyword"],
  [PAYLOAD_TERMS, "keyword"],
  [PAYLOAD_USABLE, "bool"],
  [PAYLOAD_HAS_METADATA, "bool"],
] as const;

type Payload = Record<string, unknown>;
type QdrantFilter = Schemas["Filter"];
type QdrantPoint = Schemas["PointStruct"];

/** Thrown when a physical collection does not satisfy this adapter's contract. */
export class QdrantCollectionError extends Error {
  declare readonly name: "QdrantCollectionError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(QdrantCollectionError.prototype, "name", {
  value: "QdrantCollectionError",
  writable: true,
  configurable: true,
  enumerable: false,
});

/** Thrown when a point cannot be decoded as a Mirk Qdrant wire record. */
export class QdrantProtocolError extends Error {
  declare readonly name: "QdrantProtocolError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(QdrantProtocolError.prototype, "name", {
  value: "QdrantProtocolError",
  writable: true,
  configurable: true,
  enumerable: false,
});

/** Return the deterministic UUID used for a logical collection/id pair. */
export function pointIdFor(collection: string, id: string): string {
  const digest = createHash("sha256")
    .update(Buffer.from(JSON.stringify([WIRE_VERSION, collection, id]), "utf8"))
    .digest();
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50;
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Return the conservative score error bound used while completing native pages.
 * The bound includes input unit-vector quantization, float64 normalization, and
 * float32 product/addition error; it is deliberately a bound rather than a cap.
 */
export function candidateScoreBound(dimensions: number): number {
  // The bound is absolute in score space; float32 underflow of a normalized
  // component is covered by the same conservative accumulation envelope.
  const n = 4 * dimensions + 16;
  const u = 2 ** -24;
  return n * u >= 1 ? Infinity : (n * u) / (1 - n * u);
}

interface DecodedPoint {
  id: string;
  vector: Vector;
  metadata?: Record<string, unknown>;
  usable: boolean;
}

function jsonToken(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new QdrantProtocolError("Qdrant payload value is not JSON serializable");
  }
  return encoded;
}

function payloadObject(value: unknown): Payload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new QdrantProtocolError("Qdrant point payload is not an object");
  }
  return value as Payload;
}

function stringPayload(payload: Payload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") {
    throw new QdrantProtocolError(`Qdrant point payload field ${key} is missing or not a string`);
  }
  return value;
}

function booleanPayload(payload: Payload, key: string): boolean {
  const value = payload[key];
  if (typeof value !== "boolean") {
    throw new QdrantProtocolError(`Qdrant point payload field ${key} is missing or not a boolean`);
  }
  return value;
}

function termsPayload(payload: Payload): string[] {
  const value = payload[PAYLOAD_TERMS];
  if (!Array.isArray(value) || value.some((term) => typeof term !== "string")) {
    throw new QdrantProtocolError("Qdrant point payload _mirk_terms is missing or malformed");
  }
  return value;
}

function encodeVector(vector: Vector): string {
  return vectorToBuffer(vector).toString("base64");
}

function vectorFromBase64(value: string, dimensions: number): Vector {
  const buffer = Buffer.from(value, "base64");
  if (buffer.byteLength !== dimensions * 4) {
    throw new QdrantProtocolError(
      `Qdrant point payload vector has ${buffer.byteLength} bytes; expected ${dimensions * 4}`,
    );
  }
  return bufferToVector(buffer);
}

function normalizedIndexVector(vector: Vector): number[] {
  if (!isUsableVector(vector)) return new Array<number>(vector.length).fill(0);
  let squaredNorm = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i] ?? 0;
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  const normalized = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) {
    normalized[i] = (vector[i] ?? 0) / norm;
  }
  return Array.from(normalized);
}

function hasNonFiniteComponent(vector: Vector): boolean {
  for (const value of vector) {
    if (!Number.isFinite(value)) return true;
  }
  return false;
}

function metadataTerms(metadata: Record<string, unknown>): string[] {
  return Object.entries(metadata).map(([key, value]) => jsonToken([key, value]));
}

function encodePayload(collection: string, document: VectorDocument): Payload {
  const metadataPresent = document.metadata !== undefined;
  const metadataText = metadataPresent ? jsonToken(document.metadata) : undefined;
  let persistedMetadata: Record<string, unknown> | undefined;
  if (metadataText !== undefined) {
    const decoded = decodeJsonToken(metadataText, PAYLOAD_METADATA);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new QdrantProtocolError("Qdrant metadata must serialize to an object");
    }
    persistedMetadata = decoded as Record<string, unknown>;
  }
  const payload: Payload = {
    [PAYLOAD_COLLECTION]: jsonToken(collection),
    [PAYLOAD_ID]: jsonToken(document.id),
    [PAYLOAD_VECTOR]: encodeVector(document.vector),
    [PAYLOAD_USABLE]: isUsableVector(document.vector),
    [PAYLOAD_HAS_METADATA]: metadataPresent,
    [PAYLOAD_TERMS]: persistedMetadata === undefined ? [] : metadataTerms(persistedMetadata),
  };
  if (metadataText !== undefined) payload[PAYLOAD_METADATA] = metadataText;
  return payload;
}

function decodeJsonToken(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new QdrantProtocolError(`Qdrant point payload field ${field} is not valid JSON: ${String(error)}`);
  }
}

function decodePoint(
  point: { id?: unknown; payload?: unknown },
  collection: string,
  dimensions: number,
): DecodedPoint {
  const payload = payloadObject(point.payload);
  const collectionToken = stringPayload(payload, PAYLOAD_COLLECTION);
  const idToken = stringPayload(payload, PAYLOAD_ID);
  const decodedCollection = decodeJsonToken(collectionToken, PAYLOAD_COLLECTION);
  const decodedId = decodeJsonToken(idToken, PAYLOAD_ID);
  if (decodedCollection !== collection || typeof decodedId !== "string") {
    throw new QdrantProtocolError("Qdrant point payload logical identity is invalid");
  }
  if (point.id !== pointIdFor(collection, decodedId)) {
    throw new QdrantProtocolError("Qdrant point UUID does not match its logical id");
  }
  const rawVector = vectorFromBase64(stringPayload(payload, PAYLOAD_VECTOR), dimensions);
  const usable = booleanPayload(payload, PAYLOAD_USABLE);
  if (usable !== isUsableVector(rawVector)) {
    throw new QdrantProtocolError("Qdrant point payload usability flag is inconsistent with the raw vector");
  }
  const hasMetadata = booleanPayload(payload, PAYLOAD_HAS_METADATA);
  const terms = termsPayload(payload);
  let metadata: Record<string, unknown> | undefined;
  if (hasMetadata) {
    const decodedMetadata = decodeJsonToken(stringPayload(payload, PAYLOAD_METADATA), PAYLOAD_METADATA);
    if (decodedMetadata === null || typeof decodedMetadata !== "object" || Array.isArray(decodedMetadata)) {
      throw new QdrantProtocolError("Qdrant point metadata is not an object");
    }
    metadata = decodedMetadata as Record<string, unknown>;
  } else if (PAYLOAD_METADATA in payload) {
    throw new QdrantProtocolError("Qdrant point metadata is present without its presence flag");
  }
  const expectedTerms = metadata === undefined ? [] : metadataTerms(metadata);
  if (terms.length !== expectedTerms.length || terms.some((term, index) => term !== expectedTerms[index])) {
    throw new QdrantProtocolError("Qdrant point metadata terms are inconsistent");
  }
  return { id: decodedId, vector: rawVector, metadata, usable };
}

function fieldMatch(key: string, value: string | boolean): Schemas["FieldCondition"] {
  return { key, match: { value } };
}

function metadataFilter(filter: Record<string, unknown>): Schemas["Filter"] {
  const must: Schemas["Condition"][] = [fieldMatch(PAYLOAD_HAS_METADATA, true)];
  for (const [key, value] of Object.entries(filter)) {
    must.push(fieldMatch(PAYLOAD_TERMS, jsonToken([key, value])));
  }
  return { must };
}

function scopedFilter(
  collection: string,
  options: Pick<VectorSearchOptions, "where" | "whereNot">,
): QdrantFilter {
  const must: Schemas["Condition"][] = [
    fieldMatch(PAYLOAD_COLLECTION, jsonToken(collection)),
    fieldMatch(PAYLOAD_USABLE, true),
  ];
  if (options.where !== undefined) {
    must.push(metadataFilter(options.where));
  }
  const filter: QdrantFilter = { must };
  if (options.whereNot !== undefined) {
    filter.must_not = [metadataFilter(options.whereNot)];
  }
  return filter;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as Record<string, unknown>;
  const direct = value.status ?? value.statusCode;
  if (typeof direct === "number") return direct;
  const response = value.response;
  if (typeof response === "object" && response !== null) {
    const responseStatus = (response as Record<string, unknown>).status;
    if (typeof responseStatus === "number") return responseStatus;
  }
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

function hasAlreadyExistsMessage(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return /already\s+exists?/i.test(messageOf(error));
  const value = error as Record<string, unknown>;
  const data = value.data;
  const nestedError = typeof data === "object" && data !== null
    ? (data as Record<string, unknown>).status
    : undefined;
  const texts = [
    messageOf(error),
    typeof value.statusText === "string" ? value.statusText : "",
    typeof nestedError === "object" && nestedError !== null
      ? String((nestedError as Record<string, unknown>).error ?? "")
      : "",
  ];
  return texts.some((text) => /already\s+exists?/i.test(text));
}

function isAlreadyExistsError(error: unknown): boolean {
  const status = statusOf(error);
  return (status === 409 || status === 400) && hasAlreadyExistsMessage(error);
}

function vectorParams(
  collectionName: string,
  info: Schemas["CollectionInfo"],
): Schemas["VectorParams"] {
  const vectors = info.config.params.vectors;
  if (vectors === undefined || vectors === null || typeof vectors !== "object" || Array.isArray(vectors)) {
    throw new QdrantCollectionError(`Qdrant collection ${collectionName} has no unnamed vector configuration`);
  }
  if ("size" in vectors && "distance" in vectors) return vectors as Schemas["VectorParams"];
  throw new QdrantCollectionError(`Qdrant collection ${collectionName} has named vectors; an unnamed vector is required`);
}

function validateCollection(
  collectionName: string,
  info: Schemas["CollectionInfo"],
  dimensions: number,
): void {
  const params = vectorParams(collectionName, info);
  if (params.size !== dimensions || params.distance !== "Dot") {
    throw new QdrantCollectionError(
      `Qdrant collection ${collectionName} has vector size/distance ${params.size}/${params.distance}; expected ${dimensions}/Dot`,
    );
  }
  if (params.datatype !== undefined && params.datatype !== null && params.datatype !== "float32") {
    throw new QdrantCollectionError(
      `Qdrant collection ${collectionName} has vector datatype ${String(params.datatype)}; expected float32`,
    );
  }
  if (params.multivector_config !== undefined && params.multivector_config !== null) {
    throw new QdrantCollectionError(`Qdrant collection ${collectionName} has multivector configuration; a single vector is required`);
  }
}

async function ensureIndexes(
  client: QdrantClient,
  collectionName: string,
  info: Schemas["CollectionInfo"],
): Promise<void> {
  const missing: Array<(typeof INDEX_FIELDS)[number]> = [];
  for (const [fieldName, fieldSchema] of INDEX_FIELDS) {
    const existing = info.payload_schema[fieldName];
    if (existing !== undefined) {
      if (existing.data_type !== fieldSchema) {
        throw new QdrantCollectionError(
          `Qdrant collection ${collectionName} index ${fieldName} has type ${existing.data_type}; expected ${fieldSchema}`,
        );
      }
      continue;
    }
    missing.push([fieldName, fieldSchema] as (typeof INDEX_FIELDS)[number]);
  }
  for (const [fieldName, fieldSchema] of missing) {
    await client.createPayloadIndex(collectionName, {
      field_name: fieldName,
      field_schema: fieldSchema,
      wait: true,
    });
  }
}

function sliceTopK<T>(values: T[], topK: number): T[] {
  return values.slice(0, topK);
}

/** AsyncVectorStore backed by one host-selected, dedicated Qdrant collection. */
export class QdrantVectorStore implements AsyncVectorStore {
  readonly meta: VectorStoreMeta;
  private readonly client: QdrantClient;
  private readonly collectionName: string;
  private readonly dimensions: number;
  private readonly pageSize: number;

  private constructor(
    client: QdrantClient,
    collectionName: string,
    dimensions: number,
    pageSize: number,
  ) {
    this.client = client;
    this.collectionName = collectionName;
    this.dimensions = dimensions;
    this.pageSize = pageSize;
    this.meta = { backend: "qdrant", dimensions, accelerated: true };
  }

  static async open(
    client: QdrantClient,
    options: { collectionName: string; dimensions: number; pageSize?: number },
  ): Promise<QdrantVectorStore> {
    const { collectionName, dimensions } = options;
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new VectorInputError("invalid-dimensions", `Vector dimensions must be a positive integer; got ${dimensions}`);
    }
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new QdrantCollectionError(`Qdrant pageSize must be a positive integer; got ${pageSize}`);
    }

    const existence = await client.collectionExists(collectionName);
    if (!existence.exists) {
      try {
        await client.createCollection(collectionName, {
          vectors: { size: dimensions, distance: "Dot" },
        });
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
    }

    const info = await client.getCollection(collectionName);
    validateCollection(collectionName, info, dimensions);
    await ensureIndexes(client, collectionName, info);
    return new QdrantVectorStore(client, collectionName, dimensions, pageSize);
  }

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
    for (const doc of docs) assertDimensions(doc.vector, this.dimensions);
    const points: QdrantPoint[] = docs.map((doc) => ({
      id: pointIdFor(collection, doc.id),
      vector: normalizedIndexVector(doc.vector),
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
    const records = await this.client.retrieve(this.collectionName, {
      ids: [pointIdFor(collection, id)],
      with_payload: true,
      with_vector: false,
    });
    const record = records[0];
    if (record === undefined) return null;
    const decoded = decodePoint(record, collection, this.dimensions);
    if (decoded.id !== id) {
      throw new QdrantProtocolError("Qdrant point payload original id does not match the requested id");
    }
    return {
      id: decoded.id,
      vector: decoded.vector,
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
      points: [pointIdFor(collection, id)],
      wait: true,
    });
    return true;
  }

  async count(collection: string): Promise<number> {
    const result = await this.client.count(this.collectionName, {
      exact: true,
      filter: { must: [fieldMatch(PAYLOAD_COLLECTION, jsonToken(collection))] },
    });
    return result.count;
  }

  async search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    options?: VectorSearchOptions,
  ): Promise<VectorSearchResult<M>[]> {
    assertDimensions(query, this.dimensions);
    const topK = options?.topK ?? 10;
    if (Number.isNaN(topK) || topK === 0 || topK === -Infinity || (topK > 0 && topK < 1)) return [];
    if (!Number.isFinite(topK) && topK !== Infinity && topK !== -Infinity) return [];
    if (hasNonFiniteComponent(query)) return [];

    const minScore = options?.minScore;
    const indexedQuery = normalizedIndexVector(query);
    const filter = scopedFilter(collection, options ?? {});
    const bound = candidateScoreBound(this.dimensions);
    const positiveK = Number.isFinite(topK) && topK > 0 ? Math.trunc(topK) : undefined;
    let candidates: VectorSearchResult<M>[] = [];
    let requestLimit = this.pageSize;

    while (true) {
      const response = await this.client.query(this.collectionName, {
        query: indexedQuery,
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
        const decoded = decodePoint(point, collection, this.dimensions);
        if (pageIds.has(decoded.id)) throw new QdrantProtocolError("Qdrant returned duplicate points in a native prefix");
        pageIds.add(decoded.id);
        if (!decoded.usable) throw new QdrantProtocolError("Qdrant returned an unusable point despite the usable filter");
        if (!Number.isFinite(point.score)) throw new QdrantProtocolError("Qdrant returned a non-finite native score");
        const score = cosineSimilarity(query, decoded.vector);
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
    return sliceTopK(candidates, topK);
  }
}

export type { AsyncVectorStore, Vector, VectorDocument, VectorSearchOptions, VectorSearchResult, VectorStoreMeta } from "@mirk/store/vector";
