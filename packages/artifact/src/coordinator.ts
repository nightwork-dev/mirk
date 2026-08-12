import type {
  ArtifactCoordinatorConcurrency,
  ArtifactDescriptor,
  ArtifactLeaseRepository,
  ArtifactLineageEdge,
  ArtifactObjectLease,
  ArtifactReadResult,
  ArtifactRepository,
  ArtifactVerification,
  AtomicArtifactRepository,
  ImportArtifactInput,
  ObjectStore,
  StoredArtifactRecord,
  WriteArtifactInput,
} from "./types.js";
import { ArtifactConflictError, ObjectAlreadyExistsError } from "./memory.js";
import {
  artifactFinalizationDigest,
  assertPortableMetadata,
  descriptor,
  digestStream,
  hashingStream,
  makeId,
  metadataFingerprint,
} from "./util.js";

export class ArtifactWriteError extends Error {
  constructor(
    message: string,
    readonly cleanup: "not-needed" | "succeeded" | "failed",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ArtifactWriteError";
  }
}

export interface ArtifactCoordinatorOptions {
  namespace?: string;
  idFactory?: () => string;
  now?: () => number;
  ownerId?: string;
  concurrency?: ArtifactCoordinatorConcurrency;
  leaseTtlMs?: number;
}

export class ArtifactCoordinator {
  readonly #namespace: string;
  readonly #idFactory: () => string;
  readonly #now: () => number;
  readonly #ownerId: string;
  readonly #concurrency: ArtifactCoordinatorConcurrency;
  readonly #leaseTtlMs: number;
  constructor(
    readonly objects: ObjectStore,
    readonly repository: ArtifactRepository,
    options: ArtifactCoordinatorOptions = {}
  ) {
    this.#namespace = options.namespace ?? "artifacts";
    this.#idFactory = options.idFactory ?? makeId;
    this.#now = options.now ?? Date.now;
    this.#ownerId =
      options.ownerId ??
      `artifact-coordinator-${Math.random().toString(36).slice(2)}`;
    this.#concurrency = options.concurrency ?? { mode: "single-writer" };
    this.#leaseTtlMs = Math.max(1, options.leaseTtlMs ?? 30_000);
    if (
      this.#concurrency.mode === "repository-atomic" &&
      !this.isAtomicRepository()
    )
      throw new TypeError(
        "repository-atomic concurrency requires AtomicArtifactRepository"
      );
  }

