# @mirk/store-libsql

> **Your app's records and vectors in a hosted SQLite database.** Key-values, collections, and
> vector search over libSQL: Turso, a `sqld` server, or a local file.

## Why

The SQLite file in `@mirk/store` lives next to your code. That is perfect until the code runs
somewhere with no durable disk, such as a serverless function or an edge worker, or until several
machines need the same data. A local file cannot be reached over the network, and
`@mirk/store/sqlite` cannot open a remote database.

libSQL is SQLite served over the network, and Turso hosts it. This adapter lets the same Mirk
interfaces talk to it. Your code keeps calling `kv.put`, `kv.list`, and `vector.search`, and the
data lives on the server.

What you give up compared with the SQLite file:

- **Every call is async.** A network or file client returns Promises, so you use the async ports,
  not the synchronous ones.
- **No full-text search and no atomic batches.** This adapter has no search facet and does not
  implement the optional atomic mutation capability.
- **Vector search takes two paths.** Without filters it uses libSQL's native index. With
  filters it scores exactly in JavaScript (see [Search semantics](#search-semantics)).

## A first look

```ts
import { LibsqlAdapter } from "@mirk/store-libsql";

const adapter = await LibsqlAdapter.open({
  url: "file:./data.db", // or "libsql://your-db.turso.io" with an authToken, or ":memory:"
  dimensions: 4,         // the size of your embeddings; only needed for .vector
});

// .kv is an AsyncStore: key-values and collections
await adapter.kv.set("settings", { theme: "dark" });
await adapter.kv.put("tasks", { id: "t1", title: "Send invoice", status: "open" });
const open = await adapter.kv.list("tasks", { where: { status: "open" } });

// .vector is an AsyncVectorStore: similarity search
await adapter.vector.upsert("docs", {
  id: "a",
  vector: Float32Array.from([1, 0, 0, 0]),
  metadata: { type: "document" },
});
const hits = await adapter.vector.search("docs", Float32Array.from([1, 0, 0, 0]), {
  topK: 5,
  where: { type: "document" }, // the filter applies before the top-K cut
});

adapter.close();
```

For a hosted database, use a remote URL and a token:

```ts
const adapter = await LibsqlAdapter.open({
  url: "libsql://your-db.turso.io",
  authToken: process.env.TURSO_AUTH_TOKEN,
  dimensions: 1536,
});
```

## Install

```bash
npm install @mirk/store-libsql
```

`@libsql/client` and `@mirk/store` are regular dependencies; nothing else to add. The package is
ESM-only (there is no CommonJS build).

## What it covers

| Capability | Covered | Where |
| --- | --- | --- |
| Key-values | yes | `adapter.kv` (`AsyncStore`) |
| Collections | yes | `adapter.kv` (`AsyncStore`) |
| Vectors | yes | `adapter.vector` (`AsyncVectorStore`), needs `dimensions` |
| Full-text search | no | use `@mirk/store/sqlite` or another `AsyncSearchStore` backend |
| Atomic writes | no | the optional atomic mutation capability from `@mirk/store/atomic` is not implemented |

One libSQL client serves both facets over one connection. They are separate objects, not one class,
because the key-value and vector ports declare `get`, `remove`, and `count` with different shapes.

### Where it differs from the reference

The in-memory and SQLite stores are the reference. Compared with them:

- All calls return Promises.
- Vector search without filters uses libSQL's native index; with `where` or `whereNot` it scores
  exactly in JavaScript, with the reference semantics (see below).
- There is no search facet and no atomic mutation.

## Engine-free remote entry

When you do not need local SQLite storage, import the remote entry. It binds to
`@libsql/client/web`, so importing it does not load libSQL's native SQLite engine. It accepts
`libsql://`, `https://`, `http://`, `wss://`, and `ws://` URLs, and rejects `file:` and `:memory:`
before creating a client.

```ts
import { LibsqlAdapter } from "@mirk/store-libsql/remote";

const adapter = await LibsqlAdapter.open({
  url: "libsql://your-db.turso.io",
  authToken: process.env.TURSO_AUTH_TOKEN,
});
```

Use the package root when local `file:` or `:memory:` support is required. The SDK remains a
dependency, so package managers may still install its native packages. The remote export avoids
loading them. Caller-supplied clients remain the host's responsibility.

## Reusing an existing client

Pass `opts.client` to share an already-open `@libsql/client`. The adapter tracks ownership:
`close()` is a **no-op** for a caller-supplied client, so you keep the connection's lifecycle.
For the remote export, create supplied clients with `createClient` from `@libsql/client/web`.

```ts
import { createClient } from "@libsql/client";
const client = createClient({ url: "file:./data.db" });
const adapter = await LibsqlAdapter.open({ url: "file:./data.db", client, dimensions: 4 });
// adapter.close() will NOT close `client`.
```

## Reference

### API

`LibsqlAdapter.open(opts)` returns `Promise<LibsqlAdapter>`:

| Option | Type | Notes |
|---|---|---|
| `url` | `string` | `libsql://…`, `file:…`, or `:memory:` |
| `authToken` | `string?` | for remote/Turso databases |
| `client` | `Client?` | reuse an existing `@libsql/client` (not closed on `close()`) |
| `dimensions` | `number?` | required for the `.vector` facet; persisted and enforced across reopens |
| `forceJsCosine` | `boolean?` | force the exact JS-cosine search path (parity testing) |

The adapter exposes `readonly kv: AsyncStore`, `readonly vector: AsyncVectorStore`, and
`close(): void`. Key-values work without `dimensions`.

### Search semantics

- **No filters, a usable query, and acceleration available:** native `vector_top_k` plus
  `vector_distance_cos` (`score = 1 − distance`), with `minScore` applied.
- **Any `where` or `whereNot`:** the exact JS path. Rows for the collection are fetched,
  **filtered first**, then scored and cut to `topK`. This guarantees `topK` is the true nearest
  **within the filtered set**, the same semantics as `@mirk/store`'s in-memory and SQLite backends.

Native search errors propagate to the caller. They do not trigger a full collection scan. Use
`forceJsCosine` to select JavaScript scoring explicitly.

The native path uses libSQL's own vector support: `F32_BLOB(N)` columns, `vector32()`,
`vector_distance_cos()`, and the `vector_top_k('idx', vec, k)` function over a `libsql_vector_idx`
index. No extension to load; it works everywhere libSQL runs.

Dimensionality is persisted in a `_vec_meta` row and enforced on reopen. Opening a store at a
different dimension than it was created with throws.

### Native SQLite security scope

The local libSQL engine currently lacks published SQLite FTS5 and WAL fixes. The latest stable
libSQL native release also lacks these fixes; an SDK upgrade alone does not resolve them. See the
[upstream report](https://github.com/tursodatabase/libsql/issues/2271) and
[SQLite release notes](https://sqlite.org/releaselog/3_53_2.html). For local storage, use
`@mirk/store/node-sqlite` or the better-sqlite3 13 adapter. Existing libSQL vector tables require a
separate migration before switching adapters. Remote server operators remain responsible for their
server's SQLite build.

### Remote integration check

Build the workspace, then run against a libSQL server executable:

```bash
MIRK_LIBSQL_SERVER=/path/to/sqld pnpm --filter @mirk/store-libsql test:remote
```

The check starts an isolated loopback server with temporary data and removes it afterward. It
exercises the published remote export over HTTP, WebSocket, and `libsql://` URLs while native
imports are denied. It also checks generated consumer declarations and keeps a negative control for
the native-capable root import.

## License

Apache-2.0
