# @mirk/artifact

Portable artifact identity, SHA-256 integrity, metadata, lineage, and coordination over a small object-store port.

The root package is runtime-neutral. It exports the artifact coordinator, in-memory reference implementations, object-store types, digest helpers, and validation helpers. Use `@mirk/artifact/store` to persist metadata through `@mirk/store/kv`; use `@mirk/artifact/fs` for a Node filesystem object store; use a separate adapter such as `@mirk/artifact-opendal` for production object-storage backends.

ESM-only.

## Install

```bash
npm install @mirk/artifact @mirk/store
```

Use the Node filesystem backend through its explicit subpath:

```ts
import { FileObjectStore } from "@mirk/artifact/fs";
```

## Exports

| Import                       | What it gives you                                                                                                             | Native deps         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `@mirk/artifact`             | `ArtifactCoordinator`, in-memory object/repository references, object-store and artifact types, digest and validation helpers | none                |
| `@mirk/artifact/store`       | `StoreArtifactRepository`, backed by any `AsyncStore` from `@mirk/store/kv`                                                   | none                |
| `@mirk/artifact/fs`          | `FileObjectStore`, backed by local disk bytes plus sidecar metadata                                                           | Node built-ins only |
| `@mirk/artifact/maintenance` | read-only audits and explicit conditional repair plans                                                                        | none                |

## Quickstart

```ts
import {
  ArtifactCoordinator,
  InMemoryArtifactRepository,
  InMemoryObjectStore,
} from "@mirk/artifact";

const objects = new InMemoryObjectStore();
const repository = new InMemoryArtifactRepository();
const artifacts = new ArtifactCoordinator(objects, repository);

const written = await artifacts.write({
  bytes: new TextEncoder().encode("hello"),
  mediaType: "text/plain",
  filename: "hello.txt",
  producer: { system: "example", operation: "render" },
  annotations: { draft: true },
  idempotencyKey: "job-123:hello",
});

const verification = await artifacts.verify(written.id);
console.log(verification.ok); // true

const read = await artifacts.read(written.id);
if (!read) throw new Error("artifact missing");

let text = "";
for await (const chunk of read.bytes) {
  text += new TextDecoder().decode(chunk, { stream: true });
}
console.log(text); // hello
```

## Records and Identity

An artifact exists only after its bytes are stored and verified. Every artifact has:

- `id` — a stable record identity, independent of where the bytes live.
- `digest` — SHA-256, lowercase hex, computed by Mirk while the bytes stream. It is a content identity, not a record identity: identical bytes written twice produce two records with the same digest. `repository.getByDigest()` finds them; Mirk never merges them.
- `sizeBytes` and `mediaType` — `mediaType` must be a MIME type (`type/subtype`).
- Optional `kind` (an opaque label such as `thumbnail`; Mirk has no enum), `filename` (a presentation hint, never identity), `producer` (opaque back-references: `system` is required and non-empty; `operation`, `jobId`, `attemptId`, `outputSlot`, and `evidenceRef` are optional), and `annotations`.

`annotations` and lineage `parameters` must be JSON-safe, at most 64 KiB encoded and 20 levels deep, with finite numbers only. `repository.updateAnnotations(id, patch)` is the only mutation on a finalized record; a key set to `undefined` is removed. It cannot change bytes, digest, size, media type, creation time, or producer. Replacing content means writing a new artifact.

The object-store key is infrastructure. Coordinator results are `ArtifactDescriptor`s, which never contain `objectKey`; only repository, adapter, and maintenance surfaces see it. Do not persist or construct object keys. Read through `artifacts.read(id)`.

## Write and Failure Protocol

`write()` behaves as one logical operation even though the object store and the metadata repository do not share a transaction:

1. Validate metadata and mint an ID.
2. Stream bytes to the object store with `ifAbsent: true`, computing SHA-256 and byte length on the way.
3. Reject the write if the store reports a different size than was streamed.
4. Commit the record, then any `sources` lineage edges.
5. Return only after the metadata commit succeeds.

Any failure throws `ArtifactWriteError` with `cleanup: "not-needed" | "succeeded" | "failed"`. If the byte write fails, no record exists. If anything after it fails, the coordinator removes the record it created and attempts to delete the object. A `"failed"` cleanup leaves an orphaned object for `@mirk/artifact/maintenance` to find.

`import({ objectKey, mediaType, ... })` registers bytes already in the object store. It reads and hashes them first; it never trusts a caller-supplied size or digest. An import failure never deletes the imported object.

`verify(id)` re-reads the bytes and returns `{ ok, reason?, actualDigest?, actualSizeBytes? }`, with `reason` one of `object-missing`, `size-mismatch`, or `digest-mismatch`.

