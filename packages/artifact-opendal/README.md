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
import { ArtifactCoordinator, InMemoryArtifactRepository } from "@mirk/artifact";
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

`OpenDalObjectStore` checks the injected operator capabilities before using optional object-store features:

| `ObjectStore` option | OpenDAL capability required |
|---|---|
| `ifAbsent` | `writeWithIfNotExists` |
| `mediaType` | `writeWithContentType` |
| `metadata` | `writeWithUserMetadata` |

If a backend cannot perform a requested feature atomically or natively, the adapter throws instead of emulating weaker behavior.

## Contract Boundaries

This package implements only the `ObjectStore` byte port. It does not store artifact records, lineage, MIME policy, execution semantics, or application vocabulary. Pair it with `ArtifactCoordinator` and an `ArtifactRepository` from `@mirk/artifact` when you need artifact identity and metadata.

## License

Apache-2.0
