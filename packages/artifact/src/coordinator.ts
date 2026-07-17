import type { ArtifactDescriptor, ArtifactLineageEdge, ArtifactReadResult, ArtifactRepository, ArtifactVerification, ImportArtifactInput, ObjectStore, StoredArtifactRecord, WriteArtifactInput } from "./types.js";
import { ArtifactConflictError } from "./memory.js";
import { assertPortableMetadata, descriptor, digestStream, hashingStream, makeId, metadataFingerprint } from "./util.js";

export class ArtifactWriteError extends Error {
  constructor(message: string, readonly cleanup: "not-needed" | "succeeded" | "failed", options?: ErrorOptions) { super(message, options); this.name = "ArtifactWriteError"; }
}

export interface ArtifactCoordinatorOptions {
  namespace?: string;
  idFactory?: () => string;
  now?: () => number;
}

export class ArtifactCoordinator {
  readonly #namespace: string;
  readonly #idFactory: () => string;
  readonly #now: () => number;
  constructor(readonly objects: ObjectStore, readonly repository: ArtifactRepository, options: ArtifactCoordinatorOptions = {}) {
    this.#namespace = options.namespace ?? "artifacts";
    this.#idFactory = options.idFactory ?? makeId;
    this.#now = options.now ?? Date.now;
  }

  async write(input: WriteArtifactInput): Promise<ArtifactDescriptor> {
    assertPortableMetadata(input);
    const fingerprint = this.#fingerprint(input);
    const prior = await this.#prior(input.idempotencyKey, fingerprint);
    if (prior) return descriptor(prior);
    const id = this.#idFactory();
    const objectKey = `${this.#namespace}/${id}`;
    let digest: StoredArtifactRecord["digest"] | undefined;
    let sizeBytes: number | undefined;
    const info = await this.objects.put(objectKey, hashingStream(input.bytes, (nextDigest, nextSize) => { digest = nextDigest; sizeBytes = nextSize; }), { mediaType: input.mediaType, ifAbsent: true });
    if (!digest || sizeBytes === undefined) throw new ArtifactWriteError("object store did not consume the complete byte source", "not-needed");
    if (info.sizeBytes !== sizeBytes) {
      const cleaned = await this.objects.delete(objectKey).catch(() => false);
      throw new ArtifactWriteError(`object store reported ${info.sizeBytes} bytes after ${sizeBytes} were streamed`, cleaned ? "succeeded" : "failed");
    }
    return this.#commit({ id, objectKey, createdAt: this.#now(), digest, sizeBytes, idempotencyFingerprint: fingerprint, ...portableFields(input) }, input.sources);
  }

  async import(input: ImportArtifactInput): Promise<ArtifactDescriptor> {
    assertPortableMetadata(input);
    const fingerprint = this.#fingerprint(input);
    const prior = await this.#prior(input.idempotencyKey, fingerprint);
    if (prior) return descriptor(prior);
    const bytes = await this.objects.get(input.objectKey);
    if (!bytes) throw new Error(`object not found: ${input.objectKey}`);
    const { digest, sizeBytes } = await digestStream(bytes);
    return this.#commit({ id: this.#idFactory(), objectKey: input.objectKey, createdAt: this.#now(), digest, sizeBytes, idempotencyFingerprint: fingerprint, ...portableFields(input) }, input.sources, false);
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
    if (!bytes) return { artifact: descriptor(record), ok: false, reason: "object-missing" };
    const actual = await digestStream(bytes);
    if (actual.sizeBytes !== record.sizeBytes) return { artifact: descriptor(record), ok: false, reason: "size-mismatch", actualDigest: actual.digest, actualSizeBytes: actual.sizeBytes };
    if (actual.digest.value !== record.digest.value) return { artifact: descriptor(record), ok: false, reason: "digest-mismatch", actualDigest: actual.digest, actualSizeBytes: actual.sizeBytes };
    return { artifact: descriptor(record), ok: true, actualDigest: actual.digest, actualSizeBytes: actual.sizeBytes };
  }

  async delete(id: string): Promise<boolean> {
    const record = await this.repository.get(id);
    if (!record) return false;
    if (!await this.repository.delete(id)) return false;
    if (await this.#hasObjectReference(record.objectKey)) return true;
    if (!await this.objects.delete(record.objectKey)) throw new Error(`artifact metadata deleted but object deletion failed: ${id}`);
    return true;
  }

  async #hasObjectReference(objectKey: string): Promise<boolean> {
    let cursor: string | undefined;
    do {
      const page = await this.repository.list({ limit: 500, ...(cursor ? { cursor } : {}) });
      if (page.items.some((candidate) => candidate.objectKey === objectKey)) return true;
      cursor = page.nextCursor;
    } while (cursor);
    return false;
  }

  async #commit(record: StoredArtifactRecord, sources: WriteArtifactInput["sources"], cleanupObject = true): Promise<ArtifactDescriptor> {
    try {
      await this.repository.create(record);
      for (const source of sources ?? []) {
        const edge: ArtifactLineageEdge = { id: this.#idFactory(), sourceArtifactId: source.artifactId, resultArtifactId: record.id, operation: source.operation, createdAt: record.createdAt, ...(source.parameters ? { parameters: source.parameters } : {}), ...(source.producer ? { producer: source.producer } : {}) };
        await this.repository.addLineage(edge);
      }
      return descriptor(record);
    } catch (cause) {
      await this.repository.delete(record.id).catch(() => false);
      const cleanup = cleanupObject
        ? (await this.objects.delete(record.objectKey).catch(() => false) ? "succeeded" : "failed")
        : "not-needed";
      throw new ArtifactWriteError("artifact metadata commit failed", cleanup, { cause });
    }
  }

  async #prior(key: string | undefined, fingerprint: string): Promise<StoredArtifactRecord | undefined> {
    if (!key) return undefined;
    const prior = await this.repository.getByIdempotencyKey(key);
    if (prior && prior.idempotencyFingerprint !== fingerprint) throw new ArtifactConflictError(`idempotency key reused with incompatible metadata: ${key}`);
    return prior;
  }

  #fingerprint(input: Omit<WriteArtifactInput, "bytes">): string {
    return metadataFingerprint({ ...portableFields(input), ...(input.sources ? { sources: input.sources } : {}) });
  }
}

function portableFields(input: Omit<WriteArtifactInput, "bytes">) {
  return { mediaType: input.mediaType, ...(input.kind ? { kind: input.kind } : {}), ...(input.filename ? { filename: input.filename } : {}), ...(input.producer ? { producer: input.producer } : {}), ...(input.annotations ? { annotations: input.annotations } : {}), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) };
}
