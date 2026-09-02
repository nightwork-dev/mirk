# @mirk/store

Code-split storage **ports** + source **adapters** under one namespace. Import the whole
namespace, or just the specific subpath you need — the interface ports and their in-memory
reference implementations are zero-native, and only the SQLite adapter references native
bindings (as optional peers).

ESM-only (the package exposes `import` entry points; there is no CommonJS build).

Atomic mutation, SQLite inspection/checkpoint operations, and the repository-owned evidence harness
are implemented locally. Publication and consumer adoption need separate evidence.

## Install

```bash
npm install @mirk/store
# Using the SQLite adapter (@mirk/store/sqlite)? Add its peer:
npm install better-sqlite3
```

## Subpaths

| Import                     | What it gives you                                                                                                                                | Native deps                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `@mirk/store`              | the ports + their in-memory references + `toAsync` / `toAsyncSearch`, graph contract types, cosine helpers                                       | none                                                  |
| `@mirk/store/kv`           | `SyncStore` port (key-value + collections), `InMemoryKv`, `toAsync`                                                                              | none                                                  |
| `@mirk/store/atomic`       | Optional versioned reads, declarative atomic mutations, idempotent receipts, canonical request digests, and capability guards                    | none                                                  |
| `@mirk/store/vector`       | `VectorStore` port, `InMemoryVectorStore`, cosine helpers                                                                                        | none                                                  |
| `@mirk/store/search`       | `SearchStore` / `AsyncSearchStore` ports, `InMemorySearchStore`, `toAsyncSearch`, BM25-style keyword search                                      | none                                                  |
| `@mirk/store/graph`        | graph helpers over the collection port (`neighbors`, `traverse`, `traverseFrontierBatched`) plus `AsyncGraphTraversal` for native graph adapters | none                                                  |
| `@mirk/store/sql`          | SQL adapter contract types                                                                                                                       | none                                                  |
| `@mirk/store/coordination` | SQLite-backed async keyed coordinator with leases, renewal, fencing generations, and ownership-loss checks                                       | `better-sqlite3` (peer)                               |
| `@mirk/store/sqlite`       | the SQLite **source adapter** — one connection, `.kv` + `.vector` + `.search` facets                                                             | `better-sqlite3` (peer)                               |

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
kv.get<{ name: string }>("user:1"); // { name: "Ada" }
kv.keys("user:"); // ["user:1"]

// Lift any SyncStore to a Promise-returning API (one-way: sync ⊂ async):
const asyncKv = toAsync(kv);
await asyncKv.get("user:1");
```

Bind logical stores to one backing without exposing physical key or collection prefixes:

```ts
import { namespaceStore } from "@mirk/store";

const projects = namespaceStore(kv, "app.projects.v1");
const workspaces = namespaceStore(kv, "app.workspaces.v1");
```

Namespaces isolate keys and collection names while preserving the ordinary `SyncStore` contract.

## Optional atomic mutation

`@mirk/store/atomic` adds versioned reads and a bounded declarative mutation batch without changing
the base `SyncStore` or `AsyncStore` ports. The in-memory reference and `SqliteAdapter.kv` implement
the capability; discover it with `supportsAtomicMutation` (or
`supportsAsyncAtomicMutation` after `toAsync`). Conditions are checked at one decision point, and
an applied batch returns one opaque version per operation target:

```ts
import { InMemoryKv, supportsAtomicMutation } from "@mirk/store";