Lineage is many-to-many. Both endpoints must exist (otherwise `ArtifactOperationError` with `code: "missing-lineage-endpoint"`), and an edge that would create a cycle is rejected with `ArtifactConflictError`. Mirk stores the `operation` string and `parameters`; it does not judge whether an operation makes sense for the media types involved. Keep prompts, provider payloads, credentials, and logs out of `parameters`; store a reference instead.

## Idempotency and Concurrency

An `idempotencyKey` is scoped to the coordinator `namespace`. Repeating a completed write with the same key, metadata, and bytes returns the original artifact without writing a second one. Reusing the key with different metadata or different bytes throws `ArtifactConflictError`. Mirk computes the `mirk-artifact-finalization/v1` request digest from the bytes and every immutable field supplied at finalization; callers never provide it, and later annotation updates do not change it. For generated outputs, a key built from `(attemptId, outputSlot)` gives each attempt output its own scope.

Finalization concurrency is explicit:

- `{ mode: "single-writer" }` (default) — correct for one writer. Concurrent finalizers need external exclusion; this mode does not promise multi-process idempotency.
- `{ mode: "repository-atomic" }` — requires an `AtomicArtifactRepository`, such as `StoreArtifactRepository` over a store that implements `AsyncAtomicMutationStore`. The constructor throws an `ArtifactValidationError` (a `TypeError`) with `code: "invalid-concurrency-config"` when the repository cannot provide it. Idempotent decisions then happen in one atomic repository mutation.

### Object Leases

When the repository also implements `ArtifactLeaseRepository` (as `StoreArtifactRepository` does over an atomic store), writers and repair cooperate through repository-owned leases on each object:

- A finalizer holds a `shared-writer` lease from before the byte write through commit, replay, conflict, or cleanup. The record is created only if the lease is still current in the same repository decision; a lost lease means no record.
- Destructive repair takes an `exclusive-delete` lease. It blocks new writers and is refused while a writer holds the object.
- Leases carry an ID, owner, mode, generation, heartbeat, and expiry (`leaseTtlMs`, default 30 s). Renewal, release, and commit must match owner and generation. Recovery after expiry advances the generation and re-reads state; it never acts on an observation from before expiry.

Leases are a cooperative protocol inside the repository, not a distributed transaction with the object store, and they are unrelated to worker or scheduling leases in an execution system.

## Listing

`repository.list(query)` filters by `mediaType`, `mediaTypePrefix`, `kind`, `producerSystem`, `producerJobId`, `producerAttemptId`, `producerOutputSlot`, `createdAfter`, and `createdBefore`. Order is always `createdAt` descending, then `id` descending. `limit` defaults to 50 and is capped at 500; pass `nextCursor` back as `cursor` to continue.

## Deletion and Retention

Mirk cannot know whether your application still references an artifact, so:

- Deletion is explicit. There is no age-based or automatic garbage collection.
- `artifacts.delete(id)` removes the record and every lineage edge that touches it, then deletes the bytes only if no other record references the same object. If the metadata is gone but the byte delete fails, it throws.
- Retention, reachability, approval, and attachment decisions belong to the caller. Treat direct deletion as an infrastructure primitive and decide above Mirk whether anything still needs the artifact.

## Maintenance and Repair

`@mirk/artifact/maintenance` provides `ArtifactMaintenance` (and the `auditArtifacts()` shortcut, also exported from the root).

```ts
import { ArtifactMaintenance } from "@mirk/artifact/maintenance";

const maintenance = new ArtifactMaintenance(objects, repository);
const report = await maintenance.audit();
const plan = await maintenance.planRepair(report);
const results = await maintenance.applyRepair(plan);
```

- `audit()` is read-only. Finding codes are `object-without-record`, `record-without-object`, `size-mismatch`, `digest-mismatch`, `lineage-missing-source`, `lineage-missing-result`, and `lineage-cycle`. Object scanning needs a `ListableObjectStore`; without one the report has `coverage: "partial"`.
- Findings and plans never contain object-store keys. Objects are named by an opaque `maintenanceRef` that is valid only for that audit, and the snapshot lives in the `ArtifactMaintenance` instance, so plan and apply with the same instance. An unknown audit returns `not-found`.
- `planRepair()` only builds a plan. Its actions are `delete-unreferenced-object`, `delete-record-without-object`, `remove-invalid-lineage-edge`, and `reverify-imported-object`, each with a fingerprint precondition.
- `applyRepair()` rechecks each precondition immediately before acting and returns one result per action: `applied`, `not-found`, or `conflict` with reason `state-changed`, `reference-created`, `object-changed`, or `lease-unavailable`. A conflict performs no mutation. A plan is not one transaction. Backend failures reject.
- Deleting an unreferenced object requires the exclusive-delete lease and re-verifies the audited size, digest, and ETag first. A repository without lease support gets `lease-unavailable` instead of a best-effort delete.
- Repair never recreates bytes, invents lineage, accepts a new digest for corrupted bytes, deletes by age, or infers application reachability.

