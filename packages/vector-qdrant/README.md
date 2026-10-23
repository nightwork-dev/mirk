# @mirk/vector-qdrant

> **Mirk's vector search, on a Qdrant server.** The same interface as the SQLite vector store, with
> exact cosine scores and metadata filters, for when your vectors outgrow a local file.

## Why

Mirk's SQLite stores rank vectors by exact cosine similarity, and that is plenty for many apps. At
some size you may want a dedicated vector database that lives on its own server, is shared by
several services, or is already part of your infrastructure.

The risk in switching is that "nearest neighbours" quietly changes meaning. Approximate indexes
return slightly different results. Ties come back in a different order. A filter treats a missing
field differently. Code that worked on SQLite gives different answers on the new backend.

`@mirk/vector-qdrant` implements Mirk's `AsyncVectorStore` over a [Qdrant](https://qdrant.tech)
client you provide. It asks Qdrant for exact candidates, then recomputes every score itself with
Mirk's cosine function. Results, order, and filters match the other Mirk vector stores. The same
shared vector scenarios that check the SQLite stores check this one when a Qdrant server is
available to the tests.

**Reach for it when** you already run Qdrant, or want vectors on a separate server. **Stay on
SQLite when** one local file is enough: it is simpler and needs nothing running.

## A first look

```ts
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@mirk/vector-qdrant";

const client = new QdrantClient({ url: "https://qdrant.example.com" });
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

`matches` is a list of `{ id, score, metadata? }`, best first. The first call to `open` creates the
Qdrant collection if it is missing.

## Install

```bash
npm install @mirk/vector-qdrant @qdrant/js-client-rest
```

The Qdrant client is an optional peer dependency. Install a compatible `@qdrant/js-client-rest`
version (`^1.19.0`) and pass the configured client to `open`. The host owns the client and its
lifecycle. Use Node 22.23.4+, 24.22.1+, or 26.12.1+.

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

## How it uses Qdrant

You pick **one dedicated Qdrant collection** for each adapter instance (`collectionName`). The
`collection` argument on each vector call, such as `"articles"` above, is a logical scope stored in
each point's payload, so several scopes can share the one physical collection. `count(collection)`
counts one scope.

On `open`, the adapter:

- creates the physical collection if it is missing, with an unnamed `Dot` vector of the configured
  size;
- validates an existing collection before using it, and throws `QdrantCollectionError` if it has
  named vectors, a different size or distance, a datatype other than float32, or a multivector
  configuration;
- creates the payload indexes that scoped metadata filtering needs, and throws
  `QdrantCollectionError` if an index already exists with the wrong type;
- never recreates or deletes a physical collection.

Writes and deletes wait for Qdrant to finish. Transport, authentication, and backend errors from
the client propagate unchanged.

## Search

```ts
await vectors.search("articles", query, {
  topK: 5,                      // default 10
  minScore: 0.8,                // inclusive; applied after exact scoring
  where: { kind: "article" },   // keep only documents whose metadata matches all of these
  whereNot: { draft: true },    // drop documents whose metadata matches any of these
});
```

- **Exact scores.** Vectors are stored as their original little-endian float32 bytes in payload and
  indexed as rounded float32 unit vectors. Public scores are recomputed with Mirk's cosine helper,
  so values and ordering match the other Mirk vector stores.
- **Order.** Highest score first. Equal scores order by document id in Unicode code point order.
- **Filters** are exact matches on JSON text, so object key order and array order matter:
  `{ nested: { b: 2, a: 1 } }` does not match metadata stored as `{ nested: { a: 1, b: 2 } }`.
  Filters apply before ranking, so `topK` is taken from the documents that pass.
- **Unusable vectors.** A stored vector with a non-finite component (`NaN` or infinity) is kept and
  returned by `get`, but never appears in search results.
- **Zero query.** A zero query has score `0` for every usable stored vector. That is one exact
  score tie, so the adapter may read the whole matching set even when `topK` is small.
- **`pageSize`** is the initial native prefix size and defaults to 256. The adapter grows that
  prefix when exact completion needs more candidates, such as for ties beyond the prefix, so it does
  not cap the public result set.

## Reference

### `QdrantVectorStore.open(client, options)`

| Option           | Default  | Meaning                                                              |
| ---------------- | -------- | -------------------------------------------------------------------- |
| `collectionName` | required | The physical Qdrant collection this adapter owns.                    |
| `dimensions`     | required | Positive integer. Every vector and query must have this length.      |
| `pageSize`       | 256      | Positive integer. Initial native prefix size for search.             |

Invalid `dimensions` throws `VectorInputError` and an invalid `pageSize` throws
`QdrantCollectionError`, both before any call to Qdrant.

### Methods

`upsert`, `upsertMany`, `get`, `has`, `remove`, `count`, and `search`, as defined by
`AsyncVectorStore` in `@mirk/store/vector`. `upsertMany` checks every document's dimensions before
writing any, and an empty batch does nothing. `meta` reports `{ backend: "qdrant", dimensions,
accelerated: true }`.

### Errors

- `QdrantCollectionError` — the physical collection or an option does not satisfy the contract.
- `QdrantProtocolError` — a point in the collection is not a valid Mirk record, for example a
  payload written by something else.

### Exports

`QdrantVectorStore`, `QdrantCollectionError`, `QdrantProtocolError`, `pointIdFor(collection, id)`
(the deterministic UUID for a scope and id), `candidateScoreBound(dimensions)`, and the vector port
types `AsyncVectorStore`, `Vector`, `VectorDocument`, `VectorSearchOptions`, `VectorSearchResult`,
and `VectorStoreMeta`.

### Shared with Python

The stored point format is the same as `mirk-vector-qdrant`, so a collection written from
TypeScript can be read from Python, and the other way round.
