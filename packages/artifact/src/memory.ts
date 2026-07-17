import type { ArtifactDigest, ArtifactLineageEdge, ArtifactQuery, ArtifactRepository, ByteSource, ByteStream, JsonValue, ObjectInfo, ObjectPutOptions, ObjectStore, StoredArtifactPage, StoredArtifactRecord } from "./types.js";
import { assertBoundedJson, assertObjectKey, chunks, cloneJson } from "./util.js";

export class ObjectAlreadyExistsError extends Error {
  constructor(key: string) { super(`object already exists: ${key}`); this.name = "ObjectAlreadyExistsError"; }
}

export class ArtifactConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ArtifactConflictError"; }
}

export class InMemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, { bytes: Uint8Array; info: ObjectInfo }>();

  async put(key: string, source: ByteSource, options: ObjectPutOptions = {}): Promise<ObjectInfo> {
    assertObjectKey(key);
    if (options.ifAbsent && this.#objects.has(key)) throw new ObjectAlreadyExistsError(key);
    const parts: Uint8Array[] = [];
    let sizeBytes = 0;
    for await (const part of chunks(source)) { parts.push(part.slice()); sizeBytes += part.byteLength; }
    const bytes = new Uint8Array(sizeBytes);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const info: ObjectInfo = { key, sizeBytes, ...(options.mediaType ? { mediaType: options.mediaType } : {}), ...(options.metadata ? { metadata: { ...options.metadata } } : {}) };
    this.#objects.set(key, { bytes, info });
    return cloneJson(info);
  }

  async get(key: string): Promise<ByteStream | undefined> {
    assertObjectKey(key);
    const found = this.#objects.get(key);
    if (!found) return undefined;
    const copy = found.bytes.slice();
    return (async function* () { yield copy; })();
  }

  async head(key: string): Promise<ObjectInfo | undefined> {
    assertObjectKey(key);
    const found = this.#objects.get(key);
    return found ? cloneJson(found.info) : undefined;
  }

  async delete(key: string): Promise<boolean> { assertObjectKey(key); return this.#objects.delete(key); }
}

export class InMemoryArtifactRepository implements ArtifactRepository {
  readonly #records = new Map<string, StoredArtifactRecord>();
  readonly #edges = new Map<string, ArtifactLineageEdge>();

  async create(record: StoredArtifactRecord): Promise<void> {
    if (this.#records.has(record.id)) throw new ArtifactConflictError(`artifact already exists: ${record.id}`);
    if (record.idempotencyKey && await this.getByIdempotencyKey(record.idempotencyKey)) throw new ArtifactConflictError(`idempotency key already exists: ${record.idempotencyKey}`);
    this.#records.set(record.id, cloneJson(record));
  }
  async get(id: string): Promise<StoredArtifactRecord | undefined> { const value = this.#records.get(id); return value ? cloneJson(value) : undefined; }
  async getByDigest(digest: ArtifactDigest): Promise<readonly StoredArtifactRecord[]> { return [...this.#records.values()].filter((record) => record.digest.algorithm === digest.algorithm && record.digest.value === digest.value).map((record) => cloneJson(record)); }
  async getByIdempotencyKey(key: string): Promise<StoredArtifactRecord | undefined> { const value = [...this.#records.values()].find((record) => record.idempotencyKey === key); return value ? cloneJson(value) : undefined; }
  async list(query: ArtifactQuery = {}): Promise<StoredArtifactPage> {
    const ordered = [...this.#records.values()].filter((record) => matches(record, query)).sort(compareRecords);
    const after = cursorOffset(ordered, query.cursor);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const items = ordered.slice(after, after + limit);
    return { items: items.map((item) => cloneJson(item)), ...(after + limit < ordered.length && items.length ? { nextCursor: encodeCursor(items[items.length - 1]!) } : {}) };
  }
  async updateAnnotations(id: string, patch: Record<string, JsonValue | undefined>): Promise<StoredArtifactRecord> {
    const record = this.#records.get(id);
    if (!record) throw new Error(`artifact not found: ${id}`);
    const annotations = { ...(record.annotations ?? {}) };
    for (const [key, value] of Object.entries(patch)) value === undefined ? delete annotations[key] : annotations[key] = value;
    assertBoundedJson(annotations, "annotations");
    const updated = { ...record, ...(Object.keys(annotations).length ? { annotations } : { annotations: undefined }) } as StoredArtifactRecord;
    this.#records.set(id, updated);
    return cloneJson(updated);
  }
  async delete(id: string): Promise<boolean> {
    if (!this.#records.delete(id)) return false;
    for (const [edgeId, edge] of this.#edges) if (edge.sourceArtifactId === id || edge.resultArtifactId === id) this.#edges.delete(edgeId);
    return true;
  }
  async addLineage(edge: ArtifactLineageEdge): Promise<void> {
    if (this.#edges.has(edge.id)) throw new ArtifactConflictError(`lineage edge already exists: ${edge.id}`);
    if (edge.sourceArtifactId === edge.resultArtifactId || await reaches(this, edge.resultArtifactId, edge.sourceArtifactId)) throw new ArtifactConflictError("lineage cycle forbidden");
    if (!await this.get(edge.sourceArtifactId) || !await this.get(edge.resultArtifactId)) throw new Error("lineage endpoints must exist");
    if (edge.parameters) assertBoundedJson(edge.parameters, "lineage parameters");
    this.#edges.set(edge.id, cloneJson(edge));
  }
  async getSources(id: string): Promise<readonly ArtifactLineageEdge[]> { return [...this.#edges.values()].filter((edge) => edge.resultArtifactId === id).map((edge) => cloneJson(edge)); }
  async getDerivatives(id: string): Promise<readonly ArtifactLineageEdge[]> { return [...this.#edges.values()].filter((edge) => edge.sourceArtifactId === id).map((edge) => cloneJson(edge)); }
}

export function compareRecords(a: StoredArtifactRecord, b: StoredArtifactRecord): number { return b.createdAt - a.createdAt || b.id.localeCompare(a.id); }
export function encodeCursor(record: StoredArtifactRecord): string { return `${record.createdAt}:${record.id}`; }
export function cursorOffset(records: readonly StoredArtifactRecord[], cursor: string | undefined): number { if (!cursor) return 0; const index = records.findIndex((record) => encodeCursor(record) === cursor); if (index < 0) throw new Error("invalid artifact cursor"); return index + 1; }
export function matches(record: StoredArtifactRecord, query: ArtifactQuery): boolean {
  return !(query.mediaType && record.mediaType !== query.mediaType) && !(query.mediaTypePrefix && !record.mediaType.startsWith(query.mediaTypePrefix)) && !(query.kind && record.kind !== query.kind) && !(query.producerSystem && record.producer?.system !== query.producerSystem) && !(query.producerJobId && record.producer?.jobId !== query.producerJobId) && !(query.producerAttemptId && record.producer?.attemptId !== query.producerAttemptId) && !(query.producerOutputSlot && record.producer?.outputSlot !== query.producerOutputSlot) && !(query.createdAfter !== undefined && record.createdAt <= query.createdAfter) && !(query.createdBefore !== undefined && record.createdAt >= query.createdBefore);
}
async function reaches(repository: ArtifactRepository, from: string, target: string, seen = new Set<string>()): Promise<boolean> {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  for (const edge of await repository.getDerivatives(from)) if (await reaches(repository, edge.resultArtifactId, target, seen)) return true;
  return false;
}
