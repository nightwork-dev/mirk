import type {
  ArtifactDigest,
  ArtifactAtomicCreateResult,
  ArtifactLeaseAtomicCreateResult,
  ArtifactLeaseCreateResult,
  ArtifactLineageEdge,
  ArtifactLeaseMode,
  ArtifactLeaseRepository,
  ArtifactLeaseResult,
  ArtifactObjectLease,
  ArtifactQuery,
  ArtifactRepository,
  AtomicArtifactRepository,
  ByteSource,
  ByteStream,
  JsonValue,
  ListableObjectStore,
  ObjectInfo,
  ObjectPutOptions,
  StoredArtifactPage,
  StoredArtifactRecord,
} from "./types.js";
import {
  artifactFinalizationDigest,
  assertBoundedJson,
  assertObjectKey,
  chunks,
  cloneJson,
} from "./util.js";
import { compareCodePoints } from "@mirk/store";

export class ObjectAlreadyExistsError extends Error {
  constructor(key: string) {
    super(`object already exists: ${key}`);
    this.name = "ObjectAlreadyExistsError";
  }
}

export class ArtifactConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactConflictError";
  }
}

export class InMemoryObjectStore implements ListableObjectStore {
  readonly #objects = new Map<
    string,
    { bytes: Uint8Array; info: ObjectInfo }
  >();