const kv = new InMemoryKv();
if (supportsAtomicMutation(kv)) {
  const result = kv.mutateAtomically({
    conditions: [
      { target: { kind: "key", key: "counter" }, expected: "missing" },
    ],
    operations: [{ op: "set", key: "counter", value: 1 }],
    idempotency: { key: "initialize-counter", outcome: { accepted: true } },
  });
  // A retry with the same key and request returns status "replayed".
  result.status;
}
```

Atomic payloads are JSON-safe only. Requests reject duplicate targets, empty batches, malformed
values, and oversized requests before any decision. Idempotency receipts never expire and are
durable in SQLite. `namespaceStore()` preserves the capability while binding targets, versions, and
receipt keys to the namespace.

### Request limits are per backend

Request bounds are a wire-contract guard, so their right value depends on how far the request
travels. Every atomic store publishes what it enforces as `store.atomicLimits`, and a wrapper
(`namespaceStore`, `toAsync`) reports the limits of the store underneath it.

| Limit | `DEFAULT_ATOMIC_LIMITS` | `IN_PROCESS_ATOMIC_LIMITS` |
| --- | --- | --- |
| `maxOperations` | 128 | 4096 |
| `maxConditions` | 128 | 1024 |
| `maxRequestBytes` | 1 MiB | 16 MiB |

`InMemoryKv` and `SqliteAdapter.kv` both run in the calling process and use the in-process set: the
request is never serialized onto a network and the batch is one local `BEGIN IMMEDIATE`. A remote
or unknown transport should keep `DEFAULT_ATOMIC_LIMITS`.

Override any field at construction:

```ts
const adapter = new SqliteAdapter({
  path: "world.sqlite",
  atomicLimits: { maxOperations: 512 },
});
adapter.kv.atomicLimits.maxOperations; // 512
adapter.kv.atomicLimits.maxConditions; // 1024, the unoverridden in-process default
```

A rejection names the limit and its value, for example
`request has 11 operations; this store's maxOperations is 10`.

**The idempotency outcome cap is not configurable.** An outcome is persisted under its key forever,
so `MAX_ATOMIC_OUTCOME_BYTES` (64 KiB) is a hard cap in every backend regardless of the limits
above.

### Collections

A `SyncStore` is also a small document store, keyed by `id`:

```ts
kv.put("posts", { id: "p1", title: "Hello", pinned: true });
kv.getById("posts", "p1"); // { id: "p1", title: "Hello", pinned: true }
kv.list("posts", { where: { pinned: true }, sortBy: "title", limit: 10 });
kv.count("posts"); // 1
kv.remove("posts", "p1");
```

## Full-text search

`SearchStore` indexes documents by id and returns BM25-ranked keyword matches. Use `text` for the
single-field shorthand or `fields` for named columns with query-time weighting:

```ts
import { InMemorySearchStore, toAsyncSearch } from "@mirk/store/search";

const search = new InMemorySearchStore();
search.index("pages", {
  id: "a",
  fields: { title: "Opal guide", body: "plain body" },
});
search.index("pages", {
  id: "b",
  fields: { title: "plain title", body: "Opal guide" },
});
search.search("pages", "opal", { fieldWeights: { title: 4, body: 1 } }); // [a, b]

const asyncSearch = toAsyncSearch(search);
await asyncSearch.search("pages", "opal");
```

The first indexed document fixes a collection's field schema; later documents must use the same
field names. `text` and `fields: { text }` are the same single-field schema for backwards
compatibility. Remote search backends should implement `AsyncSearchStore` directly; local sync
backends can be lifted with `toAsyncSearch`.

## Graph helpers

`@mirk/store/graph` stores edges as ordinary collection records and traverses them through the
existing collection port. Policy stays caller-owned through `StoreFilter`. Remote adapters with a
real graph engine can expose `AsyncGraphTraversal`; `traverse()` and `traverseFrontierBatched()`
delegate to that native path only for collections where `canTraverseGraph(collection)` is true.
Otherwise `traverseFrontierBatched()` uses `listWhereIn` when available, then falls back to the
load-once traversal.

```ts
import { traverse } from "@mirk/store/graph";

const hits = await traverse(asyncKv, "edges", {
  start: "node:a",
  depth: 2,
  direction: "out",
});
```

## SQLite adapter — one connection, many capabilities

`SqliteAdapter` opens a single `better-sqlite3` database and exposes `.kv` (`SyncStore`), `.vector`
(`VectorStore`), and `.search` (`SearchStore`) facets over it:

```ts
import { SqliteAdapter } from "@mirk/store/sqlite";

// .kv and .search work immediately; vector dimensions infer on first write.
const db = new SqliteAdapter({ path: "data.db" });

db.kv.set("user:1", { name: "Ada" });

db.search.index("pages", {
  id: "intro",
  fields: { title: "Intro", body: "hello world" },
});
db.search.search("pages", "hello", { fieldWeights: { title: 4, body: 1 } });

const embedding = new Float32Array(768); // your real embedding here
const query = new Float32Array(768);
db.vector.upsert("docs", { id: "a", vector: embedding });
const results = db.vector.search("docs", query, { topK: 10 }); // ranked by cosine

db.transaction(() => {
  db.kv.set("jobs:next", 42);
  db.kv.put("audit", { id: "42", event: "allocated" });
}, "immediate");

db.close();
```

