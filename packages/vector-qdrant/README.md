# @mirk/vector-qdrant

`@mirk/vector-qdrant` implements Mirk's `AsyncVectorStore` for Node.js over an injected
Qdrant client. The host owns the client and chooses one dedicated physical
Qdrant collection for each adapter instance:

```ts
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@mirk/vector-qdrant";

const client = new QdrantClient({ url: "http://127.0.0.1:6333" });
const vectors = await QdrantVectorStore.open(client, {
  collectionName: "my_app_vectors",
  dimensions: 3,
});

await vectors.upsert("articles", {
  id: "article-1",
  vector: Float32Array.from([1, 0, 0]),
  metadata: { kind: "article" },
});

const matches = await vectors.search("articles", Float32Array.from([1, 0, 0]));
```

The adapter creates a missing physical collection with an unnamed Dot vector
of the configured size, validates an existing collection before using it, and
creates the payload indexes needed for scoped metadata filtering. It never
recreates or deletes a physical collection. `pageSize` is the initial native
prefix size and defaults to 256. The adapter grows that prefix when exact
completion needs more candidates, so it does not cap the public `search` result
set.

Vectors are stored as their original little-endian float32 bytes in payload and
indexed as rounded float32 unit vectors. Public scores are recomputed with
Mirk's cosine helper so result values and ordering match the other Mirk vector
stores. Non-finite stored vectors are retained and returned by `get`, but are
excluded from search. A zero query has score `0` for every usable stored vector;
because this is one exact score tie, the adapter may read the complete matching
set even when `topK` is small.

The Qdrant client is an optional peer dependency. Install a compatible
`@qdrant/js-client-rest` version (`^1.19.0`) and pass the configured client to `open`.

SDK `1.19.0` pins Undici `7.29.0`. Hosts using that SDK version should override
Undici to `7.29.1`, which includes the [published security fixes](https://github.com/nodejs/undici/releases/tag/v7.29.1).
For pnpm, add this to the host's `package.json`:

```json
{"pnpm":{"overrides":{"@qdrant/js-client-rest>undici":"7.29.1"}}}
```
