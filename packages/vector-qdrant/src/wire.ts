import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import {
  bufferToVector,
  isUsableVector,
  vectorToBuffer,
} from "@mirk/store/vector";
import type {
  Vector,
  VectorDocument,
  VectorSearchOptions,
} from "@mirk/store/vector";

const WIRE_VERSION = "mirk-vector-qdrant-v1";
export const DEFAULT_PAGE_SIZE = 256;
export const PAYLOAD_COLLECTION = "_mirk_collection";
const PAYLOAD_ID = "_mirk_id";
const PAYLOAD_VECTOR = "_mirk_vectors";
const PAYLOAD_USABLE = "_mirk_usable_spaces";
const PAYLOAD_HAS_METADATA = "_mirk_has_metadata";
const PAYLOAD_METADATA = "_mirk_metadata";
const PAYLOAD_TERMS = "_mirk_terms";
const INDEX_FIELDS = [
  [PAYLOAD_COLLECTION, "keyword"],
  [PAYLOAD_TERMS, "keyword"],
  [PAYLOAD_USABLE, "keyword"],
  [PAYLOAD_HAS_METADATA, "bool"],
] as const;

type Payload = Record<string, unknown>;
type QdrantFilter = Schemas["Filter"];

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
  vectors: Record<string, Vector>;
  metadata?: Record<string, unknown>;
}

export function jsonToken(value: unknown): string {
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

export function normalizedIndexVector(vector: Vector): number[] {
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

export function hasNonFiniteComponent(vector: Vector): boolean {
  for (const value of vector) {
    if (!Number.isFinite(value)) return true;
  }
  return false;
}

function metadataTerms(metadata: Record<string, unknown>): string[] {
  return Object.entries(metadata).map(([key, value]) => jsonToken([key, value]));
}

export function encodePayload(collection: string, document: VectorDocument): Payload {
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
    [PAYLOAD_VECTOR]: JSON.stringify(Object.fromEntries(Object.entries(document.vectors).map(([name, vector]) => [name, encodeVector(vector)]))),
    [PAYLOAD_USABLE]: Object.entries(document.vectors).filter(([, vector]) => isUsableVector(vector)).map(([name]) => jsonToken(name)),
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

export function decodePoint(
  point: { id?: unknown; payload?: unknown },
  collection: string,
  spaces: Map<string, number>,
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
  const encoded = decodeJsonToken(stringPayload(payload, PAYLOAD_VECTOR), PAYLOAD_VECTOR);
  const vectors: Record<string, Vector> = {};
  for (const [name, value] of Object.entries(payloadObject(encoded))) {
    const dimensions = spaces.get(name);
    if (dimensions === undefined || typeof value !== "string") throw new QdrantProtocolError("Unknown or malformed vector space");
    Object.defineProperty(vectors, name, { value: vectorFromBase64(value, dimensions), enumerable: true, writable: true, configurable: true });
  }
  const usable = payload[PAYLOAD_USABLE];
  const expectedUsable = Object.entries(vectors).filter(([, vector]) => isUsableVector(vector)).map(([name]) => jsonToken(name));
  if (!Array.isArray(usable) || JSON.stringify(usable) !== JSON.stringify(expectedUsable)) throw new QdrantProtocolError("Vector usability flags are inconsistent");
  if (Object.keys(vectors).length === 0) throw new QdrantProtocolError("Document has no vectors");
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
  return { id: decodedId, vectors, metadata };
}

export function fieldMatch(key: string, value: string | boolean): Schemas["FieldCondition"] {
  return { key, match: { value } };
}

function metadataFilter(filter: Record<string, unknown>): Schemas["Filter"] {
  const must: Schemas["Condition"][] = [fieldMatch(PAYLOAD_HAS_METADATA, true)];
  for (const [key, value] of Object.entries(filter)) {
    must.push(fieldMatch(PAYLOAD_TERMS, jsonToken([key, value])));
  }
  return { must };
}

export function scopedFilter(
  collection: string,
  options: Pick<VectorSearchOptions, "where" | "whereNot">,
  space: string,
): QdrantFilter {
  const must: Schemas["Condition"][] = [
    fieldMatch(PAYLOAD_COLLECTION, jsonToken(collection)),
    fieldMatch(PAYLOAD_USABLE, jsonToken(space)),
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

export function isAlreadyExistsError(error: unknown): boolean {
  const status = statusOf(error);
  return (status === 409 || status === 400) && hasAlreadyExistsMessage(error);
}

export function namedParams(info: Schemas["CollectionInfo"]): Record<string, Schemas["VectorParams"]> {
  const vectors = info.config.params.vectors;
  if (vectors === undefined || vectors === null || "size" in vectors) {
    throw new QdrantCollectionError("Legacy unnamed Qdrant vectors require explicit migration to named vectors; existing data was not changed");
  }
  return vectors as Record<string, Schemas["VectorParams"]>;
}

export function nativeName(namespace: string, space: string): string {
  return "mirk_" + Buffer.from(JSON.stringify([namespace, space])).toString("base64url");
}

export async function ensureIndexes(
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

