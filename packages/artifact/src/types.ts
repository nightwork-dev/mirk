export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ByteSource = Uint8Array | AsyncIterable<Uint8Array>;
export type ByteStream = AsyncIterable<Uint8Array>;

export interface ArtifactDigest {
  algorithm: "sha256";
  value: string;
}

export interface ArtifactProducer {
  system: string;
  operation?: string;
  jobId?: string;
  attemptId?: string;
  outputSlot?: string;
  evidenceRef?: string;
}

export interface ArtifactDescriptor {
  id: string;
  mediaType: string;
  sizeBytes: number;
  digest: ArtifactDigest;
  kind?: string;
  filename?: string;
  createdAt: number;
  producer?: ArtifactProducer;
  annotations?: Record<string, JsonValue>;
}

export interface StoredArtifactRecord extends ArtifactDescriptor {
  objectKey: string;
  idempotencyKey?: string;
  idempotencyFingerprint?: string;
  /** Internal receipt digest retained across mutable annotation updates. */
  idempotencyFinalizationDigest?: string;
}

export interface ArtifactLineageEdge {
  id: string;
  sourceArtifactId: string;
  resultArtifactId: string;
  operation: string;
  parameters?: Record<string, JsonValue>;
  producer?: ArtifactProducer;
  createdAt: number;
}

export interface ObjectInfo {
  key: string;
  sizeBytes: number;
  mediaType?: string;
  digest?: ArtifactDigest;
  etag?: string;
  lastModifiedAt?: number;
  metadata?: Record<string, string>;
}

export interface ObjectPutOptions {
  mediaType?: string;
  metadata?: Record<string, string>;
  ifAbsent?: boolean;
}

export interface ObjectStore {
  put(
    key: string,
    bytes: ByteSource,
    options?: ObjectPutOptions
  ): Promise<ObjectInfo>;
  get(key: string): Promise<ByteStream | undefined>;
  head(key: string): Promise<ObjectInfo | undefined>;
  delete(key: string): Promise<boolean>;
}

/** Optional capability used by maintenance. Keys remain an adapter concern. */
export interface ListableObjectStore extends ObjectStore {
  list(prefix?: string): Promise<readonly ObjectInfo[]>;
}

export interface ArtifactQuery {
  mediaType?: string;
  mediaTypePrefix?: string;
  kind?: string;
  producerSystem?: string;
  producerJobId?: string;
  producerAttemptId?: string;
  producerOutputSlot?: string;
  createdAfter?: number;
  createdBefore?: number;
  limit?: number;
  cursor?: string;
}

export interface StoredArtifactPage {
  items: readonly StoredArtifactRecord[];
  nextCursor?: string;
}

export interface ArtifactRepository {
  create(record: StoredArtifactRecord): Promise<void>;
  get(id: string): Promise<StoredArtifactRecord | undefined>;
  getByDigest(digest: ArtifactDigest): Promise<readonly StoredArtifactRecord[]>;
  getByIdempotencyKey(key: string): Promise<StoredArtifactRecord | undefined>;
  list(query?: ArtifactQuery): Promise<StoredArtifactPage>;
  updateAnnotations(
    id: string,
    patch: Record<string, JsonValue | undefined>
  ): Promise<StoredArtifactRecord>;
  delete(id: string): Promise<boolean>;
  addLineage(edge: ArtifactLineageEdge): Promise<void>;
  getSources(id: string): Promise<readonly ArtifactLineageEdge[]>;
  getDerivatives(id: string): Promise<readonly ArtifactLineageEdge[]>;
  /** Optional maintenance primitive. Ordinary consumers should use coordinator APIs. */
  removeLineage?(id: string): Promise<boolean>;
}

export type ArtifactCoordinatorConcurrency =
  | { mode: "single-writer" }
  | { mode: "repository-atomic" };

export type ArtifactAtomicCreateResult =
  | { status: "created"; requestDigest: string; record: StoredArtifactRecord }
  | {
      status: "replayed";
      requestDigest: string;
      record: StoredArtifactRecord;
    }
  | {
      status: "conflict";
      expectedRequestDigest: string;
      receivedRequestDigest: string;
    };

export interface AtomicArtifactRepository extends ArtifactRepository {
  /** Runtime capability marker for store-backed repositories. */
  readonly atomicAvailable?: boolean;
  createIdempotent(input: {
    record: StoredArtifactRecord;
    idempotencyKey: string;
  }): Promise<ArtifactAtomicCreateResult>;
}

export type ArtifactLeaseMode = "shared-writer" | "exclusive-delete";

export interface ArtifactObjectLease {
  leaseId: string;
  ownerId: string;
  objectKey: string;
  mode: ArtifactLeaseMode;
  generation: number;
  heartbeatAt: number;
  expiresAt: number;
}

export type ArtifactLeaseResult =
  | { status: "acquired"; lease: ArtifactObjectLease }
  | {
      status: "conflict" | "unavailable";
      reason:
        | "exclusive-held"
        | "shared-held"
        | "reference-created"
        | "expired";
    };

export type ArtifactLeaseCreateResult =
  | { status: "created" }
  | { status: "lease-lost" }
  | { status: "conflict" };

export type ArtifactLeaseAtomicCreateResult =
  | ArtifactAtomicCreateResult
  | { status: "lease-lost" };

/** Repository-owned cooperative exclusion for Mirk finalization and repair. */
export interface ArtifactLeaseRepository {
  acquireObjectLease(input: {
    objectKey: string;
    ownerId: string;
    mode: ArtifactLeaseMode;
    ttlMs?: number;
    now?: number;
  }): Promise<ArtifactLeaseResult>;
  renewObjectLease(input: {
    leaseId: string;
    ownerId: string;
    objectKey: string;
    mode: ArtifactLeaseMode;
    generation: number;
    ttlMs?: number;
    now?: number;
  }): Promise<ArtifactLeaseResult>;
  releaseObjectLease(lease: ArtifactObjectLease): Promise<boolean>;
  /**
   * Commit a record while proving that the shared writer lease is still
   * current. Implementations must perform the lease check and record creation
   * in one repository decision point.
   */
  createWithLease?(input: {
    record: StoredArtifactRecord;
    lease: ArtifactObjectLease;
    now?: number;
  }): Promise<ArtifactLeaseCreateResult>;
  createIdempotentWithLease?(input: {
    record: StoredArtifactRecord;
    idempotencyKey: string;
    lease: ArtifactObjectLease;
    now?: number;
  }): Promise<ArtifactLeaseAtomicCreateResult>;
}

export interface ArtifactSourceInput {
  artifactId: string;
  operation: string;
  parameters?: Record<string, JsonValue>;
  producer?: ArtifactProducer;
}

export interface WriteArtifactInput {
  bytes: ByteSource;
  mediaType: string;
  kind?: string;
  filename?: string;
  producer?: ArtifactProducer;
  annotations?: Record<string, JsonValue>;
  sources?: readonly ArtifactSourceInput[];
  idempotencyKey?: string;
}

export interface ImportArtifactInput extends Omit<WriteArtifactInput, "bytes"> {
  objectKey: string;
}

export interface ArtifactReadResult {
  artifact: ArtifactDescriptor;
  bytes: ByteStream;
}

export interface ArtifactVerification {
  artifact: ArtifactDescriptor;
  ok: boolean;
  actualDigest?: ArtifactDigest;
  actualSizeBytes?: number;
  reason?: "object-missing" | "digest-mismatch" | "size-mismatch";
}
