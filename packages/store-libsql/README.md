# @mirk/store-libsql

> **Your app's records and vectors in a hosted SQLite database.** Key-values, collections,
> vector search, atomic writes, and transactions over libSQL: Turso, a `sqld` server, or a local
> file.

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
- **No full-text search.** This adapter has no search facet.
- **One writer at a time.** Every write, and every transaction, holds the database's write lock
  until it commits, so writers on all hosts take turns (see [Transactions](#transactions)).
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

// Atomic writes and transactions: a compare-and-set fenced by a version token
const lease = await adapter.kv.getVersioned({ kind: "record", collection: "leases", id: "job-1" });
await adapter.transaction(async () => {
  const claimed = await adapter.kv.mutateAtomically({
    conditions: [{ target: { kind: "record", collection: "leases", id: "job-1" }, expected: "version", version: lease!.version }],
    operations: [{ op: "put", collection: "leases", item: { id: "job-1", owner: "host-a" } }],
  });
  if (claimed.status === "applied") adapter.afterCommit(() => wakeWorker("job-1"));
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
| Atomic writes | yes | `adapter.kv` (`AsyncAtomicMutationStore`): `getVersioned`, `mutateAtomically` |
| Transactions | yes | the adapter implements `AsyncStoreTransactions`: `transaction()` and `afterCommit()` |
| Full-text search | no | use `@mirk/store/sqlite` or another `AsyncSearchStore` backend |
| `listWhereIn` | no | `AsyncStoreInQuery` is not implemented |

One libSQL client serves both facets over one connection. They are separate objects, not one class,
because the key-value and vector ports declare `get`, `remove`, and `count` with different shapes.

### Where it differs from the reference

The in-memory and SQLite stores are the reference. Compared with them:

- All calls return Promises.
- Vector search without filters uses libSQL's native index; with `where` or `whereNot` it scores
  exactly in JavaScript, with the reference semantics (see below).
- There is no search facet and no `listWhereIn`.
- A server uses the portable atomic limits (128 operations per request); a local database uses the
  in-process limits, like `@mirk/store/sqlite`.

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

Transactions use `AsyncLocalStorage` from `node:async_hooks`, so the runtime must provide it, as
Node and edge runtimes with Node compatibility do. Use the package root when local `file:` or
`:memory:` support is required. The SDK remains a
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
| `tablePrefix` | `string?` | prefix for every table the adapter creates, so several stores share one database; letters, digits, and underscores, starting with a letter |
| `atomicLimits` | `Partial<AtomicMutationLimits>?` | override the atomic request bounds |
| `versionIdentity` | `string?` | the prefix of version tokens, recorded when the database is first initialized; a random UUID by default |
| `busyTimeoutMs` | `number?` | how long a write waits for a write lock the database reports busy before failing with `busy`; default 30000 |
| `now` | `() => number?` | the clock, in milliseconds, that stamps idempotency receipts; `Date.now` by default |

The adapter exposes `readonly kv: AsyncStore & AsyncAtomicMutationStore`,
`readonly vector: AsyncVectorStore`, `transaction(work)`, `afterCommit(notify)`, and
`close(): void`. Key-values work without `dimensions`.

Without a `tablePrefix`, a local file uses the same tables as `@mirk/store/sqlite`, including its
version and receipt tables, so the two adapters read each other's data and tokens.

### Atomic writes and versions

`adapter.kv` implements `AsyncAtomicMutationStore` with the reference semantics. Version tokens read
`<identity>-v<n>`, where `identity` is the `versionIdentity` recorded when the database is first
initialized and `n` comes from one sequence per database. Every `set` and `put`, plain or atomic,
takes the next number; `delete`, `remove`, and a conflict take none. A rolled-back write keeps its
number: the rollback returns to a savepoint at the start of the transaction and commits only the
sequence, so no later write reissues a token a caller already saw. If the connection fails before
that sequence commits, the work is still not applied, and the adapter's next transaction moves the
sequence past those numbers before it issues any. Another host that writes in between can reissue
one of them, so discard tokens from a transaction that failed. Treat tokens as opaque.

Idempotency receipts are durable rows, stamped with their creation time from the `now` clock. They
survive other writes to the same target and adapter restarts, so a retried request with the same
key replays the first result.

A standalone `mutateAtomically` reports a failure of the database as an `@mirk/store/atomic` error:

- `AtomicMutationBackendError` (`unavailable`, retryable) when nothing was written: the write lock
  stayed busy, the connection failed before the commit, or the server ended the transaction.
- `AtomicMutationIndeterminateError` when the connection failed while the commit was in flight.
  Retrying with the same idempotency key is safe.

### Transactions

`adapter.transaction(work)` runs `work` in one write transaction. It implements the
[`AsyncStoreTransactions`](../store/README.md#async-transactions) contract: `kv` and `vector`
calls inside `work` join it, a nested call is a savepoint, and `afterCommit` callbacks run once,
in order, after the outermost commit. **`afterCommit` is best effort:** if the process dies between
the commit and the callback, the notification is lost. Recover from durable state.

**How writers are serialized.** Every transaction, and every write outside one, starts with
`BEGIN IMMEDIATE`, which takes the database's single write lock. On a remote server each
transaction runs on its own stream (an interactive transaction over HTTP or WebSocket), and the
server holds a second writer's `BEGIN IMMEDIATE` until the first commits or rolls back, so writers
on all hosts take turns. Reads outside a transaction do not wait; they see committed data. On a
local file, adapters in one process take turns before they begin; when another process holds the
file's lock, the adapter retries until `busyTimeoutMs`.

**What it costs.** One writer per database at a time, for every host. A remote write is several
round trips (begin, statements, commit), and every other writer waits for all of them. That suits
low write volume, such as a few users and scheduled jobs. Stores that share a database through
`tablePrefix` also share its write lock; put independent high-volume data in separate databases.

**Keep transactions short and database-only.** Do network or other slow work before or after. Do
not await another adapter's writes to the same database inside a transaction; they wait for the
lock it holds. A server bounds how long a frozen or killed host can hold the lock. In our tests,
`sqld` 0.24 ended a transaction that held the lock for about 5 seconds while another writer waited,
and Turso ended an interactive transaction that sat idle for about 10 seconds. That transaction
then fails with `transaction-expired`, and its writes are rolled back.

**Failures are typed.** A transaction that the database fails under rolls back and rejects with a
`LibsqlAdapterError`. The adapter releases its connection or stream, so no lock stays held:

| `code` | Meaning |
| --- | --- |
| `busy` | The write lock was not acquired within `busyTimeoutMs`. Nothing was written. |
| `transaction-expired` | The server ended the transaction. Its writes were rolled back. |
| `connection-lost` | The connection failed before the commit was sent. Nothing was committed. |
| `commit-indeterminate` | The connection failed while the commit was in flight. Read durable state to learn the outcome. |

A store call that outlives its transaction's `work` fails with `TransactionScopeError`
(`transaction-ended`), even while the commit is still in flight.

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

The transaction contract, the store conformance corpus, lease-fencing tests, and failure tests run
against a local file by default. Two settings add real servers:

- `MIRK_LIBSQL_SERVER=/path/to/sqld` starts an isolated loopback `sqld` with temporary data for
  each test file, and stops it afterward. The failure tests kill it mid-transaction.
- `MIRK_LIBSQL_TURSO_URL` and `MIRK_LIBSQL_TURSO_TOKEN` name a disposable hosted database. Every
  table the tests create carries a per-run `tablePrefix`, and the tests drop those tables.

```bash
MIRK_LIBSQL_SERVER=/path/to/sqld pnpm --filter @mirk/store-libsql test
```

To check the packed remote export, build the workspace, then run against a libSQL server
executable:

```bash
MIRK_LIBSQL_SERVER=/path/to/sqld pnpm --filter @mirk/store-libsql test:remote
```

The check starts an isolated loopback server with temporary data and removes it afterward. It
exercises the published remote export over HTTP, WebSocket, and `libsql://` URLs while native
imports are denied. It also checks generated consumer declarations and keeps a negative control for
the native-capable root import.

## License

Apache-2.0
