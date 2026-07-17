export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

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
  put(key: string, bytes: ByteSource, options?: ObjectPutOptions): Promise<ObjectInfo>;
  get(key: string): Promise<ByteStream | undefined>;
  head(key: string): Promise<ObjectInfo | undefined>;
  delete(key: string): Promise<boolean>;
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
  updateAnnotations(id: string, patch: Record<string, JsonValue | undefined>): Promise<StoredArtifactRecord>;
  delete(id: string): Promise<boolean>;
  addLineage(edge: ArtifactLineageEdge): Promise<void>;
  getSources(id: string): Promise<readonly ArtifactLineageEdge[]>;
  getDerivatives(id: string): Promise<readonly ArtifactLineageEdge[]>;
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
