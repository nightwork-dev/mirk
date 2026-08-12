# `@mirk/artifact` public package specification

**Status:** core, store, filesystem, OpenDAL, atomic finalization, object leases, and maintenance
are implemented locally; publication and consumer adoption need separate evidence
**Package:** `@mirk/artifact`
**Roadmap:** MR-10
**Horizon:** near
**Related primitives:** `@mirk/store/kv`, Mirk source adapters

## Summary

`@mirk/artifact` is the domain-neutral substrate for durable, addressable outputs: images, audio,
video, documents, archives, model files, generated reports, transcripts, intermediate renders, and
other byte-bearing results that need stable identity, integrity, metadata, provenance, and lineage.

It owns two things:

1. an object-storage port for physical bytes; and
2. an artifact repository and coordinator that bind immutable bytes to durable metadata.

It does **not** own generation, queues, providers, workers, retries, approval, publication, or
application-specific attachment. Those responsibilities remain above the package:

```text
Mirk
  bytes, object storage, artifact identity, integrity, metadata, lineage

Execution systems
  jobs, attempts, providers, workers, leases, progress, cancellation, operations

Consuming applications
  intent, semantic attachment, approval, placement, publication, canon
```

## Why this belongs in Mirk

Artifacts are stored evidence, not execution policy.

The same primitive serves uploads, generated media, transformed derivatives, archives, reports,
and other durable byte-bearing results without embedding any one consumer's semantics.

## Goals

1. **Stable artifact identity.** Consumers reference an artifact ID, never a provider URL or local
   machine path.
2. **Integrity by construction.** Stored bytes and recorded digest/size cannot silently disagree.
3. **Immutable finalized content.** Replacing bytes creates a new artifact; metadata corrections do
   not rewrite content history.
4. **Portable object storage.** Local memory/filesystem and remote object stores implement the same
   core byte contract.
5. **Durable metadata over Mirk.** Artifact records use `@mirk/store/kv` collections rather than
   introducing another generic metadata database abstraction.
6. **Lineage without domain policy.** Derivatives can identify their sources and the operation that
   produced them without Mirk understanding image generation, transcription, publishing, or canon.
7. **Streaming large objects.** Core APIs must not require buffering a video or model entirely in
   memory.
8. **Capability-based adapters.** Listing, signed URLs, server-side copy, and multipart upload are
   optional facets, not mandatory methods every backend must fake.
9. **Backend parity.** In-memory and store-backed references define ordering, filtering, conflict,
   and deletion behavior for all metadata adapters.
10. **Migration without data loss.** Existing records and objects remain addressable throughout
    adoption.
11. **Domain-neutral public surfaces.** Package names, records, examples, diagnostics, and tests
    must not encode a consuming application, execution system, provider, or specific media workflow.

## Non-goals

- A background job framework.
- A provider registry, health monitor, or resource scheduler.
- A generator or transform plugin system.
- A progress-event stream.
- Retry, priority, cancellation, batch, or schedule policy.
- Product approval, adjudication, publication, or lifecycle state.
- Entity, document, scene, character, message, or knowledge-graph attachment.
- A media taxonomy. `mediaType` is standardized; `kind` is an opaque consumer vocabulary.
- A CDN, image proxy, transcoder, thumbnailer, or delivery service.
- A secret store. Adapter credentials are configuration, never artifact metadata.
- A second general persistence layer beside `@mirk/store`.
- Automatic garbage collection without consumer-supplied reachability or retention policy.

## Terminology

### Object

Physical bytes stored under an adapter-owned key. An object has byte size, media type, digest, and
optional backend metadata. Object keys are infrastructure details and must not become product IDs.

### Artifact

A durable record that gives stored bytes stable identity and portable metadata. An artifact may
represent an imported source, generated output, derivative, archive, or intermediate result.

An artifact exists only after its bytes have been written and verified. A queued or failed request
is a job, not an artifact.

### Source

An artifact used to produce another artifact.

### Lineage edge

An immutable relationship recording that one artifact was derived from another through an opaque,
typed operation.

### Attachment

A product-owned record giving an artifact semantic meaning, such as “portrait for character X” or
“accepted cover for edition Y.” Attachments do not belong in Mirk.

## Ownership boundary

