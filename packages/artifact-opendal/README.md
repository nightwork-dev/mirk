# @mirk/artifact-opendal

Thin production object-storage binding for `@mirk/artifact`. OpenDAL owns backend clients, streaming IO, retry layers, signing, and provider-specific transport. Mirk retains artifact identity, verified integrity, metadata, and lineage.

ESM-only.

## Install

```bash
npm install @mirk/artifact @mirk/artifact-opendal opendal
```

`opendal` is a peer dependency so consumers choose when to install the native/provider binding.

## Quickstart

```ts
import { Operator } from "opendal";
import { OpenDalObjectStore } from "@mirk/artifact-opendal";

const operator = new Operator("memory");
const store = new OpenDalObjectStore(operator);

async function* bytes() {
  yield new TextEncoder().encode("hel");
  yield new TextEncoder().encode("lo");
}

const info = await store.put("objects/example.txt", bytes(), {
  mediaType: "text/plain",
  ifAbsent: true,
});

console.log(info.sizeBytes); // 5

const stream = await store.get("objects/example.txt");
if (!stream) throw new Error("object missing");

let text = "";
for await (const chunk of stream) {
  text += new TextDecoder().decode(chunk, { stream: true });
}
console.log(text); // hello

await store.delete("objects/example.txt");
```

## With ArtifactCoordinator

```ts
import {
  ArtifactCoordinator,
  InMemoryArtifactRepository,
} from "@mirk/artifact";
import { Operator } from "opendal";
import { OpenDalObjectStore } from "@mirk/artifact-opendal";

const objects = new OpenDalObjectStore(new Operator("memory"));
const repository = new InMemoryArtifactRepository();
const artifacts = new ArtifactCoordinator(objects, repository, {
  namespace: "artifacts",
});

const artifact = await artifacts.write({
  bytes: new TextEncoder().encode("rendered output"),
  mediaType: "text/plain",
  producer: { system: "example", operation: "render" },
  idempotencyKey: "job-1:output",
});

console.log((await artifacts.verify(artifact.id)).ok); // true
```

## Backend Capabilities

The constructor throws unless the operator supports `read`, `write`, `stat`, and `delete`. Each `put` then checks the operator capabilities for the options it was given:

| `ObjectStore` option | OpenDAL capability required | `code` when missing           |
| -------------------- | --------------------------- | ----------------------------- |
| `ifAbsent`           | `writeWithIfNotExists`      | `unsupported-if-absent`       |
| `mediaType`          | `writeWithContentType`      | `unsupported-content-type`    |
| `metadata`           | `writeWithUserMetadata`     | `unsupported-user-metadata`   |

If a backend cannot perform a requested feature atomically or natively, the adapter throws instead of emulating weaker behavior. These throws are `OpenDalObjectStoreError` instances with a stable `code`; the constructor uses `missing-required-capability`, `list()` uses `unsupported-recursive-list`, and a key the backend returns that fails validation uses `invalid-backend-key`. `ArtifactCoordinator.write()` always passes `ifAbsent` and `mediaType`, so a backend used behind the coordinator needs both `writeWithIfNotExists` and `writeWithContentType`.

A failed `ifAbsent` write never deletes an object that already existed at that key. A failed unconditional write removes its partial object.

Keys are validated with `assertObjectKey()` from `@mirk/artifact` on every call.

When OpenDAL exposes recursive listing (`list` and `listWithRecursive`), `list()` implements the optional `ListableObjectStore` capability used by `@mirk/artifact/maintenance`; backends without listing remain valid object stores but produce partial audits.

## Options

```ts
new OpenDalObjectStore(operator, { digestMetadataKey: "sha256" });
```

`digestMetadataKey` writes the object's SHA-256 into OpenDAL user metadata under that key and reports it as `ObjectInfo.digest`. It requires `writeWithUserMetadata`, and it buffers each object in memory once, because OpenDAL fixes metadata when the writer opens. Leave it unset to keep writes fully streaming. The stored digest is advisory: `ArtifactCoordinator` still verifies bytes with its own hash.

## Contract Boundaries

This package implements only the `ObjectStore` byte port. It does not store artifact records, lineage, MIME policy, execution semantics, or application vocabulary. Pair it with `ArtifactCoordinator` and an `ArtifactRepository` from `@mirk/artifact` when you need artifact identity and metadata.

## License

Apache-2.0