  async write(input: WriteArtifactInput): Promise<ArtifactDescriptor> {
    assertPortableMetadata(input);
    const fingerprint = this.#fingerprint(input);
    const repositoryIdempotencyKey = this.#repositoryIdempotencyKey(
      input.idempotencyKey
    );
    const prior = await this.#prior(repositoryIdempotencyKey, fingerprint);
    if (prior) {
      const actual = await digestStream(input.bytes);
      this.#assertFinalizationReplay(
        prior,
        input,
        actual.digest,
        actual.sizeBytes,
        fingerprint
      );
      return descriptor(prior);
    }
    const id = this.#idFactory();
    const objectKey = `${this.#namespace}/${id}`;
    const lease = await this.#acquireLease(
      objectKey,
      Boolean(repositoryIdempotencyKey)
    );
    let completed = false;
    try {
      let digest: StoredArtifactRecord["digest"] | undefined;
      let sizeBytes: number | undefined;
      let info: Awaited<ReturnType<ObjectStore["put"]>>;
      const preexistingObject = await this.objects.head(objectKey);
      try {
        info = await this.objects.put(
          objectKey,
          hashingStream(input.bytes, (nextDigest, nextSize) => {
            digest = nextDigest;
            sizeBytes = nextSize;
          }),
          { mediaType: input.mediaType, ifAbsent: true }
        );
      } catch (cause) {
        const cleanup =
          preexistingObject || cause instanceof ObjectAlreadyExistsError
            ? "not-needed"
            : (await this.#deleteOwnedObject(objectKey))
            ? "succeeded"
            : "failed";
        throw new ArtifactWriteError("artifact object write failed", cleanup, {
          cause,
        });
      }
      if (!digest || sizeBytes === undefined) {
        const cleaned = await this.#deleteOwnedObject(objectKey);
        throw new ArtifactWriteError(
          "object store did not consume the complete byte source",
          cleaned ? "succeeded" : "failed"
        );
      }
      if (info.sizeBytes !== sizeBytes) {
        const cleaned = await this.#deleteOwnedObject(objectKey);
        throw new ArtifactWriteError(
          `object store reported ${info.sizeBytes} bytes after ${sizeBytes} were streamed`,
          cleaned ? "succeeded" : "failed"
        );
      }
      const record: StoredArtifactRecord = {
        id,
        objectKey,
        createdAt: this.#now(),
        digest,
        sizeBytes,
        idempotencyFingerprint: fingerprint,
        ...portableFields(input, repositoryIdempotencyKey),
      };
      if (repositoryIdempotencyKey)
        record.idempotencyFinalizationDigest =
          artifactFinalizationDigest(record);
      const result = await this.#commit(
        record,
        input.sources,
        true,
        lease,
        repositoryIdempotencyKey
      );
      completed = true;
      return result;
    } finally {
      const released = await this.#releaseLease(lease);
      if (completed && !released)
        throw new ArtifactWriteError(
          "artifact object lease release failed",
          "failed"
        );
    }
  }

  async import(input: ImportArtifactInput): Promise<ArtifactDescriptor> {
    assertPortableMetadata(input);
    const fingerprint = this.#fingerprint(input);
    const repositoryIdempotencyKey = this.#repositoryIdempotencyKey(
      input.idempotencyKey
    );
    const prior = await this.#prior(repositoryIdempotencyKey, fingerprint);
    if (prior) {
      const bytes = await this.objects.get(input.objectKey);
      if (!bytes) throw new Error(`object not found: ${input.objectKey}`);
      const actual = await digestStream(bytes);
      this.#assertFinalizationReplay(
        prior,
        input,
        actual.digest,
        actual.sizeBytes,
        fingerprint
      );
      return descriptor(prior);
    }
    const lease = await this.#acquireLease(
      input.objectKey,
      Boolean(repositoryIdempotencyKey)
    );
    let completed = false;
    try {
      const bytes = await this.objects.get(input.objectKey);
      if (!bytes) throw new Error(`object not found: ${input.objectKey}`);
      const { digest, sizeBytes } = await digestStream(bytes);
      const record: StoredArtifactRecord = {
        id: this.#idFactory(),
        objectKey: input.objectKey,
        createdAt: this.#now(),
        digest,
        sizeBytes,
        idempotencyFingerprint: fingerprint,
        ...portableFields(input, repositoryIdempotencyKey),
      };
      if (repositoryIdempotencyKey)
        record.idempotencyFinalizationDigest =
          artifactFinalizationDigest(record);
      const result = await this.#commit(
        record,
        input.sources,
        false,
        lease,
        repositoryIdempotencyKey
      );
      completed = true;
      return result;
    } finally {
      const released = await this.#releaseLease(lease);
      if (completed && !released)
        throw new ArtifactWriteError(
          "artifact object lease release failed",
          "failed"
        );
    }
  }

  async read(id: string): Promise<ArtifactReadResult | undefined> {
    const record = await this.repository.get(id);
    if (!record) return undefined;
    const bytes = await this.objects.get(record.objectKey);
    if (!bytes) throw new Error(`artifact object missing: ${id}`);
    return { artifact: descriptor(record), bytes };
  }

  async verify(id: string): Promise<ArtifactVerification> {
    const record = await this.repository.get(id);
    if (!record) throw new Error(`artifact not found: ${id}`);
    const bytes = await this.objects.get(record.objectKey);
    if (!bytes)
      return {
        artifact: descriptor(record),
        ok: false,
        reason: "object-missing",
      };
    const actual = await digestStream(bytes);
    if (actual.sizeBytes !== record.sizeBytes)
      return {
        artifact: descriptor(record),
        ok: false,
        reason: "size-mismatch",
        actualDigest: actual.digest,
        actualSizeBytes: actual.sizeBytes,
      };
    if (actual.digest.value !== record.digest.value)
      return {
        artifact: descriptor(record),
        ok: false,
        reason: "digest-mismatch",
        actualDigest: actual.digest,
        actualSizeBytes: actual.sizeBytes,
      };
    return {
      artifact: descriptor(record),
      ok: true,
      actualDigest: actual.digest,
      actualSizeBytes: actual.sizeBytes,
    };
  }

  async delete(id: string): Promise<boolean> {
    const record = await this.repository.get(id);
    if (!record) return false;
    if (!(await this.repository.delete(id))) return false;
    if (await this.#hasObjectReference(record.objectKey)) return true;
    if (!(await this.objects.delete(record.objectKey)))
      throw new Error(
        `artifact metadata deleted but object deletion failed: ${id}`
      );
    return true;
  }

  async #hasObjectReference(objectKey: string): Promise<boolean> {
    let cursor: string | undefined;
    do {
      const page = await this.repository.list({
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      if (page.items.some((candidate) => candidate.objectKey === objectKey))
        return true;
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  }

  async #commit(
    record: StoredArtifactRecord,
    sources: WriteArtifactInput["sources"],
    cleanupObject = true,
    lease?: ArtifactObjectLease,
    repositoryIdempotencyKey?: string
  ): Promise<ArtifactDescriptor> {
    let createdRecord = false;
    let ownedObjectCleaned = false;
    try {
      let activeLease = lease;
      if (activeLease && this.isLeaseRepository()) {
        const renewed = await (
          this.repository as ArtifactRepository & ArtifactLeaseRepository
        ).renewObjectLease({
          ...activeLease,
          ttlMs: this.#leaseTtlMs,
          now: this.#now(),
        });
        if (renewed.status !== "acquired")
          throw new Error(
            "artifact object lease was lost before repository commit"
          );
        activeLease = renewed.lease;
      }
      let committed = record;
      let replayed = false;
      if (repositoryIdempotencyKey && this.isAtomicRepository()) {
        const atomic = this.repository as AtomicArtifactRepository;
        const leaseRepository = this.repository as ArtifactRepository &
          ArtifactLeaseRepository;
        if (
          activeLease &&
          this.isLeaseRepository() &&
          !leaseRepository.createIdempotentWithLease
        )
          throw new Error(
            "artifact repository cannot commit while holding an object lease"
          );
        const result =
          activeLease &&
          this.isLeaseRepository() &&
          leaseRepository.createIdempotentWithLease
            ? await leaseRepository.createIdempotentWithLease({
                record,
                idempotencyKey: repositoryIdempotencyKey,
                lease: activeLease,
                now: this.#now(),
              })
            : await atomic.createIdempotent({
                record,
                idempotencyKey: repositoryIdempotencyKey,
              });
        if (result.status === "lease-lost")
          throw new Error(
            "artifact object lease was lost before repository commit"
          );
        if (result.status === "conflict")
          throw new ArtifactConflictError(
            `idempotency key reused with incompatible metadata: ${repositoryIdempotencyKey}`
          );
        committed = result.record;
        replayed = result.status === "replayed";
        createdRecord = !replayed;
        if (replayed && committed.objectKey !== record.objectKey) {
          ownedObjectCleaned = await this.#deleteOwnedObject(record.objectKey);
          if (!ownedObjectCleaned)
            throw new ArtifactWriteError(
              "artifact replay cleanup failed",
              "failed"
            );
        }
      } else {
        if (activeLease && this.isLeaseRepository()) {
          const leaseRepository = this.repository as ArtifactRepository &
            ArtifactLeaseRepository;
          if (!leaseRepository.createWithLease)
            throw new Error(
              "artifact repository cannot commit while holding an object lease"
            );
          const result = await leaseRepository.createWithLease({
            record,
            lease: activeLease,
            now: this.#now(),
          });
          if (result.status === "lease-lost")
            throw new Error(
              "artifact object lease was lost before repository commit"
            );
          if (result.status === "conflict")
            throw new ArtifactConflictError(
              `artifact already exists: ${record.id}`
            );
        } else {
          await this.repository.create(record);
        }
        createdRecord = true;
      }
      if (!replayed)
        for (const source of sources ?? []) {
          const edge: ArtifactLineageEdge = {
            id: this.#idFactory(),
            sourceArtifactId: source.artifactId,
            resultArtifactId: committed.id,
            operation: source.operation,
            createdAt: committed.createdAt,
            ...(source.parameters ? { parameters: source.parameters } : {}),
            ...(source.producer ? { producer: source.producer } : {}),
          };
          await this.repository.addLineage(edge);
        }
      return descriptor(committed);
    } catch (cause) {
      if (createdRecord)
        await this.repository.delete(record.id).catch(() => false);
      const cleanup =
        cleanupObject && !ownedObjectCleaned
          ? (await this.#deleteOwnedObject(record.objectKey))
            ? "succeeded"
            : "failed"
          : cleanupObject
          ? "succeeded"
          : "not-needed";
      if (
        cause instanceof ArtifactConflictError &&
        repositoryIdempotencyKey &&
        cleanup !== "failed"
      )
        throw cause;
      if (cause instanceof ArtifactWriteError && cause.cleanup === "failed")
        throw cause;
      throw new ArtifactWriteError("artifact metadata commit failed", cleanup, {
        cause,
      });
    }
  }

  private isAtomicRepository(): boolean {
    const candidate = this.repository as Partial<AtomicArtifactRepository>;
    return (
      typeof candidate.createIdempotent === "function" &&
      candidate.atomicAvailable !== false
    );
  }
  private isLeaseRepository(): boolean {
    const candidate = this.repository as Partial<ArtifactLeaseRepository> &
      Partial<AtomicArtifactRepository>;
    return (
      typeof candidate.acquireObjectLease === "function" &&
      typeof candidate.releaseObjectLease === "function" &&
      candidate.atomicAvailable !== false
    );
  }
  async #acquireLease(
    objectKey: string,
    idempotent: boolean
  ): Promise<ArtifactObjectLease | undefined> {
    if (!this.isLeaseRepository()) return undefined;
    const leaseRepository = this.repository as ArtifactRepository &
      ArtifactLeaseRepository;
    if (
      (idempotent && !leaseRepository.createIdempotentWithLease) ||
      (!idempotent && !leaseRepository.createWithLease)
    ) {
      throw new ArtifactWriteError(
        "artifact repository cannot commit while holding an object lease",
        "not-needed"
      );
    }
    const result = await leaseRepository.acquireObjectLease({
      objectKey,
      ownerId: this.#ownerId,
      mode: "shared-writer",
      ttlMs: this.#leaseTtlMs,
      now: this.#now(),
    });
    if (result.status !== "acquired")
      throw new ArtifactWriteError(
        `artifact object lease unavailable: ${result.reason}`,
        "not-needed"
      );
    return result.lease;
  }
  async #releaseLease(
    lease: ArtifactObjectLease | undefined
  ): Promise<boolean> {
    if (!lease || !this.isLeaseRepository()) return true;
    return (this.repository as ArtifactRepository & ArtifactLeaseRepository)
      .releaseObjectLease(lease)
      .catch(() => false);
  }

  async #prior(
    key: string | undefined,
    fingerprint: string
  ): Promise<StoredArtifactRecord | undefined> {
    if (!key) return undefined;
    const prior = await this.repository.getByIdempotencyKey(key);
    if (prior && prior.idempotencyFingerprint !== fingerprint)
      throw new ArtifactConflictError(
        `idempotency key reused with incompatible metadata: ${key}`
      );
    return prior;
  }

  #assertFinalizationReplay(
    prior: StoredArtifactRecord,
    input: Omit<WriteArtifactInput, "bytes">,
    digest: StoredArtifactRecord["digest"],
    sizeBytes: number,
    fingerprint: string
  ): void {
    if (prior.idempotencyFingerprint !== fingerprint)
      throw new ArtifactConflictError(
        `idempotency key reused with incompatible metadata: ${
          prior.idempotencyKey ?? ""
        }`
      );
    const incoming = artifactFinalizationDigest({
      ...prior,
      ...portableFields(input, prior.idempotencyKey),
      digest,
      sizeBytes,
    });
    const expected =
      prior.idempotencyFinalizationDigest ?? artifactFinalizationDigest(prior);
    if (incoming !== expected)
      throw new ArtifactConflictError(
        `idempotency key reused with incompatible bytes: ${
          prior.idempotencyKey ?? ""
        }`
      );
  }

  async #deleteOwnedObject(objectKey: string): Promise<boolean> {
    try {
      if (await this.objects.delete(objectKey)) return true;
      return (await this.objects.head(objectKey)) === undefined;
    } catch {
      return false;
    }
  }

  #repositoryIdempotencyKey(key: string | undefined): string | undefined {
    return key === undefined
      ? undefined
      : `${encodeURIComponent(this.#namespace)}:${encodeURIComponent(key)}`;
  }

  #fingerprint(input: Omit<WriteArtifactInput, "bytes">): string {
    return metadataFingerprint({
      ...portableFields(input),
      ...(input.sources ? { sources: input.sources } : {}),
    });
  }
}

function portableFields(
  input: Omit<WriteArtifactInput, "bytes">,
  idempotencyKey?: string
) {
  return {
    mediaType: input.mediaType,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.producer ? { producer: input.producer } : {}),
    ...(input.annotations ? { annotations: input.annotations } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}
