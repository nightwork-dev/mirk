# @mirk/store-libsql

A **libSQL / Turso** source adapter for [`@mirk/store`](../store)'s **async** ports.
One libSQL client, two capability facets over one connection: `.kv` is an
`AsyncStore` (key-value + collections), `.vector` is an `AsyncVectorStore` (vector
similarity search). The default entry works over **remote** (`libsql://…`, Turso),
**file:**, and **`:memory:`** URLs. The `@mirk/store-libsql/remote` entry is an
engine-free remote-only variant using the SDK web transport.

ESM-only (the package exposes an `import` entry point; there is no CommonJS build).

## Why a separate adapter (and not `@mirk/store/sqlite`)

`@mirk/store/sqlite` is the **synchronous** better-sqlite3 adapter: it opens a local
file and ranks vectors by exact cosine in JavaScript. It cannot talk to a remote
libSQL server or Turso.

This adapter implements the **async** ports natively (every call is a `Promise`,
because libSQL is a network/file client) and uses libSQL's **native vector search**
— `F32_BLOB(N)` columns, `vector32()`, `vector_distance_cos()`, and the
`vector_top_k('idx', vec, k)` table-valued function over a `libsql_vector_idx`
index. No extension to load; it works everywhere libSQL runs.

## Install

```bash
npm install @mirk/store-libsql
```

`@libsql/client` and `@mirk/store` are regular dependencies — nothing else to add.

### Engine-free remote entry

When local SQLite storage is not needed, import the remote entry. It binds to
`@libsql/client/web`, so importing it does not load libSQL's native SQLite
engine. It accepts `libsql://`, `https://`, `http://`, `wss://`, and `ws://`
URLs and rejects `file:` and `:memory:` before creating a client.

```ts
import { LibsqlAdapter } from "@mirk/store-libsql/remote";

const adapter = await LibsqlAdapter.open({
  url: "libsql://your-db.turso.io",
  authToken: process.env.TURSO_AUTH_TOKEN,
});
```

Use the package root when local `file:` or `:memory:` support is required.
The SDK remains a dependency, so package managers may still install its native packages.
The remote export avoids loading them. Caller-supplied clients remain the host's responsibility.

## Native SQLite security scope

The local libSQL engine currently lacks published SQLite FTS5 and WAL fixes.
The latest stable libSQL native release also lacks these fixes; an SDK upgrade alone does not resolve them.
See the [upstream report](https://github.com/tursodatabase/libsql/issues/2271) and
[SQLite release notes](https://sqlite.org/releaselog/3_53_2.html).
For local storage, use `@mirk/store/node-sqlite` or the better-sqlite3 13 adapter.
Existing libSQL vector tables require a separate migration before switching adapters.
Remote server operators remain responsible for their server's SQLite build.

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
const queryVector = new Float32Array(1536);
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
For the remote export, create supplied clients with `createClient` from `@libsql/client/web`.

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
  `@mirk/store`'s in-memory and sqlite backends.

Native search errors propagate to the caller. They do not trigger a full collection
scan. Use `forceJsCosine` to select JavaScript scoring explicitly.

Dimensionality is persisted in a `_vec_meta` row and enforced on reopen; opening a
store at a different dimension than it was created with throws.

## Not supported

- The optional atomic mutation capability from `@mirk/store/atomic`.
- A search facet; use `@mirk/store/sqlite` or another `AsyncSearchStore` backend.

## Remote integration check

Build the workspace, then run against a libSQL server executable:

```bash
MIRK_LIBSQL_SERVER=/path/to/sqld pnpm --filter @mirk/store-libsql test:remote
```

The check starts an isolated loopback server with temporary data and removes it afterward.
It exercises the published remote export over HTTP, WebSocket, and `libsql://` URLs while native imports are denied.
It also checks generated consumer declarations and keeps a negative control for the native-capable root import.

## License

Apache-2.0