| Concern                                   | Owner                    | Notes                                                                     |
| ----------------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Object bytes and storage keys             | Mirk                     | Through object-store ports and adapters                                   |
| Artifact ID, digest, size, media type     | Mirk                     | Portable identity and integrity                                           |
| Generic metadata and annotations          | Mirk                     | Bounded, JSON-safe, non-secret                                            |
| Source/derivative lineage                 | Mirk                     | Opaque operation and parameters                                           |
| Provider request/response evidence        | Execution system         | May reference artifacts                                                   |
| Job status, retry, priority, cancellation | Execution system         | Never encoded as artifact status                                          |
| Execution resource leases                 | Execution system         | Scheduling and worker capacity; not storage exclusion                     |
| Repository object leases                  | Mirk artifact repository | Cooperative shared-writer/exclusive-deletion exclusion for artifact bytes |
| Progress and logs                         | Execution system         | May themselves be persisted as artifacts when useful                      |
| Domain association                        | Consuming application    | References an artifact ID                                                 |
| Proposed/accepted/rejected state          | Consuming application    | Successful storage is not approval                                        |
| Public delivery policy                    | Consumer or deployment   | Signed URLs are an adapter capability, not authorization                  |

## Standards alignment

The primitive should interoperate with established community models rather than invent competing
meanings:

