# @mirk/artifact-opendal

> **Keep your artifact bytes on S3, or any other storage OpenDAL speaks to, without changing how
> your app writes and verifies files.**

## Why

[`@mirk/artifact`](../artifact) stores generated files such as images, exports, and model outputs.
It tracks each file's checksum, metadata, and origin, and it does not care where the bytes sit. On
your laptop they can sit on disk. In production they usually belong in a bucket.

This package is the bridge. It implements `@mirk/artifact`'s small `ObjectStore` interface on top of
[Apache OpenDAL](https://opendal.apache.org/), so the same `ArtifactCoordinator` code runs against
any OpenDAL operator you configure, such as S3, a local folder, or an in-memory test backend. OpenDAL owns the backend clients,
streaming IO, retries, signing, and provider-specific transport. Mirk keeps artifact identity,
verified integrity, metadata, and lineage.

It is deliberately thin. If a backend cannot do something the artifact layer needs, such as an
atomic create-if-missing, the adapter says so with an error and does not fake it.

ESM-only.

## Install

```bash
npm install @mirk/artifact @mirk/artifact-opendal opendal
```

`opendal` `^0.49.13` is a peer dependency, so you choose when to install the native binding.

The published Node binding still uses `rustls` `0.23.40`. It does not include the
[October TLS fixes in `rustls` `0.23.46`](https://github.com/rustls/rustls/releases/tag/v%2F0.23.46).
Hosts that require those fixes need a native build containing the patched TLS library.
Updating Node does not update this separate native TLS implementation.

## A first look

Write a file through the artifact layer, then prove it is intact. This runs with OpenDAL's in-memory
backend; swap the operator for a real one (below) and nothing else changes.

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

For S3, build the operator with your bucket settings and keep credentials in configuration:

```ts
const operator = new Operator("s3", {
  bucket: "my-artifacts",
  region: "us-east-1",
});
const objects = new OpenDalObjectStore(operator);
```

In production, pair the object store with a durable repository such as `StoreArtifactRepository`
from `@mirk/artifact/store`, so the records survive restarts as well as the bytes.

## Using the store directly

`OpenDalObjectStore` is also a plain `ObjectStore`. This is how an adapter behaves on its own:

```ts
import { Operator } from "opendal";
import { OpenDalObjectStore } from "@mirk/artifact-opendal";

const store = new OpenDalObjectStore(new Operator("memory"));

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

## Backend capabilities

Not every backend supports every feature. The constructor throws unless the operator supports
`read`, `write`, `stat`, and `delete`. Each `put` then checks the operator capabilities for the
options it was given:

| `ObjectStore` option | OpenDAL capability required | `code` when missing         |
| -------------------- | --------------------------- | --------------------------- |
| `ifAbsent`           | `writeWithIfNotExists`      | `unsupported-if-absent`     |
| `mediaType`          | `writeWithContentType`      | `unsupported-content-type`  |
| `metadata`           | `writeWithUserMetadata`     | `unsupported-user-metadata` |

If a backend cannot perform a requested feature atomically or natively, the adapter throws instead of
emulating weaker behavior. These throws are `OpenDalObjectStoreError` instances with a stable
`code`; the constructor uses `missing-required-capability`, `list()` uses
`unsupported-recursive-list`, and a key the backend returns that fails validation uses
`invalid-backend-key`. `ArtifactCoordinator.write()` always passes `ifAbsent` and `mediaType`, so a
backend used behind the coordinator needs both `writeWithIfNotExists` and `writeWithContentType`.

A failed `ifAbsent` write never deletes an object that already existed at that key. A failed
unconditional write removes its partial object.

Keys are validated with `assertObjectKey()` from `@mirk/artifact` on every call.

When OpenDAL exposes recursive listing (`list` and `listWithRecursive`), `list()` implements the
optional `ListableObjectStore` capability used by `@mirk/artifact/maintenance`; backends without
listing remain valid object stores but produce partial audits.

## Options

```ts
new OpenDalObjectStore(operator, { digestMetadataKey: "sha256" });
```

`digestMetadataKey` writes the object's SHA-256 into OpenDAL user metadata under that key and reports
it as `ObjectInfo.digest`. It requires `writeWithUserMetadata`, and it buffers each object in memory
once, because OpenDAL fixes metadata when the writer opens. Leave it unset to keep writes fully
streaming. The stored digest is advisory: `ArtifactCoordinator` still verifies bytes with its own
hash.

## Contract boundaries

This package implements only the `ObjectStore` byte port. It does not store artifact records,
lineage, MIME policy, execution semantics, or application vocabulary. Pair it with
`ArtifactCoordinator` and an `ArtifactRepository` from `@mirk/artifact` when you need artifact
identity and metadata.

## License

Apache-2.0
