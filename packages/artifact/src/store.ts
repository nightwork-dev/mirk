import {
  supportsAsyncAtomicMutation,
  type AsyncAtomicMutationStore,
  type AsyncStore,
  type AtomicStoreOperation,
  type JsonObject as StoreJsonObject,
  type JsonValue as StoreJsonValue,
  type StoreCondition,
} from "@mirk/store/kv";
import type {
  ArtifactDigest,
  ArtifactAtomicCreateResult,
  ArtifactLeaseAtomicCreateResult,
  ArtifactLeaseCreateResult,
  ArtifactLeaseMode,
  ArtifactLeaseRepository,
  ArtifactLeaseResult,
  ArtifactLineageEdge,
  ArtifactObjectLease,
  ArtifactQuery,
  AtomicArtifactRepository,
  JsonValue,
  StoredArtifactPage,
  StoredArtifactRecord,
} from "./types.js";
import {
  ArtifactConflictError,
  compareRecords,
  cursorOffset,
  encodeCursor,
  matches,
} from "./memory.js";
import {
  artifactFinalizationDigest,
  assertBoundedJson,
  cloneJson,
} from "./util.js";

export interface StoreArtifactRepositoryOptions {
  namespace?: string;
  now?: () => number;
}

type LeaseState = {
  generation: number;
  mode: "none" | "shared" | "exclusive";
  leases: readonly ArtifactObjectLease[];
};