- `mediaType`, byte size, and digest should project mechanically to an
  [OCI content descriptor](https://github.com/opencontainers/image-spec/blob/main/descriptor.md)
  when a consumer needs registry distribution. Mirk does not adopt OCI repository, tag, manifest,
  or HTTP distribution semantics as its application storage model.
- An artifact is compatible with a [W3C PROV Entity](https://www.w3.org/TR/prov-dm/), and a physical
  lineage edge is compatible with `wasDerivedFrom`. Activities, agents, generation intent, and
  execution evidence stay above Mirk and may provide a richer PROV projection.
- Content-addressable or registry protocols may be implemented behind `ObjectStore`; their digest
  identity does not replace Mirk's stable artifact record identity.

These are interoperability projections, not new required runtime dependencies.

## Package boundary

The package family is:

| Import/package               | Contents                                                                                | Native or external deps |
| ---------------------------- | --------------------------------------------------------------------------------------- | ----------------------- |
| `@mirk/artifact`             | core types, coordinator, in-memory references, integrity helpers, and maintenance types | none                    |
| `@mirk/artifact/store`       | `@mirk/store/kv` metadata repository and object-lease capability                        | `@mirk/store` types     |
| `@mirk/artifact/fs`          | Node filesystem object store                                                            | Node built-ins          |
| `@mirk/artifact/maintenance` | audit, opaque repair references, and conditional repair application                     | none                    |
| `@mirk/artifact-opendal`     | optional production object-store binding                                                | Apache OpenDAL          |

There should not be `artifact-libsql`, `artifact-sqlite`, or `artifact-surreal` packages merely for
metadata. Metadata rides the `ArtifactRepository` implementation over `@mirk/store/kv`; the chosen
Mirk source adapter determines whether that collection is in memory, SQLite, libSQL, or SurrealDB.

Production object storage should normally be supplied by a community storage library or a vendor
SDK behind the small `ObjectStore` capability port. Mirk does not reimplement backend clients,
retry layers, multipart upload engines, or provider-specific signing. A Mirk-owned adapter is
justified only when an established library cannot satisfy a required capability or integrity
invariant, and that gap is demonstrated by contract tests.

Root imports stay browser-safe and native-free. Optional integrations with native or vendor storage
libraries are reachable only through explicit adapter packages or consumer-owned bindings.

### Upstream dependency ruling

The implementation deliberately reuses community infrastructure below Mirk's ownership seam:

- [Apache OpenDAL](https://opendal.apache.org/bindings/nodejs/) owns backend clients, streaming IO,
  conditional writes, retries/layers, multipart behavior, and provider-specific transport. The
  optional `@mirk/artifact-opendal` package translates only the small `ObjectStore` contract and
  fails closed when a backend cannot provide a required capability such as atomic `ifAbsent`.
- [`@noble/hashes`](https://www.npmjs.com/package/@noble/hashes) supplies the audited, incremental,
  runtime-neutral SHA-256 implementation. Mirk does not implement cryptographic primitives.
- OCI descriptors and W3C PROV remain interoperability projections. They do not supply a local
  artifact repository, coordinator failure protocol, stable record identity, or Mirk-backed
  lineage repository.

This leaves Mirk with the irreducible domain-neutral contract: stable artifact records, verified
digest and size, immutable metadata, idempotency, lineage, and coordination across object storage
and metadata persistence. Backend breadth is not a Mirk responsibility.

## Core records

### Artifact record

```ts
interface ArtifactDescriptor {
  id: string;

  // Verified physical description
  mediaType: string;
  sizeBytes: number;
  digest: ArtifactDigest;

  // Portable description
  kind?: string;
  filename?: string;
  createdAt: number;

  // Infrastructure provenance
  producer?: ArtifactProducer;
  annotations?: Record<string, JsonValue>;
}

interface StoredArtifactRecord extends ArtifactDescriptor {
  // Infrastructure-only adapter identity
  objectKey: string;
}

interface ArtifactDigest {
  algorithm: "sha256";
  value: string; // lowercase hex
}

interface ArtifactProducer {
  system: string;
  operation?: string;
  jobId?: string;
  attemptId?: string;
  outputSlot?: string;
  evidenceRef?: string;
}
```

Rules:

- `id` is stable and independent of `objectKey`.
- `objectKey` exists only on the infrastructure-facing `StoredArtifactRecord`; public descriptors,
  coordinator returns, and consumer projections never contain it.
- `mediaType` is the stored representation's media type, not a product category.
- `kind` is an optional, opaque classification such as `thumbnail`, `transcript`, or
  `model-checkpoint`; Mirk does not maintain a closed enum.
- `filename` is a presentation/download hint, never identity.
- `annotations` must be JSON-safe, bounded, and secret-free.
- `producer` fields are opaque references. Mirk does not import or depend on execution-system types.
- `jobId`, `attemptId`, and `outputSlot` are traceability back-references, not a second execution
  record. Provider request/response evidence remains in the execution system; `evidenceRef` may
  point to it without copying the payload.
- SHA-256 is the required portable baseline. Adapters may record additional digests in annotations,
  but the canonical integrity check remains available through Web Crypto and common server runtimes.

There is no general artifact lifecycle status. A finalized artifact is available. Missing or corrupt
bytes are repository integrity failures, not generation states. Quarantine or moderation belongs in
consumer policy unless a future storage-level quarantine use case is proven across consumers.

### Lineage edge

```ts
interface ArtifactLineageEdge {
  id: string;
  sourceArtifactId: string;
  resultArtifactId: string;
  operation: string;
  parameters?: Record<string, JsonValue>;
  producer?: ArtifactProducer;
  createdAt: number;
}
```

Examples of `operation` include:

```text
image.edit
image.upscale
media.transcode
audio.normalize
audio.transcribe
video.trim
archive.extract
document.render
```

Mirk records the edge and preserves parameters; it does not interpret whether an operation is valid
for the media types involved.

`parameters` are limited to bounded, secret-free structural facts required to interpret the
physical derivative. Full prompts, provider requests/responses, credentials, safety payloads, and
operational logs remain execution evidence. Lineage may retain an opaque evidence reference or
digest instead of copying those payloads.

Lineage is many-to-many:

- one result may have multiple sources;
- one source may produce many derivatives;
- a transformation may be lossless or lossy;
- cycles are forbidden.

### Object metadata

```ts
interface ObjectInfo {
  key: string;
  sizeBytes: number;
  mediaType?: string;
  digest?: ArtifactDigest;
  etag?: string;
  lastModifiedAt?: number;
  metadata?: Record<string, string>;
}
```

Backend metadata is advisory. Artifact integrity is established by the canonical digest computed or
verified by the coordinator, not by assuming an ETag is a content hash.

## Core ports

### Byte stream

```ts
type ByteSource = Uint8Array | AsyncIterable<Uint8Array>;
type ByteStream = AsyncIterable<Uint8Array>;
```

The public core must not require Node `Buffer`. Node adapters may accept `Buffer` because it extends
`Uint8Array`, but portable types remain web/runtime neutral.

### Object store

```ts
interface ObjectStore {
  put(
    key: string,
    bytes: ByteSource,
    options?: ObjectPutOptions
  ): Promise<ObjectInfo>;

  get(key: string): Promise<ByteStream | undefined>;
  head(key: string): Promise<ObjectInfo | undefined>;
  delete(key: string): Promise<boolean>;
}

interface ObjectPutOptions {
  mediaType?: string;
  metadata?: Record<string, string>;
  ifAbsent?: boolean;
}
```

Required semantics:

- `put` consumes the source exactly once.
- `ifAbsent` must fail deterministically when the key already exists.
- `get` returns `undefined` for a missing key.
- `delete` returns `false` for a missing key.
- keys are opaque normalized strings; adapters reject empty keys, absolute paths, traversal
  segments, NUL bytes, and backend escape sequences.
- adapters do not expose machine paths as keys or public artifact references.

Optional facets are separate interfaces:

```ts
interface ListableObjectStore {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<ObjectPage>;
}

interface CopyableObjectStore {
  copy(sourceKey: string, destinationKey: string, options?: { ifAbsent?: boolean }): Promise<ObjectInfo>;
}

interface UrlObjectStore {
  createReadUrl(key: string, options: { expiresInSeconds: number }): Promise<string>;
}

interface MultipartObjectStore {
  beginMultipart(...): Promise<MultipartUpload>;
}
```

This replaces the old monolithic `IAssetStorageBackend`, which required every backend to implement
listing, copy, move, URLs, and lifecycle hooks whether or not the backend supported them naturally.

`move` is intentionally absent from the core. Artifact bytes are immutable; changing their key is
an implementation migration, not a domain operation.

### Artifact repository

```ts
interface ArtifactRepository {
  create(record: StoredArtifactRecord): Promise<void>;
  get(id: string): Promise<StoredArtifactRecord | undefined>;
  getByDigest(digest: ArtifactDigest): Promise<readonly StoredArtifactRecord[]>;
  list(query?: ArtifactQuery): Promise<StoredArtifactPage>;
  updateAnnotations(
    id: string,
    patch: Record<string, JsonValue | undefined>
  ): Promise<StoredArtifactRecord>;
  delete(id: string): Promise<boolean>;

  addLineage(edge: ArtifactLineageEdge): Promise<void>;
  getSources(id: string): Promise<readonly ArtifactLineageEdge[]>;
  getDerivatives(id: string): Promise<readonly ArtifactLineageEdge[]>;
}

interface StoredArtifactPage {
  items: readonly StoredArtifactRecord[];
  nextCursor?: string;
}
```

`updateAnnotations` is the only ordinary mutation on a finalized record. It cannot change object
identity, digest, size, media type, creation time, or producer evidence.

Suggested query surface:

```ts
interface ArtifactQuery {
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
```

Pagination order is deterministic: `createdAt DESC`, then `id DESC`. Cursor encoding is an
implementation detail but must round-trip across repository reopen.

### Artifact coordinator

The coordinator composes an `ObjectStore` and `ArtifactRepository` so consumers do not reproduce
the integrity protocol:

```ts
interface ArtifactCoordinator {
  write(input: WriteArtifactInput): Promise<ArtifactDescriptor>;
  import(input: ImportArtifactInput): Promise<ArtifactDescriptor>;
  read(id: string): Promise<ArtifactReadResult | undefined>;
  verify(id: string): Promise<ArtifactVerification>;
  delete(id: string): Promise<boolean>;
}

interface ArtifactReadResult {
  artifact: ArtifactDescriptor;
  bytes: ByteStream;
}
```

`write` accepts bytes plus portable metadata, computes SHA-256 and size while streaming, stores the
object, then commits the artifact record.

`import` registers bytes already present in an object store only after reading and verifying them.
Trusting caller-supplied size or hash without verification is not a portable import.

`read` resolves the artifact record and byte stream together. Consumers should not need to use an
object key directly.

The coordinator strips `objectKey` at its boundary. `ArtifactReadResult` contains an
`ArtifactDescriptor` plus the byte stream, never a `StoredArtifactRecord`. The key is available only
to repository, adapter, and maintenance surfaces. Consumers must read through the coordinator and
must not persist or construct keys.

`delete` removes metadata and bytes using a documented failure protocol. It does not infer whether
products still reference the artifact.

## Write and failure protocol

Artifact creation must behave as one logical operation even when the object store and metadata
repository cannot share a transaction:

1. Validate portable metadata and mint an artifact ID.
2. Derive a non-semantic, collision-resistant object key.
3. Stream bytes into the object store while computing size and SHA-256.
4. Compare adapter-reported size with the computed size.
5. Commit the immutable artifact record.
6. Return the record only after metadata commit succeeds.

If object storage fails, no artifact record is created.

If metadata commit fails after object storage succeeds, the coordinator attempts to delete the
unreferenced object and returns an error containing cleanup status. Adapters must support an orphan
audit so deployments can identify objects not referenced by artifact metadata.

The initial implementation does not promise a distributed transaction. It promises:

- no successful return before both sides exist;
- explicit, inspectable cleanup failure;
- deterministic orphan detection and explicit repair;
- idempotent retry when the caller supplies an idempotency token and the repository supports it.

### Idempotent writes

```ts
interface WriteArtifactInput {
  bytes: ByteSource;
  mediaType: string;
  kind?: string;
  filename?: string;
  producer?: ArtifactProducer;
  annotations?: Record<string, JsonValue>;
  sources?: readonly ArtifactSourceInput[];
  idempotencyKey?: string;
}
```

An idempotency key is scoped to the configured coordinator namespace. Repeating a completed write
with the same key and request returns the original artifact. Repeating it with incompatible declared
metadata is an `idempotency-conflict`. The repository computes a canonical request digest; callers do
not supply one. Receipts do not expire in v1, and any future compaction needs an epoch or tombstone
protocol that cannot allow an old key to execute again.

When the injected store has no atomic mutation capability, the generic store-backed repository keeps
its documented single-writer behavior. It must not claim multi-process idempotency. Concurrent
finalizers must use external exclusion or select the repository-atomic mode below.

Execution runtimes use `(artifact namespace, attemptId, outputSlot)` as the idempotency scope for
generated outputs. A job submission key is a separate execution-system concern. Multi-output attempts
use distinct stable slots; retries create new attempts and therefore new output scopes unless
reconciliation is repairing the same attempt.

### Concurrent finalization

An optional repository capability makes finalization atomic over metadata:

```ts
interface AtomicArtifactRepository extends ArtifactRepository {
  createIdempotent(input: {
    record: StoredArtifactRecord;
    idempotencyKey: string;
  }): Promise<
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
      }
  >;
}
```

The store-backed repository implements this capability when its injected store implements
`AsyncAtomicMutationStore`; otherwise it remains usable in the documented single-writer mode and
does not claim multi-process idempotency. The request digest uses the
`mirk-artifact-finalization/v1` schema tag and includes the artifact digest plus every immutable
descriptor field supplied at finalization, including filename and initial annotations when present.
Mutable annotation updates do not alter the original receipt. A replay compares the incoming
finalization record with that original request, not with later mutable annotations.

The coordinator declares its concurrency mode explicitly:

```ts
type ArtifactCoordinatorConcurrency =
  | { mode: "single-writer" }
  | { mode: "repository-atomic" };
```

`single-writer` preserves existing behavior and requires external exclusion for concurrent
finalizers. `repository-atomic` requires `AtomicArtifactRepository` and fails at construction when
it is unavailable. Capability guessing is not a production configuration.

Finalizers using Mirk's repository path also participate in repository-owned object exclusion. Before
writing bytes, a finalizer acquires a shared writer lease for the candidate immutable object identity
and holds it through repository commit, replay, conflict, cleanup, or abort. Repository record
creation verifies that the lease is still current in the same repository decision. Losing the lease
means no record is created.

Destructive repair acquires an exclusive deletion lease for the same object identity. The repository
lease blocks new shared writer leases, checks that no record references the object, and waits for or
rejects on prior shared writer leases before bytes are inspected or deleted. This is a cooperative
repository protocol, not a distributed transaction between the repository and object store. It is
distinct from execution-system resource leases, which govern worker capacity and scheduling.

Lease records are durable and carry an opaque lease ID, owner identity, object identity, mode,
generation, heartbeat, and bounded expiry. Renewal, release, and repository commit must match the
owner and generation. A stalled finalizer or crashed repair is reclaimed only by advancing the
generation and re-reading the no-reference and object-fingerprint conditions; recovery never resumes
from a stale pre-expiry observation.

## Maintenance and repair

Maintenance is an explicit `@mirk/artifact/maintenance` subpath. Audit is read-only and may be
partial when the object store cannot enumerate objects. It must redact infrastructure paths and
credentials, produce deterministic findings, and never expose object-store keys. Findings may carry
an opaque reference scoped to the audit snapshot; callers cannot decode it or use it as an object key.

```ts
declare const artifactMaintenanceRefBrand: unique symbol;
type ArtifactMaintenanceRef = string & {
  readonly [artifactMaintenanceRefBrand]: true;
};

interface ArtifactAuditFinding {
  code:
    | "object-without-record"
    | "record-without-object"
    | "size-mismatch"
    | "digest-mismatch"
    | "lineage-missing-source"
    | "lineage-missing-result"
    | "lineage-cycle";
  artifactId?: string;
  maintenanceRef?: ArtifactMaintenanceRef;
  detail?: string;
}

interface ArtifactAuditReport {
  auditId: string;
  scannedRecords: number;
  scannedObjects?: number;
  findings: readonly ArtifactAuditFinding[];
}

type ArtifactRepairPrecondition =
  | {
      kind: "object-unreferenced";
      maintenanceRef: ArtifactMaintenanceRef;
      observedDigest?: string;
      observedSizeBytes: number;
      observedEtag?: string;
    }
  | {
      kind: "record-missing-object";
      artifactId: string;
      recordFingerprint: string;
    }
  | {
      kind: "lineage-edge-invalid";
      edgeId: string;
      edgeFingerprint: string;
      expectedReason: "missing-source" | "missing-result" | "cycle";
    }
  | {
      kind: "artifact-descriptor-current";
      artifactId: string;
      descriptorFingerprint: string;
    };

interface ArtifactRepairPlan {
  schema: "mirk-artifact-repair/v1";
  auditId: string;
  createdAt: number;
  actions: readonly {
    id: string;
    operation:
      | "delete-unreferenced-object"
      | "delete-record-without-object"
      | "remove-invalid-lineage-edge"
      | "reverify-imported-object";
    precondition: ArtifactRepairPrecondition;
  }[];
}

type ArtifactRepairApplyResult =
  | { status: "applied"; actionId: string }
  | {
      status: "conflict";
      actionId: string;
      reason:
        | "state-changed"
        | "reference-created"
        | "object-changed"
        | "lease-unavailable";
    }
  | { status: "not-found"; actionId: string };
```

Repair is plan-first and conditional. The package generates a plan, but applying it requires an
explicit call. The implementation computes fingerprints from canonical stored state and rechecks
them immediately before each independent action. An unknown audit snapshot returns `not-found`.

Allowed initial actions are deleting a confirmed unreferenced object, explicitly deleting metadata
for a record whose object is missing, removing an invalid lineage edge, and re-verifying an imported
object. Repair never recreates bytes, invents lineage, accepts a new digest for corrupted bytes,
infers product reachability, deletes by age, or changes product attachments.

Deleting an unreferenced object requires the repository-owned exclusive deletion lease described above.
Acquisition blocks new shared writer leases, checks that no record references the object, and waits
for or returns `lease-unavailable` on live shared writers within a bounded maintenance timeout. Before
deletion, the implementation re-reads and verifies the audited digest, size, and available ETag. A
new reference or changed object returns a conflict and performs no deletion. Lease expiry recovery
advances the object generation and re-reads state before mutation; it never resumes from a stale
observation.

For record, lineage, and descriptor actions, a changed fingerprint returns `conflict` and performs no
mutation. Results are returned per action; applying a plan is not one transaction. Backends that
cannot enforce repository-owned shared/exclusive object exclusion must reject destructive orphan
repair rather than perform a best-effort cross-store delete.

## Immutability, deduplication, and identity

Artifact IDs are record identities; digests are content identities.

Two artifacts may have identical bytes and therefore the same digest while retaining different
producer evidence, filenames, annotations, or product history. The repository must support
digest lookup but must not automatically collapse distinct records.

Object-level deduplication is allowed as an adapter/coordinator optimization when:

- the bytes have the same canonical digest;
- deletion uses reference accounting or equivalent reachability;
- consumers cannot observe another tenant or scope through deduplication;
- producer and lineage records remain distinct.

Content-addressed object keys are recommended but not required. Consumers must never construct them.

## Deletion, retention, and garbage collection

Mirk cannot know whether a product still references an artifact. Therefore:

- deletion is explicit;
- the default coordinator performs no age-based garbage collection;
- consumers provide retention or reachability decisions;
- deletion preserves an optional tombstone/audit record only when configured by the deployment;
- shared physical objects are removed only when no artifact record references them;
- lineage edges involving a deleted record are removed or tombstoned consistently according to the
  repository's configured audit mode.

Consumer-facing deletion is coordinated above Mirk and must account for both execution evidence and
application attachment/retention claims. Direct Mirk deletion is an infrastructure or
maintenance primitive, not the ordinary product API. Tombstoning is preferred where audit
retention applies.

A future garbage-collection helper may accept a consumer-supplied set or callback of live artifact
IDs. It must not import product schemas.

## Scopes and tenancy

The core record does not mandate one tenancy system. A configured artifact namespace supplies the
isolation boundary used for:

- ID and idempotency-key scope;
- object-key prefixing;
- metadata collections;
- signed URL creation;
- listing and maintenance operations.

Adapters must prevent cross-namespace reads even when object keys share a physical bucket.

Authorization remains above Mirk. Possession of an artifact ID or object key does not itself grant
read access.

## Adapter requirements

Every adapter must pass a shared contract suite covering:

- missing reads and deletes;
- zero-byte objects;
- large streamed objects with non-uniform chunk boundaries;
- media type and metadata round-trip;
- `ifAbsent` conflicts;
- traversal/path escape rejection;
- Unicode key stability;
- overwrite behavior;
- interrupted upload cleanup;
- deterministic listing when the facet is implemented;
- reopen persistence;
- size and digest verification;
- concurrent writes to the same key;
- delete/read races with documented outcomes.

The hardening suite additionally covers same-key finalization replay and conflict, crash residue,
partial audits, deterministic repair plans, reference-created and object-changed conflicts, lease
interleavings between finalization and repair, lease expiry recovery, namespace isolation, and the
absence of object-store keys from public findings and repair results.

### In-memory reference

The in-memory object store and artifact repository are normative references, not toy mocks. They
must preserve byte-copy isolation, deterministic ordering, conflict semantics, and lineage cycle
checks.

### Community storage integrations

Community storage implementations are preferred over Mirk-owned backend clients. Bindings must
declare which optional capabilities they actually support: streaming, conditional creation,
listing, signed URLs, server-side copy, multipart upload, and reopen persistence. A binding must
fail an unsupported capability explicitly rather than simulate unsafe semantics.

The conformance suite remains Mirk-owned because it proves the artifact coordinator's assumptions;
backend transport, authentication, retries, and provider-specific behavior remain upstream. Native
bindings and vendor SDKs never enter the root package dependency graph.

## Security and trust

- Treat media type, filename, annotations, and backend metadata as untrusted input.
- Never infer authorization from a signed URL or storage key.
- Never store provider tokens, cookies, connection strings, or raw secret-bearing requests in
  artifact metadata.
- Bound annotation depth and encoded size.
- Verify digests when importing existing objects and during explicit integrity audits.
- Escape filenames when used in HTTP headers.
- Use adapter-generated keys or strict normalized key validation.
- Do not execute, render, unpack, or transcode artifact bytes inside the storage package.
- Archive extraction and media parsing run in execution workers with their own resource and safety
  limits.

## Relationship to execution systems

Execution systems remain the owner of work:

```text
Job
  -> Attempt
  -> provider/worker execution
  -> @mirk/artifact.write(...)
  -> attempt records output artifact IDs
  -> consumer receives artifact references
```

`@mirk/artifact` must not duplicate job, attempt, scheduling, cancellation, progress, or provider
records.

An execution system may expose authorized artifact operations over Mirk, but those projections do
not transfer storage ownership to the execution layer.

```text
execution.artifact.get
execution.artifact.verify
execution.artifact.delete
execution.artifact.derivatives
```

Artifact finalization and attempt-output persistence form a recoverable cross-store saga:

1. an attempt is running;
2. the worker finalizes a Mirk artifact using `(namespace, attemptId, outputSlot)` idempotency and
   opaque producer references;
3. the execution system persists the typed attempt output reference;
4. the attempt succeeds only after every required output reference is durable;
5. reconciliation finds finalized artifacts whose producer attempt lacks the matching output slot
   and repairs the binding without rewriting bytes.

This cross-layer orphan is distinct from Mirk's object-without-record orphan. Both must be
detectable and repairable.

## Relationship to consuming applications

A consuming application may retain a semantic attachment record similar to:

```ts
interface ArtifactAttachment {
  id: string;
  artifactId: string;
  entityId?: string;
  role?: string;
  subtype?: string;
  variant?: string;
  disposition: "proposed" | "accepted" | "rejected";
  createdAt: number;
  updatedAt: number;
}
```

The exact attachment schema remains a consumer decision. The invariant is that it references an
artifact rather than owning physical storage or execution state. Successful finalization does not
imply semantic acceptance.

## Implementation record

### Phase 0 — upstream evaluation and frozen contracts — package boundary completed

1. The `ObjectStore` capability contract is frozen around portable keys, streaming bytes, metadata,
   conditional creation, and explicit optional capabilities.
2. Backend access, streaming, retries, signing, and provider transport remain delegated to maintained
   community implementations such as OpenDAL.
3. Consumer record snapshots and rollback handles remain adoption requirements in Phase 4 rather
   than package-release claims.

### Phase 1 — core primitive — implemented locally

1. Implement core records and ports.
2. Implement normative in-memory object store and artifact repository.
3. Implement the coordinator, hashing, streaming, lineage, and idempotency.
4. Prove failure cleanup and orphan auditing.

### Phase 2 — Mirk persistence — implemented locally

1. Implement `@mirk/artifact/store` over `@mirk/store/kv`.
2. Add parity tests against the in-memory repository.
3. Verify SQLite and libSQL through existing Mirk source adapters.
4. Do not create an artifact-specific SQL schema package unless measured behavior proves the generic
   collection port insufficient.

### Phase 3 — community storage bindings — implemented initial adapters locally

1. `FileObjectStore` supplies the local Node reference.
2. `@mirk/artifact-opendal` supplies a thin community-storage binding and rejects unsupported
   capabilities rather than emulating weaker behavior.
3. Remote provider selection, credentials, and deployment validation remain consumer-owned.
4. A Mirk-owned provider adapter still requires a demonstrated and documented upstream gap.

### Phase 4 — consumer adoption — external and ongoing

1. Introduce artifact references alongside existing consumer records.
2. Backfill artifact records and verify hashes without changing consumer-facing IDs.
3. Retain a reversible legacy-read path until stored objects remain accessible through the new seam.
4. Remove duplicate storage code only after conformance, rollback, and reachability checks pass.

### Phase 5 — finalization and maintenance hardening — implemented locally

1. `StoreArtifactRepository` and the in-memory repository implement `AtomicArtifactRepository`
   when their injected store supports the optional atomic-mutation capability.
2. Coordinator concurrency mode is explicit: `single-writer` or `repository-atomic`.
3. Repository-owned shared-writer and exclusive-deletion object leases fence finalization and repair.
4. `@mirk/artifact/maintenance` provides read-only audits and plan-first conditional repair.
5. Package tests cover concurrent finalization, replay/conflict, lease interleavings, partial audits,
   lineage repair, and state-change conflicts.

MR-10's local source now includes the hardening surfaces above. Atomic finalization and destructive
orphan repair remain capability-gated: a repository without atomic mutation or object leases must use
single-writer behavior or return `lease-unavailable`. This implementation record does not assert
registry publication or consumer/runtime adoption.

## Broader maturity criteria

The local packages are implemented. The broader substrate is mature when:

- a zero-byte object and a multi-gigabyte streamed object follow the same portable API;
- one local and one remote community storage binding pass the shared contract suite;
- artifact metadata persists through a Mirk store adapter and survives reopen;
- an interrupted metadata commit produces an inspectable orphan and a successful repair;
- digest verification detects corrupted bytes;
- duplicate idempotent writes return the same artifact;
- identical bytes may produce distinct artifact records without duplicating physical storage when
  deduplication is enabled;
- lineage rejects cycles and returns deterministic sources/derivatives;
- no public core type imports Node `Buffer`, a validation library, an execution-system type, a
  consumer-domain type, or a provider SDK;
- a consumer can attach an artifact to a domain record without storing job fields in the artifact;
- an execution worker can record an artifact output without Mirk importing execution-system types;
- existing consumer records can be backfilled and read without changing their public IDs.

## Remaining design decisions

These decisions require consumer evidence and contract tests before expanding the released surface:

1. Whether `ByteStream` should additionally support the standard `ReadableStream<Uint8Array>` at
   the public boundary or remain `AsyncIterable` with conversion helpers.
2. Whether the default object key is artifact-ID-based or content-addressed. Consumers must not
   observe the choice.
3. Whether audit tombstones ship in the first release or remain an optional repository wrapper.
4. Whether annotation query requires a deliberately small exact-match facet after two consumers
   demonstrate the same need.
5. The maintenance boundary is the explicit `@mirk/artifact/maintenance` subpath; future changes
   should preserve its plan-first and repository-lease contract.

None of these reopen the ownership boundary: bytes, integrity, portable artifact metadata, and
lineage belong to Mirk; execution and product meaning do not.