### `SqliteAdapter` options

| Option          | Type       | Notes                                                                                                                                                          |
| --------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`          | `string`   | DB file path, or `":memory:"`.                                                                                                                                 |
| `db`            | `Database` | Reuse an existing `better-sqlite3` connection instead of opening one.                                                                                          |
| `dimensions`    | `number`   | Optional embedding dimensionality. If omitted, inferred and persisted from the first vector `upsert` / `upsertMany`; `search` still requires known dimensions. |
| `busyTimeoutMs` | `number`   | Bounded wait for another SQLite writer. Defaults to 30 seconds and applies to owned or caller-supplied connections.                                            |

`transaction(work, mode?)` runs synchronous facet operations atomically on the adapter connection.
Modes are `deferred` (default), `immediate`, and `exclusive`. The callback must not perform
asynchronous or external work.

Operational inspection is read-only and does not run a checkpoint:

```ts
const state = db.inspect();
// state.journalMode, state.busyTimeoutMs, state.pageCount, state.walFileSizeBytes
```

The returned shape does not include the database path unless `db.inspect({ debugPaths: true })`
is requested for local diagnostics. WAL maintenance is explicit; callers choose `passive`,
`restart`, or `truncate` and receive `{ busy, logFrames, checkpointedFrames }`:

```ts
const checkpoint = db.checkpoint("passive");
```

The package-owned generic two-process evidence harness is a repository test/tooling module at
`src/sqlite-harness.ts` (it is not a public package export). It uses generated records, independent
OS processes, crash injection, reconciliation, reopen checks, and path-free operation/latency/WAL/
recovery metrics. It does not start or require a writer daemon.

Vectors (`Vector` is a `Float32Array`) are stored as little-endian float32 BLOBs and ranked by
**exact cosine**, accumulated in float64. That is the only search path this adapter has, so
`db.vector.meta.accelerated` is always `false`. A sqlite-vec (vec0) branch used to sit beside it
and never executed once; it was deleted under roadmap MR-22, and `sqlite-vec` is no longer a peer
dependency. Files written by an older version still open and read normally.

## Async coordination

`@mirk/store/coordination` exposes one cooperating-writer critical-section primitive for async
external work that cannot live inside a synchronous SQLite transaction:

```ts
import { createSqliteCoordinator } from "@mirk/store/coordination";

const coordinator = createSqliteCoordinator({
  path: "roadmap/.locks/coordination.sqlite",
  namespace: "roadmap-specs",
});

await coordinator.runExclusive(
  "specs",
  async (guard) => {
    guard.assertOwned();
    // Read files, write Markdown, update revision state, or run git here.
    guard.assertOwned();
  },
  { waitMs: 5_000, leaseMs: 2_000, renewEveryMs: 500 }
);
```

Each successful owner receives a unique `ownerToken`, a monotonic `fencingGeneration`, an
`AbortSignal`, and `assertOwned()`. The coordinator renews the lease while the callback runs.
If the process stalls past expiry and another owner takes over, the stale guard is aborted and
`assertOwned()` throws `CoordinationOwnershipLostError`. Release and renewal only affect the
current owner token and generation, so a stale owner cannot delete or renew a successor lease.

The SQLite database stores lease metadata only. Acquisition, renewal, stale recovery, and release
use short synchronous SQLite statements; no database transaction is held while the callback awaits.
Use this to serialize cooperating writers and make ownership loss observable. It is not a
transaction over Markdown files, arbitrary filesystem writes, object stores, or git commits, and it
cannot roll back partial external side effects after a crash. Consumers must call `assertOwned()`
around each external mutation phase and keep their own revision or idempotency checks where those
semantics matter.

## Sync by design

Embedded backends are **synchronous** — `better-sqlite3` is synchronous, and an async-everywhere
interface would tax every local call with a Promise it doesn't need. A `SyncStore` lifts to an
async API via `toAsync(store)`, and a `SearchStore` lifts via `toAsyncSearch(search)`; the reverse
is impossible. Pick sync for embedded/local, and reach for async only where a remote backend
genuinely requires it.

## License

Apache-2.0. See [LICENSE](LICENSE).
