# @mirk/store-libsql

A **libSQL / Turso** source adapter for [`@mirk/store`](../store)'s **async** ports.
One libSQL client, two capability facets over one connection: `.kv` is an
`AsyncStore` (key-value + collections), `.vector` is an `AsyncVectorStore` (vector
similarity search). Works over **remote** (`libsql://…`, Turso), **file:**, and
**`:memory:`** URLs.

ESM-only (the package exposes an `import` entry point; there is no CommonJS build).

## Why a separate adapter (and not `@mirk/store/sqlite`)

`@mirk/store/sqlite` is the **synchronous** better-sqlite3 adapter, and its vector
search relies on the optional `sqlite-vec` (vec0) extension. vec0 **cannot load
over a remote libSQL connection**, so it's a non-starter for Turso.

This adapter implements the **async** ports natively (every call is a `Promise`,
because libSQL is a network/file client) and uses libSQL's **native vector search**
— `F32_BLOB(N)` columns, `vector32()`, `vector_distance_cos()`, and the
`vector_top_k('idx', vec, k)` table-valued function over a `libsql_vector_idx`
index. No extension to load, no `createRequire`; it works everywhere libSQL runs.

## Install

```bash
npm install @mirk/store-libsql
```

`@libsql/client` and `@mirk/store` are regular dependencies — nothing else to add.

## Usage

```ts
import { LibsqlAdapter } from "@mirk/store-libsql";

// Remote (Turso):
const adapter = await LibsqlAdapter.open({
  url: "libsql://your-db.turso.io",
  authToken: process.env.TURSO_AUTH_TOKEN,
  dimensions: 1536, // required to use the .vector facet; KV works without it
});

// Or local file: / :memory: for dev + tests:
// const adapter = await LibsqlAdapter.open({ url: "file:./data.db", dimensions: 4 });

// KV facet — AsyncStore
await adapter.kv.set("site.title", "My Knowledge Base");
await adapter.kv.put("users", { id: "u1", name: "Ada" });
const ada = await adapter.kv.getById("users", "u1");

// Vector facet — AsyncVectorStore
await adapter.vector.upsert("docs", {
  id: "a",
  vector: Float32Array.from([/* … 1536 floats … */]),
  metadata: { type: "document" },
});

// Pre-KNN metadata filter: topK is the true nearest WITHIN the filtered set.
const hits = await adapter.vector.search("docs", queryVector, {
  topK: 5,
  where: { type: "document" },
});

adapter.close();
```

### Reusing an existing client

Pass `opts.client` to share an already-open `@libsql/client`. The adapter tracks
ownership: `close()` is a **no-op** for a caller-supplied client (you keep the
connection's lifecycle).

```ts
import { createClient } from "@libsql/client";
const client = createClient({ url: "file:./data.db" });
const adapter = await LibsqlAdapter.open({ url: "file:./data.db", client, dimensions: 4 });
// … adapter.close() will NOT close `client`.
```

## API

`LibsqlAdapter.open(opts)` → `Promise<LibsqlAdapter>`:

| Option | Type | Notes |
|---|---|---|
| `url` | `string` | `libsql://…`, `file:…`, or `:memory:` |
| `authToken` | `string?` | for remote/Turso databases |
| `client` | `Client?` | reuse an existing `@libsql/client` (not closed on `close()`) |
| `dimensions` | `number?` | required for the `.vector` facet; persisted + enforced across reopens |
| `forceJsCosine` | `boolean?` | force the exact JS-cosine search path (parity testing) |

The adapter exposes `readonly kv: AsyncStore`, `readonly vector: AsyncVectorStore`,
and `close(): void`.

## Search semantics

- **No filters + usable query + accelerated** → native `vector_top_k` +
  `vector_distance_cos` (`score = 1 − distance`), with `minScore` applied.
- **Any `where` / `whereNot`** → the exact JS path: rows for the collection are
  fetched, **filtered first**, then scored and cut to `topK`. This guarantees
  `topK` is the true nearest **within the filtered set** — the same semantics as
  `@mirk/store`'s in-memory and sqlite backends. Verified by the
  filter-before-KNN and parity tests.

Dimensionality is persisted in a `_vec_meta` row and enforced on reopen; opening a
store at a different dimension than it was created with throws.

## License

Apache-2.0
