# @mirk/vector-qdrant

Mirk's named-vector storage on a host-owned Qdrant client. Requires Qdrant 1.18 or later and
`@qdrant/js-client-rest` 1.19 or later. The adapter owns one dedicated physical collection;
logical collections and vector namespaces share it without sharing document identities.

```ts
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@mirk/vector-qdrant";

const client = new QdrantClient({ url: "http://127.0.0.1:6333" });
const vectors = await QdrantVectorStore.open(client, {
  collectionName: "app_vectors",
  namespace: "default", // optional
});
await vectors.ensureSpace("text", { dimensions: 3 });
await vectors.ensureSpace("image", { dimensions: 2 });
await vectors.upsert("assets", {
  id: "one",
  vectors: { text: Float32Array.from([1, 0, 0]), image: Float32Array.from([0, 1]) },
  metadata: { kind: "illustration" },
});
const hits = await vectors.search("assets", {
  space: "image", vector: Float32Array.from([0, 1]),
}, { topK: 10, where: { kind: "illustration" } });
```

## Contract

`ensureSpace(name, { dimensions })` persists an immutable positive dimension definition. Conflicts
raise `space-definition-conflict`. `listSpaces()` returns `{ name, dimensions, metric: "cosine",
encoding: "float32" }` in Unicode code-point name order. Definitions are shared by logical
collections in the same namespace. The namespace defaults to `default`.

`upsert` replaces the complete vector map and metadata. Omitted vectors disappear. A document must
contain at least one declared space, and each vector must match its dimensions. `upsertMany`
validates the entire batch before issuing one Qdrant upsert request. `get` returns all raw vectors;
`count` counts documents, and `remove` removes the whole point. The old single-vector API is removed.

Each Mirk space maps to one native Qdrant named float32 `Dot` vector. The adapter indexes normalized
copies and keeps original little-endian float32 bytes in the payload. Search uses native exact
candidate prefixes, then Mirk's float64 cosine scoring. Candidate prefixes grow when rounding or
ties can affect membership; `pageSize` (default 256) sets the initial prefix, without capping results.
Zero queries score usable vectors at zero. Stored zero and non-finite vectors round-trip but do not
participate as candidates. A document missing the selected space is omitted. Unknown spaces error.

Results sort by descending score, then Unicode code-point ID. `minScore` is inclusive. Metadata
filters run before native ranking and compare exact JSON text, including object key order.
`where` requires its complete conjunction; `whereNot` excludes its complete conjunction. Absent
metadata differs from `{}`. `meta` reports `{ backend: "qdrant", accelerated: true }`; it has no
global dimension field. Client transport and backend failures propagate unchanged.

Opening creates a missing collection and required payload indexes. An incompatible schema or index
raises `QdrantCollectionError`; malformed points raise `QdrantProtocolError`. It never recreates a
collection. The host owns the client's lifecycle and collection deletion.

## Migrating an unnamed legacy collection

Stop legacy writers first. Qdrant cannot atomically migrate schema and every point in place. Copy
to a new physical collection, then switch the application's configured collection after success:

```ts
import { migrateLegacyQdrantVectors } from "@mirk/vector-qdrant";
const vectors = await migrateLegacyQdrantVectors(client, {
  sourceCollectionName: "old_vectors",
  collectionName: "named_vectors",
  pageSize: 256,
  onProgress: ({ copied, total, complete }) => console.log({ copied, total, complete }),
});
```

The source remains untouched. Legacy embeddings become space `default` in namespace `default`.
The destination carries a persisted completion marker. An interrupted destination cannot be opened
as an ordinary store; call the same migration again to resume by idempotent replacement. Completion
checks source and destination document counts before marking it ready. Reserve the destination for
this migration until completion, and keep source writers stopped throughout copy and resume.
Neither adapter deletes or swaps collections automatically. TypeScript and Python share the format
and migration marker, so either language can resume the other's interrupted copy.

## Install

```sh
pnpm add @mirk/vector-qdrant @qdrant/js-client-rest
```

### Security: override Undici

SDK `1.19.0` pins Undici `7.29.0`; SDK `1.20.0` pins `7.29.1`. Hosts using either SDK must override
Undici to `7.30.1` or later for the
[published security fixes](https://github.com/nodejs/undici/releases/tag/v7.30.1). The Mirk
workspace override does not apply to consumer installations.

For pnpm, add this to the host's `package.json`:

```json
{"pnpm":{"overrides":{"@qdrant/js-client-rest>undici":"7.30.1"}}}
```

For npm, use a nested override:

```json
{"overrides":{"@qdrant/js-client-rest":{"undici":"^7.30.1"}}}
```

For Yarn, use a resolution:

```json
{"resolutions":{"@qdrant/js-client-rest/undici":"^7.30.1"}}
```

## Exports and verification

Exports the named vector port types, `QdrantVectorStore`, collection/protocol errors,
`migrateLegacyQdrantVectors`, migration option/progress types, `candidateScoreBound(dimensions)`,
and `pointIdFor(collection, id)` (the UUID helper for an encoded physical scope).

Run `python3 scripts/run-qdrant-tests.py` from the repository root for the isolated native-server
TypeScript/Python tests and cross-language exchange. Direct tests skip when `MIRK_QDRANT_URL` is unset.
