# @mirk/store

Code-split storage **ports** + source **adapters** under one namespace. Import the whole
namespace, or just the specific subpath you need — the interface ports and their in-memory
reference implementations are zero-native, and only the SQLite adapter references native
bindings (as optional peers).

ESM-only (the package exposes `import` entry points; there is no CommonJS build).

## Install

```bash
npm install @mirk/store
# Using the SQLite adapter (@mirk/store/sqlite)? Add its peer:
npm install better-sqlite3
# Optional: vec0 KNN acceleration (graceful exact-JS fallback without it)
npm install sqlite-vec
```

## Subpaths

| Import | What it gives you | Native deps |
|---|---|---|
| `@mirk/store` | the ports + their in-memory references + `toAsync` + cosine helpers | none |
| `@mirk/store/kv` | `SyncStore` port (key-value + collections), `InMemoryKv`, `toAsync` | none |
| `@mirk/store/vector` | `VectorStore` port, `InMemoryVectorStore`, cosine helpers | none |
| `@mirk/store/search` | `SearchStore` port, `InMemorySearchStore`, BM25-style keyword search | none |
| `@mirk/store/graph` | graph helpers over the collection port (`neighbors`, `traverse`, `traverseFrontierBatched`) | none |
| `@mirk/store/sqlite` | the SQLite **source adapter** — one connection, `.kv` + `.vector` + `.search` facets | `better-sqlite3` (peer), `sqlite-vec` (optional peer) |

Source adapters are reached **only** through their own subpath (e.g. `/sqlite`) — the root and the
port subpaths never re-export them, so importing `@mirk/store`, `/kv`, `/vector`, `/search`, or
`/graph` never drags a native binding into a consumer bundle.

## Quickstart — zero native deps

The in-memory references implement the same ports as the backends, so you can build against them
with nothing installed:

```ts
import { InMemoryKv, toAsync } from "@mirk/store/kv";

const kv = new InMemoryKv();
kv.set("user:1", { name: "Ada" });
kv.get<{ name: string }>("user:1");   // { name: "Ada" }
kv.keys("user:");                      // ["user:1"]

// Lift any SyncStore to a Promise-returning API (one-way: sync ⊂ async):
const asyncKv = toAsync(kv);
await asyncKv.get("user:1");
```

### Collections

A `SyncStore` is also a small document store, keyed by `id`:

```ts
kv.put("posts", { id: "p1", title: "Hello", pinned: true });
kv.getById("posts", "p1");                       // { id: "p1", title: "Hello", pinned: true }
kv.list("posts", { where: { pinned: true }, sortBy: "title", limit: 10 });
kv.count("posts");                               // 1
kv.remove("posts", "p1");
```

## Full-text search

`SearchStore` indexes documents by id and returns BM25-ranked keyword matches. Use `text` for the
single-field shorthand or `fields` for named columns with query-time weighting:

```ts
import { InMemorySearchStore } from "@mirk/store/search";

const search = new InMemorySearchStore();
search.index("pages", { id: "a", fields: { title: "Opal guide", body: "plain body" } });
search.index("pages", { id: "b", fields: { title: "plain title", body: "Opal guide" } });
search.search("pages", "opal", { fieldWeights: { title: 4, body: 1 } }); // [a, b]
```

The first indexed document fixes a collection's field schema; later documents must use the same
field names. `text` and `fields: { text }` are the same single-field schema for backwards
compatibility.

## Graph helpers

`@mirk/store/graph` stores edges as ordinary collection records and traverses them through the
existing collection port. Policy stays caller-owned through `StoreFilter`.

```ts
import { traverse } from "@mirk/store/graph";

const hits = traverse(kv, { start: "node:a", depth: 2, direction: "out" });
```

## SQLite adapter — one connection, many capabilities

`SqliteAdapter` opens a single `better-sqlite3` database and exposes `.kv` (`SyncStore`), `.vector`
(`VectorStore`), and `.search` (`SearchStore`) facets over it:

```ts
import { SqliteAdapter } from "@mirk/store/sqlite";

// .kv and .search work immediately; vector dimensions infer on first write.
const db = new SqliteAdapter({ path: "data.db" });

db.kv.set("user:1", { name: "Ada" });

db.search.index("pages", { id: "intro", fields: { title: "Intro", body: "hello world" } });
db.search.search("pages", "hello", { fieldWeights: { title: 4, body: 1 } });

const embedding = new Float32Array(768); // your real embedding here
const query = new Float32Array(768);
db.vector.upsert("docs", { id: "a", vector: embedding });
const results = db.vector.search("docs", query, { topK: 10 }); // ranked by cosine

db.close();
```

### `SqliteAdapter` options

| Option | Type | Notes |
|---|---|---|
| `path` | `string` | DB file path, or `":memory:"`. |
| `db` | `Database` | Reuse an existing `better-sqlite3` connection instead of opening one. |
| `dimensions` | `number` | Optional embedding dimensionality. If omitted, inferred and persisted from the first vector `upsert` / `upsertMany`; `search` still requires known dimensions. |
| `forceJsCosine` | `boolean` | Pin the exact JS-cosine path even when `sqlite-vec` is installed (mainly for tests). |

Vectors (`Vector` is a `Float32Array`) are stored as little-endian float32 BLOBs and ranked by
**exact cosine**. When the optional `sqlite-vec` peer is installed, search is transparently
accelerated by vec0 using the `cosine` distance metric, so rankings are identical to the JS path;
without it, the exact JS-cosine fallback runs. `db.vector.meta.accelerated` reports which path is
live.

## Sync by design

Embedded backends are **synchronous** — `better-sqlite3` is synchronous, and an async-everywhere
interface would tax every local call with a Promise it doesn't need. A `SyncStore` lifts to an
async API via `toAsync(store)`; the reverse is impossible. Pick sync for embedded/local, and reach
for async only where a remote backend genuinely requires it.

## License

Apache-2.0 © David Robinson