  async put(
    key: string,
    source: ByteSource,
    options: ObjectPutOptions = {}
  ): Promise<ObjectInfo> {
    assertObjectKey(key);
    if (options.ifAbsent && this.#objects.has(key))
      throw new ObjectAlreadyExistsError(key);
    const parts: Uint8Array[] = [];
    let sizeBytes = 0;
    for await (const part of chunks(source)) {
      parts.push(part.slice());
      sizeBytes += part.byteLength;
    }
    const bytes = new Uint8Array(sizeBytes);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    const info: ObjectInfo = {
      key,
      sizeBytes,
      ...(options.mediaType ? { mediaType: options.mediaType } : {}),
      ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
    };
    this.#objects.set(key, { bytes, info });
    return cloneJson(info);
  }

  async get(key: string): Promise<ByteStream | undefined> {
    assertObjectKey(key);
    const found = this.#objects.get(key);
    if (!found) return undefined;
    const copy = found.bytes.slice();
    return (async function* () {
      yield copy;
    })();
  }

  async head(key: string): Promise<ObjectInfo | undefined> {
    assertObjectKey(key);
    const found = this.#objects.get(key);
    return found ? cloneJson(found.info) : undefined;
  }

  async delete(key: string): Promise<boolean> {
    assertObjectKey(key);
    return this.#objects.delete(key);
  }
  async list(prefix = ""): Promise<readonly ObjectInfo[]> {
    if (prefix) assertObjectKey(prefix);
    return [...this.#objects.values()]
      .filter(({ info }) => info.key.startsWith(prefix))
      .map(({ info }) => cloneJson(info))
      .sort((a, b) => compareCodePoints(a.key, b.key));
  }
}

export class InMemoryArtifactRepository
  implements AtomicArtifactRepository, ArtifactLeaseRepository
{
  readonly atomicAvailable = true;
  readonly #records = new Map<string, StoredArtifactRecord>();
  readonly #edges = new Map<string, ArtifactLineageEdge>();
  readonly #receipts = new Map<
    string,
    { requestDigest: string; recordId: string }
  >();
  readonly #leases = new Map<string, ArtifactObjectLease>();
  readonly #generations = new Map<string, number>();
  readonly #leaseIdFactory: () => string;
  readonly #now: () => number;
  constructor(
    options: { leaseIdFactory?: () => string; now?: () => number } = {}
  ) {
    this.#leaseIdFactory =
      options.leaseIdFactory ??
      (() => `lease-${Math.random().toString(36).slice(2)}`);
    this.#now = options.now ?? Date.now;
  }

  async create(record: StoredArtifactRecord): Promise<void> {
    if (this.#records.has(record.id))
      throw new ArtifactConflictError(`artifact already exists: ${record.id}`);
    if (
      record.idempotencyKey &&
      (await this.getByIdempotencyKey(record.idempotencyKey))
    )
      throw new ArtifactConflictError(
        `idempotency key already exists: ${record.idempotencyKey}`
      );
    this.#records.set(record.id, cloneJson(record));
  }
  async get(id: string): Promise<StoredArtifactRecord | undefined> {
    const value = this.#records.get(id);
    return value ? cloneJson(value) : undefined;
  }
  async getByDigest(
    digest: ArtifactDigest
  ): Promise<readonly StoredArtifactRecord[]> {
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.digest.algorithm === digest.algorithm &&
          record.digest.value === digest.value
      )
      .map((record) => cloneJson(record));
  }
  async getByIdempotencyKey(
    key: string
  ): Promise<StoredArtifactRecord | undefined> {
    const value = [...this.#records.values()].find(
      (record) => record.idempotencyKey === key
    );
    return value ? cloneJson(value) : undefined;
  }
  async list(query: ArtifactQuery = {}): Promise<StoredArtifactPage> {
    const ordered = [...this.#records.values()]
      .filter((record) => matches(record, query))
      .sort(compareRecords);
    const after = cursorOffset(ordered, query.cursor);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const items = ordered.slice(after, after + limit);
    return {
      items: items.map((item) => cloneJson(item)),
      ...(after + limit < ordered.length && items.length
        ? { nextCursor: encodeCursor(items[items.length - 1]!) }
        : {}),
    };
  }
  async updateAnnotations(
    id: string,
    patch: Record<string, JsonValue | undefined>
  ): Promise<StoredArtifactRecord> {
    const record = this.#records.get(id);
    if (!record) throw new Error(`artifact not found: ${id}`);
    const annotations = { ...(record.annotations ?? {}) };
    for (const [key, value] of Object.entries(patch))
      value === undefined
        ? delete annotations[key]
        : (annotations[key] = value);
    assertBoundedJson(annotations, "annotations");
    const updated = {
      ...record,
      ...(Object.keys(annotations).length
        ? { annotations }
        : { annotations: undefined }),
    } as StoredArtifactRecord;
    this.#records.set(id, updated);
    return cloneJson(updated);
  }
  async delete(id: string): Promise<boolean> {
    if (!this.#records.delete(id)) return false;
    for (const [edgeId, edge] of this.#edges)
      if (edge.sourceArtifactId === id || edge.resultArtifactId === id)
        this.#edges.delete(edgeId);
    return true;
  }
  async createIdempotent(input: {
    record: StoredArtifactRecord;
    idempotencyKey: string;
  }): Promise<ArtifactAtomicCreateResult> {
    const requestDigest = artifactFinalizationDigest(input.record);
    const prior = this.#receipts.get(input.idempotencyKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest)
        return {
          status: "conflict",
          expectedRequestDigest: prior.requestDigest,
          receivedRequestDigest: requestDigest,
        };
      const record = this.#records.get(prior.recordId);
      if (!record)
        return {
          status: "conflict",
          expectedRequestDigest: prior.requestDigest,
          receivedRequestDigest: requestDigest,
        };
      return { status: "replayed", requestDigest, record: cloneJson(record) };
    }
    const existing = [...this.#records.values()].find(
      (record) => record.idempotencyKey === input.idempotencyKey
    );
    if (existing) {
      const priorDigest = artifactFinalizationDigest(existing);
      if (priorDigest !== requestDigest)
        return {
          status: "conflict",
          expectedRequestDigest: priorDigest,
          receivedRequestDigest: requestDigest,
        };
      this.#receipts.set(input.idempotencyKey, {
        requestDigest: priorDigest,
        recordId: existing.id,
      });
      return { status: "replayed", requestDigest, record: existing };
    }
    const sameId = this.#records.get(input.record.id);
    if (sameId) {
      const existingDigest = artifactFinalizationDigest(sameId);
      return {
        status: "conflict",
        expectedRequestDigest: existingDigest,
        receivedRequestDigest: requestDigest,
      };
    }
    this.#records.set(
      input.record.id,
      cloneJson({ ...input.record, idempotencyKey: input.idempotencyKey })
    );
    this.#receipts.set(input.idempotencyKey, {
      requestDigest,
      recordId: input.record.id,
    });
    return {
      status: "created",
      requestDigest,
      record: cloneJson({
        ...input.record,
        idempotencyKey: input.idempotencyKey,
      }),
    };
  }

  async acquireObjectLease(input: {
    objectKey: string;
    ownerId: string;
    mode: ArtifactLeaseMode;
    ttlMs?: number;
    now?: number;
  }): Promise<ArtifactLeaseResult> {
    const now = input.now ?? this.#now();
    const ttlMs = Math.max(1, input.ttlMs ?? 30_000);
    this.#reclaimExpired(input.objectKey, now);
    const active = [...this.#leases.values()].filter(
      (lease) => lease.objectKey === input.objectKey && lease.expiresAt > now
    );
    if (
      input.mode === "shared-writer" &&
      active.some((lease) => lease.mode === "exclusive-delete")
    )
      return { status: "conflict", reason: "exclusive-held" };
    if (input.mode === "exclusive-delete") {
      if (active.some((lease) => lease.mode === "exclusive-delete"))
        return { status: "conflict", reason: "exclusive-held" };
      if (active.some((lease) => lease.mode === "shared-writer"))
        return { status: "unavailable", reason: "shared-held" };
      if (
        [...this.#records.values()].some(
          (record) => record.objectKey === input.objectKey
        )
      )
        return { status: "conflict", reason: "reference-created" };
    }
    const generation = this.#generations.get(input.objectKey) ?? 0;
    const lease: ArtifactObjectLease = {
      leaseId: this.#leaseIdFactory(),
      ownerId: input.ownerId,
      objectKey: input.objectKey,
      mode: input.mode,
      generation,
      heartbeatAt: now,
      expiresAt: now + ttlMs,
    };
    this.#leases.set(lease.leaseId, lease);
    return { status: "acquired", lease: cloneJson(lease) };
  }

  async renewObjectLease(input: {
    leaseId: string;
    ownerId: string;
    objectKey: string;
    mode: ArtifactLeaseMode;
    generation: number;
    ttlMs?: number;
    now?: number;
  }): Promise<ArtifactLeaseResult> {
    const now = input.now ?? this.#now();
    const current = this.#leases.get(input.leaseId);
    if (
      !current ||
      current.ownerId !== input.ownerId ||
      current.objectKey !== input.objectKey ||
      current.mode !== input.mode ||
      current.generation !== input.generation ||
      current.expiresAt <= now
    )
      return { status: "unavailable", reason: "expired" };
    const lease = {
      ...current,
      heartbeatAt: now,
      expiresAt: now + Math.max(1, input.ttlMs ?? 30_000),
    };
    this.#leases.set(lease.leaseId, lease);
    return { status: "acquired", lease: cloneJson(lease) };
  }

  async releaseObjectLease(lease: ArtifactObjectLease): Promise<boolean> {
    const current = this.#leases.get(lease.leaseId);
    if (
      !current ||
      current.ownerId !== lease.ownerId ||
      current.generation !== lease.generation ||
      current.objectKey !== lease.objectKey
    )
      return false;
    this.#leases.delete(lease.leaseId);
    return true;
  }

  async createIdempotentWithLease(input: {
    record: StoredArtifactRecord;
    idempotencyKey: string;
    lease: ArtifactObjectLease;
    now?: number;
  }): Promise<ArtifactLeaseAtomicCreateResult> {
    const now = input.now ?? this.#now();
    if (!this.#holdsSharedWriterLease(input.lease, now))
      return { status: "lease-lost" };
    return this.createIdempotent({
      record: input.record,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async createWithLease(input: {
    record: StoredArtifactRecord;
    lease: ArtifactObjectLease;
    now?: number;
  }): Promise<ArtifactLeaseCreateResult> {
    const now = input.now ?? this.#now();
    if (!this.#holdsSharedWriterLease(input.lease, now))
      return { status: "lease-lost" };
    if (this.#records.has(input.record.id)) return { status: "conflict" };
    if (
      input.record.idempotencyKey &&
      [...this.#records.values()].some(
        (record) => record.idempotencyKey === input.record.idempotencyKey
      )
    )
      return { status: "conflict" };
    this.#records.set(input.record.id, cloneJson(input.record));
    return { status: "created" };
  }

  async removeLineage(id: string): Promise<boolean> {
    return this.#edges.delete(id);
  }

  #reclaimExpired(objectKey: string, now: number): void {
    let reclaimed = false;
    for (const [id, lease] of this.#leases)
      if (lease.objectKey === objectKey && lease.expiresAt <= now) {
        this.#leases.delete(id);
        reclaimed = true;
      }
    if (reclaimed)
      this.#generations.set(
        objectKey,
        (this.#generations.get(objectKey) ?? 0) + 1
      );
  }

  #holdsSharedWriterLease(lease: ArtifactObjectLease, now: number): boolean {
    const current = this.#leases.get(lease.leaseId);
    return Boolean(
      current &&
        current.ownerId === lease.ownerId &&
        current.objectKey === lease.objectKey &&
        current.generation === lease.generation &&
        current.mode === "shared-writer" &&
        current.expiresAt > now
    );
  }

  async addLineage(edge: ArtifactLineageEdge): Promise<void> {
    if (this.#edges.has(edge.id))
      throw new ArtifactConflictError(
        `lineage edge already exists: ${edge.id}`
      );
    if (
      !(await this.get(edge.sourceArtifactId)) ||
      !(await this.get(edge.resultArtifactId))
    )
      throw new Error("lineage endpoints must exist");
    if (
      edge.sourceArtifactId === edge.resultArtifactId ||
      (await reaches(this, edge.resultArtifactId, edge.sourceArtifactId))
    )
      throw new ArtifactConflictError("lineage cycle forbidden");
    if (edge.parameters)
      assertBoundedJson(edge.parameters, "lineage parameters");
    this.#edges.set(edge.id, cloneJson(edge));
  }
  async getSources(id: string): Promise<readonly ArtifactLineageEdge[]> {
    return [...this.#edges.values()]
      .filter((edge) => edge.resultArtifactId === id)
      .map((edge) => cloneJson(edge));
  }
  async getDerivatives(id: string): Promise<readonly ArtifactLineageEdge[]> {
    return [...this.#edges.values()]
      .filter((edge) => edge.sourceArtifactId === id)
      .map((edge) => cloneJson(edge));
  }
}

export function compareRecords(
  a: StoredArtifactRecord,
  b: StoredArtifactRecord
): number {
  return b.createdAt - a.createdAt || compareCodePoints(b.id, a.id);
}
export function encodeCursor(record: StoredArtifactRecord): string {
  return `${record.createdAt}:${record.id}`;
}
export function cursorOffset(
  records: readonly StoredArtifactRecord[],
  cursor: string | undefined
): number {
  if (!cursor) return 0;
  const index = records.findIndex((record) => encodeCursor(record) === cursor);
  if (index < 0) throw new Error("invalid artifact cursor");
  return index + 1;
}
export function matches(
  record: StoredArtifactRecord,
  query: ArtifactQuery
): boolean {
  return (
    !(query.mediaType && record.mediaType !== query.mediaType) &&
    !(
      query.mediaTypePrefix &&
      !record.mediaType.startsWith(query.mediaTypePrefix)
    ) &&
    !(query.kind && record.kind !== query.kind) &&
    !(
      query.producerSystem && record.producer?.system !== query.producerSystem
    ) &&
    !(query.producerJobId && record.producer?.jobId !== query.producerJobId) &&
    !(
      query.producerAttemptId &&
      record.producer?.attemptId !== query.producerAttemptId
    ) &&
    !(
      query.producerOutputSlot &&
      record.producer?.outputSlot !== query.producerOutputSlot
    ) &&
    !(
      query.createdAfter !== undefined && record.createdAt <= query.createdAfter
    ) &&
    !(
      query.createdBefore !== undefined &&
      record.createdAt >= query.createdBefore
    )
  );
}
async function reaches(
  repository: ArtifactRepository,
  from: string,
  target: string,
  seen = new Set<string>()
): Promise<boolean> {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  for (const edge of await repository.getDerivatives(from))
    if (await reaches(repository, edge.resultArtifactId, target, seen))
      return true;
  return false;
}