## Persist Metadata With `@mirk/store`

`StoreArtifactRepository` stores artifact metadata and lineage in any async Mirk KV implementation. For local sync stores, lift with `toAsync()`.

```ts
import { ArtifactCoordinator, InMemoryObjectStore } from "@mirk/artifact";
import { StoreArtifactRepository } from "@mirk/artifact/store";
import { InMemoryKv, toAsync } from "@mirk/store/kv";

const metadata = new StoreArtifactRepository(toAsync(new InMemoryKv()), {
  namespace: "example-artifacts",
});

const artifacts = new ArtifactCoordinator(new InMemoryObjectStore(), metadata);

const first = await artifacts.write({
  bytes: new TextEncoder().encode("source"),
  mediaType: "text/plain",
});

const second = await artifacts.write({
  bytes: new TextEncoder().encode("derived"),
  mediaType: "text/plain",
  sources: [{ artifactId: first.id, operation: "text.transform" }],
});

console.log(
  (await metadata.getSources(second.id)).map((edge) => edge.operation)
);
```

## Store Bytes On Local Disk

`FileObjectStore` is Node-only and lives behind `@mirk/artifact/fs` so browser and edge imports of the root package do not load `node:fs`.

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileObjectStore } from "@mirk/artifact/fs";

const root = await mkdtemp(join(tmpdir(), "mirk-artifacts-"));
const store = new FileObjectStore({ root });

await store.put("images/example", new Uint8Array([1, 2, 3]), {
  mediaType: "image/png",
  metadata: { origin: "example" },
  ifAbsent: true,
});

console.log(await store.head("images/example"));
await rm(root, { recursive: true, force: true });
```

The filesystem layout stores bytes at `<key>.bin` and portable metadata at `<key>.sidecar.json`. `head()` falls back to file size if a sidecar is missing or corrupt.

## ObjectStore Contract

An `ObjectStore` stores physical bytes by portable relative keys:

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
```

Rules every adapter must follow:

- `put` consumes the byte source exactly once and returns the stored size. The coordinator always calls `put` with `ifAbsent: true` and a `mediaType`, and rejects a write whose reported size differs from the streamed size.
- `ifAbsent: true` is an atomic create-if-missing that throws when the key exists. An adapter that cannot do this atomically must throw rather than check-then-write, and a failed conditional write must not delete the pre-existing object.
- `get` returns `undefined` and `delete` returns `false` for a missing key.
- Keys are opaque. Validate them with `assertObjectKey()`: keys must be non-empty and relative, with no `.` or `..` segments and no NUL bytes. Never expose machine paths as keys.
- `ObjectInfo` metadata (ETag, media type, user metadata) is advisory. Mirk establishes integrity from its own SHA-256, never from an ETag.
- Optional capabilities are separate interfaces. Implement `ListableObjectStore` (`list(prefix?)`, returning `ObjectInfo[]` in a deterministic order) to enable full maintenance audits. If a backend cannot support a capability, fail explicitly instead of emulating weaker semantics.

`InMemoryObjectStore` and `InMemoryArtifactRepository` are reference implementations, not mocks: they copy bytes on the way in and out, order deterministically, and enforce the same conflict and lineage-cycle rules as `StoreArtifactRepository`. Test a new adapter against them.

## Security and Trust

- Treat `mediaType`, `filename`, annotations, and backend metadata as untrusted input. Escape `filename` before putting it in an HTTP header.
- An artifact ID or object key is not an authorization. Authorization belongs to your application.
- Never put provider tokens, cookies, connection strings, or secret-bearing requests in annotations, producer fields, or lineage parameters. Adapter credentials are configuration.
- The coordinator `namespace` prefixes object keys and idempotency keys, and `StoreArtifactRepository`'s `namespace` prefixes its metadata collections. Use distinct namespaces to isolate tenants that share a bucket or store.
- The package never executes, renders, unpacks, or transcodes artifact bytes.

## What It Does Not Do

- No job queue, retries, scheduling, progress, cancellation, or provider registry.
- No approval, publication, or application attachment state. A successful write is not acceptance.
- No media taxonomy: `kind` is your vocabulary.
- No CDN, thumbnailer, transcoder, or delivery service.
- No secret store and no second general database; metadata rides `@mirk/store`.
- No automatic garbage collection.

## License

Apache-2.0
