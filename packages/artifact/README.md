# @mirk/artifact

Portable artifact identity, SHA-256 integrity, metadata, lineage, and coordination over a small object-store port.

The root package is runtime-neutral. It exports the artifact coordinator, in-memory reference implementations, object-store types, digest helpers, and validation helpers. Use `@mirk/artifact/store` to persist metadata through `@mirk/store/kv`; use `@mirk/artifact/fs` for a Node filesystem object store; use a separate adapter such as `@mirk/artifact-opendal` for production object-storage backends.

ESM-only.

Atomic finalization, repository object leases, and maintenance are implemented locally. Publication
and consumer adoption need separate evidence.

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

`ArtifactCoordinator.write()` stores bytes first, records SHA-256 and byte length as the stream is consumed, then commits metadata. If metadata commit fails, it attempts to delete the orphaned object and reports the cleanup result through `ArtifactWriteError`.

Finalization concurrency is explicit. The default `{ mode: "single-writer" }` requires deployment-level exclusion. Use `{ mode: "repository-atomic" }` with `StoreArtifactRepository` over a store that exposes `AsyncAtomicMutationStore` for atomic idempotent metadata decisions. Mirk computes the `mirk-artifact-finalization/v1` request digest; callers never provide it.

`@mirk/artifact/maintenance` performs read-only audits. `planRepair()` creates opaque, audit-scoped references and conditional actions; `applyRepair()` is a separate explicit call. Destructive orphan deletion requires the repository-owned shared-writer/exclusive-delete lease capability and returns a `lease-unavailable` conflict when a repository cannot enforce it. Preconditions return conflicts; backend failures reject. Object-store keys are not included in findings or repair plans.

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

Keys must be non-empty relative paths and may not contain `.` or `..` segments, absolute paths, or NUL bytes. `put(..., { ifAbsent: true })` is an atomic create-if-missing operation for backends that support it.

## License

Apache-2.0