/** Artifact metadata over the generic async Mirk store, including optional atomic hardening. */
export class StoreArtifactRepository
  implements AtomicArtifactRepository, ArtifactLeaseRepository
{
  readonly atomicAvailable: boolean;
  readonly #records: string;
  readonly #edges: string;
  readonly #idempotencyPrefix: string;
  readonly #leaseStatePrefix: string;
  readonly #leases: string;
  readonly #now: () => number;

  constructor(
    readonly store: AsyncStore,
    options: StoreArtifactRepositoryOptions = {}
  ) {
    const prefix = options.namespace ?? "mirk-artifacts";
    this.#records = `${prefix}:records`;
    this.#edges = `${prefix}:lineage`;
    this.#idempotencyPrefix = `${prefix}:idempotency:`;
    this.#leaseStatePrefix = `${prefix}:lease-state:`;
    this.#leases = `${prefix}:leases`;
    this.#now = options.now ?? Date.now;
    this.atomicAvailable = supportsAsyncAtomicMutation(store);
  }

  async create(record: StoredArtifactRecord): Promise<void> {
    if (await this.get(record.id))
      throw new ArtifactConflictError(`artifact already exists: ${record.id}`);
    if (
      record.idempotencyKey &&
      (await this.getByIdempotencyKey(record.idempotencyKey))
    )
      throw new ArtifactConflictError(
        `idempotency key already exists: ${record.idempotencyKey}`
      );
    await this.store.put(this.#records, cloneJson(record));
  }
  async get(id: string): Promise<StoredArtifactRecord | undefined> {
    return (
      (await this.store.getById<StoredArtifactRecord>(this.#records, id)) ??
      undefined
    );
  }
  async getByDigest(
    digest: ArtifactDigest
  ): Promise<readonly StoredArtifactRecord[]> {
    return (await this.store.list<StoredArtifactRecord>(this.#records))
      .filter(
        (record) =>
          record.digest.algorithm === digest.algorithm &&
          record.digest.value === digest.value
      )
      .map(cloneJson);
  }
  async getByIdempotencyKey(
    key: string
  ): Promise<StoredArtifactRecord | undefined> {
    return (await this.store.list<StoredArtifactRecord>(this.#records)).find(
      (record) => record.idempotencyKey === key
    );
  }
  async list(query: ArtifactQuery = {}): Promise<StoredArtifactPage> {
    const ordered = (await this.store.list<StoredArtifactRecord>(this.#records))
      .filter((record) => matches(record, query))
      .sort(compareRecords);
    const after = cursorOffset(ordered, query.cursor);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const items = ordered.slice(after, after + limit);
    return {
      items: items.map(cloneJson),
      ...(after + limit < ordered.length && items.length
        ? { nextCursor: encodeCursor(items[items.length - 1]!) }
        : {}),
    };
  }
  async updateAnnotations(
    id: string,
    patch: Record<string, JsonValue | undefined>
  ): Promise<StoredArtifactRecord> {
    const record = await this.get(id);
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
    return this.store.put(this.#records, updated);
  }
  async delete(id: string): Promise<boolean> {
    if (!(await this.store.remove(this.#records, id))) return false;
    for (const edge of await this.store.list<ArtifactLineageEdge>(this.#edges))
      if (edge.sourceArtifactId === id || edge.resultArtifactId === id)
        await this.store.remove(this.#edges, edge.id);
    return true;
  }
  async addLineage(edge: ArtifactLineageEdge): Promise<void> {
    if (await this.store.getById(this.#edges, edge.id))
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
      (await this.#reaches(edge.resultArtifactId, edge.sourceArtifactId))
    )
      throw new ArtifactConflictError("lineage cycle forbidden");
    if (edge.parameters)
      assertBoundedJson(edge.parameters, "lineage parameters");
    await this.store.put(this.#edges, cloneJson(edge));
  }
  async removeLineage(id: string): Promise<boolean> {
    return this.store.remove(this.#edges, id);
  }
  async getSources(id: string): Promise<readonly ArtifactLineageEdge[]> {
    return (await this.store.list<ArtifactLineageEdge>(this.#edges))
      .filter((edge) => edge.resultArtifactId === id)
      .map(cloneJson);
  }
  async getDerivatives(id: string): Promise<readonly ArtifactLineageEdge[]> {
    return (await this.store.list<ArtifactLineageEdge>(this.#edges))
      .filter((edge) => edge.sourceArtifactId === id)
      .map(cloneJson);
  }

  async createIdempotent(input: {
    record: StoredArtifactRecord;
    idempotencyKey: string;
  }): Promise<ArtifactAtomicCreateResult> {
    const atomic = this.#atomic();
    const requestDigest = artifactFinalizationDigest(input.record);
    const indexKey = this.#idempotencyKey(input.idempotencyKey);
    const prior = await this.store.get<{
      requestDigest: string;
      recordId: string;
    }>(indexKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest)
        return {
          status: "conflict",
          expectedRequestDigest: prior.requestDigest,
          receivedRequestDigest: requestDigest,
        };
      const record = await this.get(prior.recordId);
      if (!record)
        return {
          status: "conflict",
          expectedRequestDigest: prior.requestDigest,
          receivedRequestDigest: requestDigest,
        };
      return { status: "replayed", requestDigest, record };
    }
    const legacy = await this.getByIdempotencyKey(input.idempotencyKey);
    if (legacy) {
      const legacyDigest = artifactFinalizationDigest(legacy);
      if (legacyDigest !== requestDigest)
        return {
          status: "conflict",
          expectedRequestDigest: legacyDigest,
          receivedRequestDigest: requestDigest,
        };
      await this.store.set(indexKey, {
        requestDigest: legacyDigest,
        recordId: legacy.id,
      });
      return { status: "replayed", requestDigest, record: legacy };
    }
    const result = await atomic.mutateAtomically({
      conditions: [
        { target: { kind: "key", key: indexKey }, expected: "missing" },
        {
          target: {
            kind: "record",
            collection: this.#records,
            id: input.record.id,
          },
          expected: "missing",
        },
      ],
      operations: [
        {
          op: "put",
          collection: this.#records,
          item: cloneJson({
            ...input.record,
            idempotencyKey: input.idempotencyKey,
          }) as unknown as { id: string } & StoreJsonObject,
        },
        {
          op: "set",
          key: indexKey,
          value: { requestDigest, recordId: input.record.id },
        },
      ],
    });
    if (result.status === "conflict") {
      const raced = await this.store.get<{
        requestDigest: string;
        recordId: string;
      }>(indexKey);
      if (raced) {
        const record = await this.get(raced.recordId);
        if (record && raced.requestDigest === requestDigest)
          return { status: "replayed", requestDigest, record };
        return {
          status: "conflict",
          expectedRequestDigest: raced.requestDigest,
          receivedRequestDigest: requestDigest,
        };
      }
      const existing = await this.get(input.record.id);
      if (existing) {
        const existingDigest = artifactFinalizationDigest(existing);
        return {
          status: "conflict",
          expectedRequestDigest: existingDigest,
          receivedRequestDigest: requestDigest,
        };
      }
      throw new Error(
        "artifact idempotent mutation conflicted without a receipt"
      );
    }
    if (result.status !== "applied")
      throw new Error("artifact idempotent mutation was not applied");
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
    const atomic = this.#atomic();
    const now = input.now ?? this.#now();
    const ttlMs = Math.max(1, input.ttlMs ?? 30_000);
    const stateKey = this.#leaseStateKey(input.objectKey);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const current = await atomic.getVersioned<LeaseState>({
        kind: "key",
        key: stateKey,
      });
      const state = current?.value ?? {
        generation: 0,
        mode: "none" as const,
        leases: [] as readonly ArtifactObjectLease[],
      };
      const live = state.leases.filter((lease) => lease.expiresAt > now);
      const expired = state.leases.filter((lease) => lease.expiresAt <= now);
      if (
        input.mode === "shared-writer" &&
        live.some((lease) => lease.mode === "exclusive-delete")
      )
        return { status: "conflict", reason: "exclusive-held" };
      if (input.mode === "exclusive-delete") {
        if (live.some((lease) => lease.mode === "exclusive-delete"))
          return { status: "conflict", reason: "exclusive-held" };
        if (live.some((lease) => lease.mode === "shared-writer"))
          return { status: "unavailable", reason: "shared-held" };
        if ((await this.#objectReferences(input.objectKey)).length > 0)
          return { status: "conflict", reason: "reference-created" };
      }
      const lease: ArtifactObjectLease = {
        leaseId: `lease-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2)}`,
        ownerId: input.ownerId,
        objectKey: input.objectKey,
        mode: input.mode,
        generation: state.generation + (expired.length ? 1 : 0),
        heartbeatAt: now,
        expiresAt: now + ttlMs,
      };
      const next: LeaseState = {
        generation: lease.generation,
        mode: input.mode === "exclusive-delete" ? "exclusive" : "shared",
        leases: [...live, lease],
      };
      const conditions: StoreCondition[] = [
        current
          ? {
              target: { kind: "key", key: stateKey },
              expected: "version",
              version: current.version,
            }
          : { target: { kind: "key", key: stateKey }, expected: "missing" },
      ];
      const operations: AtomicStoreOperation[] = [
        { op: "set", key: stateKey, value: next as unknown as StoreJsonValue },
        {
          op: "put",
          collection: this.#leases,
          item: { ...lease, id: lease.leaseId } as unknown as {
            id: string;
          } & StoreJsonObject,
        },
      ];
      for (const old of expired)
        operations.push({
          op: "remove" as const,
          collection: this.#leases,
          id: old.leaseId,
        });
      const result = await atomic.mutateAtomically({ conditions, operations });
      if (result.status === "applied")
        return { status: "acquired", lease: cloneJson(lease) };
    }
    return { status: "unavailable", reason: "expired" };
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
    const atomic = this.#atomic();
    const now = input.now ?? this.#now();
    const stateKey = this.#leaseStateKey(input.objectKey);
    const current = await atomic.getVersioned<LeaseState>({
      kind: "key",
      key: stateKey,
    });
    const state = current?.value;
    const prior = state?.leases.find(
      (lease) => lease.leaseId === input.leaseId
    );
    if (
      !current ||
      !state ||
      !prior ||
      prior.ownerId !== input.ownerId ||
      prior.mode !== input.mode ||
      prior.generation !== input.generation ||
      prior.expiresAt <= now
    )
      return { status: "unavailable", reason: "expired" };
    const lease = {
      ...prior,
      heartbeatAt: now,
      expiresAt: now + Math.max(1, input.ttlMs ?? 30_000),
    };
    const next: LeaseState = {
      ...state,
      leases: state.leases.map((entry) =>
        entry.leaseId === lease.leaseId ? lease : entry
      ),
    };
    const result = await atomic.mutateAtomically({
      conditions: [
        {
          target: { kind: "key", key: stateKey },
          expected: "version",
          version: current.version,
        },
      ],
      operations: [
        { op: "set", key: stateKey, value: next as unknown as StoreJsonValue },
        {
          op: "put",
          collection: this.#leases,
          item: { ...lease, id: lease.leaseId } as unknown as {
            id: string;
          } & StoreJsonObject,
        },
      ],
    });
    return result.status === "applied"
      ? { status: "acquired", lease: cloneJson(lease) }
      : { status: "unavailable", reason: "expired" };
  }

  async releaseObjectLease(lease: ArtifactObjectLease): Promise<boolean> {
    const atomic = this.#atomic();
    const stateKey = this.#leaseStateKey(lease.objectKey);
    const current = await atomic.getVersioned<LeaseState>({
      kind: "key",
      key: stateKey,
    });
    const state = current?.value;
    if (
      !current ||
      !state ||
      !state.leases.some(
        (entry) =>
          entry.leaseId === lease.leaseId &&
          entry.ownerId === lease.ownerId &&
          entry.generation === lease.generation
      )
    )
      return false;
    const leases = state.leases.filter(
      (entry) => entry.leaseId !== lease.leaseId
    );
    const next: LeaseState = {
      generation: state.generation,
      mode: leases.some((entry) => entry.mode === "exclusive-delete")
        ? "exclusive"
        : leases.length
        ? "shared"
        : "none",
      leases,
    };
    const result = await atomic.mutateAtomically({
      conditions: [
        {
          target: { kind: "key", key: stateKey },
          expected: "version",
          version: current.version,
        },
      ],
      operations: [
        { op: "set", key: stateKey, value: next as unknown as StoreJsonValue },
        { op: "remove", collection: this.#leases, id: lease.leaseId },
      ],
    });
    return result.status === "applied";
  }

  async createIdempotentWithLease(input: {
    record: StoredArtifactRecord;
    idempotencyKey: string;
    lease: ArtifactObjectLease;
    now?: number;
  }): Promise<ArtifactLeaseAtomicCreateResult> {
    const atomic = this.#atomic();
    const requestDigest = artifactFinalizationDigest(input.record);
    const stateKey = this.#leaseStateKey(input.lease.objectKey);
    const current = await atomic.getVersioned<LeaseState>({
      kind: "key",
      key: stateKey,
    });
    const state = current?.value;
    const active = state?.leases.find(
      (lease) => lease.leaseId === input.lease.leaseId
    );
    if (
      !current ||
      !state ||
      !active ||
      active.ownerId !== input.lease.ownerId ||
      active.generation !== input.lease.generation ||
      active.mode !== "shared-writer" ||
      active.expiresAt <= (input.now ?? this.#now())
    )
      return { status: "lease-lost" };
    const indexKey = this.#idempotencyKey(input.idempotencyKey);
    const prior = await this.store.get<{
      requestDigest: string;
      recordId: string;
    }>(indexKey);
    if (prior) {
      if (prior.requestDigest !== requestDigest)
        return {
          status: "conflict",
          expectedRequestDigest: prior.requestDigest,
          receivedRequestDigest: requestDigest,
        };
      const record = await this.get(prior.recordId);
      return record
        ? { status: "replayed", requestDigest, record }
        : { status: "lease-lost" };
    }
    const result = await atomic.mutateAtomically({
      conditions: [
        {
          target: { kind: "key", key: stateKey },
          expected: "version",
          version: current.version,
        },
        { target: { kind: "key", key: indexKey }, expected: "missing" },
        {
          target: {
            kind: "record",
            collection: this.#records,
            id: input.record.id,
          },
          expected: "missing",
        },
      ],
      operations: [
        {
          op: "put",
          collection: this.#records,
          item: cloneJson({
            ...input.record,
            idempotencyKey: input.idempotencyKey,
          }) as unknown as { id: string } & StoreJsonObject,
        },
        {
          op: "set",
          key: indexKey,
          value: { requestDigest, recordId: input.record.id },
        },
      ],
    });
    if (result.status === "applied")
      return {
        status: "created",
        requestDigest,
        record: cloneJson({
          ...input.record,
          idempotencyKey: input.idempotencyKey,
        }),
      };
    const raced = await this.store.get<{
      requestDigest: string;
      recordId: string;
    }>(indexKey);
    if (raced) {
      const record = await this.get(raced.recordId);
      return raced.requestDigest === requestDigest && record
        ? { status: "replayed", requestDigest, record }
        : {
            status: "conflict",
            expectedRequestDigest: raced.requestDigest,
            receivedRequestDigest: requestDigest,
          };
    }
    return { status: "lease-lost" };
  }

  async createWithLease(input: {
    record: StoredArtifactRecord;
    lease: ArtifactObjectLease;
    now?: number;
  }): Promise<ArtifactLeaseCreateResult> {
    const atomic = this.#atomic();
    const stateKey = this.#leaseStateKey(input.lease.objectKey);
    const current = await atomic.getVersioned<LeaseState>({
      kind: "key",
      key: stateKey,
    });
    const state = current?.value;
    const active = state?.leases.find(
      (lease) => lease.leaseId === input.lease.leaseId
    );
    if (
      !current ||
      !state ||
      !active ||
      active.ownerId !== input.lease.ownerId ||
      active.objectKey !== input.lease.objectKey ||
      active.generation !== input.lease.generation ||
      active.mode !== "shared-writer" ||
      active.expiresAt <= (input.now ?? this.#now())
    )
      return { status: "lease-lost" };
    const result = await atomic.mutateAtomically({
      conditions: [
        {
          target: { kind: "key", key: stateKey },
          expected: "version",
          version: current.version,
        },
        {
          target: {
            kind: "record",
            collection: this.#records,
            id: input.record.id,
          },
          expected: "missing",
        },
      ],
      operations: [
        {
          op: "put",
          collection: this.#records,
          item: cloneJson(input.record) as unknown as {
            id: string;
          } & StoreJsonObject,
        },
      ],
    });
    if (result.status === "applied") return { status: "created" };
    if (result.status === "conflict") {
      const currentRecord = await this.get(input.record.id);
      return currentRecord ? { status: "conflict" } : { status: "lease-lost" };
    }
    return { status: "lease-lost" };
  }

  #atomic(): AsyncStore & AsyncAtomicMutationStore {
    if (!supportsAsyncAtomicMutation(this.store))
      throw new Error(
        "artifact repository atomic mutation is unavailable; use single-writer mode"
      );
    return this.store;
  }
  #idempotencyKey(key: string): string {
    return `${this.#idempotencyPrefix}${encodeURIComponent(key)}`;
  }
  #leaseStateKey(objectKey: string): string {
    return `${this.#leaseStatePrefix}${encodeURIComponent(objectKey)}`;
  }
  async #objectReferences(
    objectKey: string
  ): Promise<readonly StoredArtifactRecord[]> {
    return (await this.store.list<StoredArtifactRecord>(this.#records)).filter(
      (record) => record.objectKey === objectKey
    );
  }
  async #reaches(
    from: string,
    target: string,
    seen = new Set<string>()
  ): Promise<boolean> {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const edge of await this.getDerivatives(from))
      if (await this.#reaches(edge.resultArtifactId, target, seen)) return true;
    return false;
  }
}
