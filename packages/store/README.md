# @mirk/store

> **The core of mirk.** Key-values, queryable collections, vectors, full-text search, and links
> between records. Build against in-memory stores with nothing installed, then run the same code
> on one SQLite file.

## Why

An app's data rarely fits one shape. Settings are key-values. Tasks are records you filter and
sort. Notes need keyword search, documents need nearest-neighbour search on embeddings, and some
records point at others. Each of those usually brings its own library, its own connection, and its
own idea of how missing values sort.

`@mirk/store` defines one small interface (a _port_) for each of those jobs, and ships two kinds of
implementation for them:

- **In-memory stores** that need nothing installed. Use them in tests, in the browser, and while
  you design.
- **SQLite source adapters**. A source adapter opens one database connection and gives you every
  capability on it, so one transaction can cover a key-value write, a record, and a search index
  entry.

Both kinds follow the same rules, and a shared set of test scenarios checks that they do. Code that
takes the interface runs on either.

## A first look

On Node 24 or later, the built-in `node:sqlite` adapter needs no extra package:

```ts
import { NodeSqliteAdapter } from "@mirk/store/node-sqlite";

const db = new NodeSqliteAdapter({ path: "app.db" });

// Key-values
db.kv.set("settings", { theme: "dark" });
db.kv.get("settings"); // { theme: "dark" }

// Collections: records keyed by `id`, filtered and sorted
db.kv.put("tasks", { id: "t1", title: "Send invoice", status: "open", due: "2026-11-01" });
db.kv.put("tasks", { id: "t2", title: "Pay deposit", status: "open", due: "2026-10-30" });
db.kv.list("tasks", { where: { status: "open" }, sortBy: "due" }); // t2, then t1

// Full-text search, BM25-ranked
db.search.index("notes", { id: "n1", fields: { title: "Invoice", body: "Send the October invoice" } });
db.search.search("notes", "invoice"); // [{ id: "n1", ... }]

// Vector search, ranked by exact cosine
db.vector.upsert("docs", { id: "a", vector: new Float32Array([1, 0, 0]) });
db.vector.search("docs", new Float32Array([1, 0.1, 0]), { topK: 5 }); // [{ id: "a", ... }]

// One transaction across all of it
db.transaction(() => {
  db.kv.put("tasks", { id: "t3", title: "Book venue", status: "open", due: "2026-11-05" });
  db.search.index("notes", { id: "n2", fields: { title: "Venue", body: "Book the venue" } });
});

db.close();
```

Write your code against the interface, and the same function runs on the in-memory store in tests
and on the SQLite file in the app:

```ts
import { InMemoryKv, toAsync, type SyncStore } from "@mirk/store/kv";

function openTasks(store: SyncStore) {
  return store.list("tasks", { where: { status: "open" }, sortBy: "due" });
}

const memory = new InMemoryKv();
memory.put("tasks", { id: "t1", title: "Send invoice", status: "open", due: "2026-11-01" });
openTasks(memory); // [{ id: "t1", ... }]

// The same store with the Promise-returning interface remote backends use
await toAsync(memory).get("settings"); // null
```

## Install

```bash
npm install @mirk/store
# Only for @mirk/store/sqlite (better-sqlite3 11, 12, or 13):
npm install better-sqlite3
```

ESM only: the package has `import` entry points and no CommonJS build. Supported Node releases are
22.23.4+, 24.22.1+, and 26.12.1+. `@mirk/store/node-sqlite` needs Node 24 or later, because it uses
`node:sqlite`. better-sqlite3 is an optional peer, needed only by `@mirk/store/sqlite` and
`@mirk/store/coordination`.

## What is in the package

Each capability is its own import, so you load only what you use.

| Import                     | What it gives you                                                                                                                                | Native deps                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| `@mirk/store`              | the interfaces, their in-memory references, `toAsync` / `toAsyncSearch`, `namespaceStore` / `namespaceAsyncStore`, the `AsyncStoreTransactions` contract, graph contract types, cosine helpers | none |
| `@mirk/store/kv`           | the `SyncStore` interface (key-values and collections), `InMemoryKv`, `toAsync`, `sortAndPageStoreItems`                                         | none                        |
| `@mirk/store/atomic`       | optional versioned reads, declarative atomic mutations, idempotent receipts, canonical request digests, and capability checks                    | none                        |
| `@mirk/store/transaction`  | `AsyncTransactionCoordinator`, the shared implementation of `AsyncStoreTransactions` for adapter authors                                       | `node:async_hooks`          |
| `@mirk/store/vector`       | the `VectorStore` interface, `InMemoryVectorStore`, cosine helpers, `compareCodePoints`                                                          | none                        |
| `@mirk/store/search`       | the `SearchStore` / `AsyncSearchStore` interfaces, `InMemorySearchStore`, `toAsyncSearch`, BM25-style keyword search                             | none                        |
| `@mirk/store/graph`        | graph helpers over collections (`neighbors`, `traverse`, `traverseFrontierBatched`) plus `AsyncGraphTraversal` for native graph adapters         | none                        |
| `@mirk/store/sql`          | SQL adapter contract types                                                                                                                       | none                        |
| `@mirk/store/encrypted`    | WebCrypto AES-256-GCM encrypted record envelopes for caller-owned vault keys                                                                     | none                        |
| `@mirk/store/coordination` | a SQLite-backed async lock for cooperating writers, with leases, renewal, fencing generations, and ownership-loss checks                         | `better-sqlite3` (peer)     |
| `@mirk/store/sqlite`       | `SqliteAdapter`, the SQLite source adapter on better-sqlite3: one connection with `.kv`, `.vector`, and `.search`                                | `better-sqlite3` (peer)     |
| `@mirk/store/node-sqlite`  | `NodeSqliteAdapter`, the same facets and file schema on Node's built-in `node:sqlite` `DatabaseSync`                                             | Node.js 24+ (`node:sqlite`) |

Source adapters are reached **only** through their own subpath (`/sqlite` or `/node-sqlite`). The
root and the interface subpaths never re-export them, so importing `@mirk/store`, `/kv`,
`/vector`, `/search`, or `/graph` never pulls a native binding into a bundle.

## How stores behave

These rules hold for the in-memory reference and both SQLite adapters. A shared set of conformance
scenarios checks them in both TypeScript and Python. `@mirk/store-indexeddb` replays the store
scenarios in a real browser. The artifact and Markdown targets use their own backend rows in the
same corpus. PostgreSQL, libSQL, and SurrealDB are separate adapters; their package READMEs
describe any behaviour outside these rules.

- `get` returns `null` both for a missing key and for a stored `null`. `has` is the only existence
  test.
- `keys()` returns keys in code point order, not insertion order.
- Unsorted `list()` returns records in insertion order.
- A dotted `where` field such as `"a.b"` is one literal top-level key, never a nested path. Filters
  match JSON scalars only. `where: { v: null }` matches a stored `null`, never a missing field.
- Sorted results put `null` and missing values last, in both ascending and descending order. `0` is
  a value and sorts before `null`. Strings sort by Unicode code point, and equal values keep their
  input order.
- `offset` and `limit` apply after sorting. Fractional values truncate toward zero, a negative
  offset has no effect, and a negative limit returns no rows.

Adapters that filter collection rows in their own backend can call
`sortAndPageStoreItems(items, filter)` from `@mirk/store/kv` to apply the same sort and paging
rules locally.

### Collections

A `SyncStore` is also a small document store. Records are keyed by `id`:

```ts
const kv = new InMemoryKv();
kv.put("posts", { id: "p1", title: "Hello", pinned: true });
kv.getById("posts", "p1"); // { id: "p1", title: "Hello", pinned: true }
kv.list("posts", { where: { pinned: true }, sortBy: "title", limit: 10 });
kv.count("posts"); // 1
kv.remove("posts", "p1");
kv.keys("user:"); // key-value keys starting with "user:", in code point order
```

### Namespaces

`namespaceStore()` binds one logical store onto a shared backing, so callers never build key or
collection prefixes themselves:

```ts
import { namespaceStore } from "@mirk/store";

const projects = namespaceStore(kv, "app.projects.v1");
const workspaces = namespaceStore(kv, "app.workspaces.v1");
```

A namespace is a logical partition, not a path, file, table, or connection. Many namespaces share
one physical store. `namespaceStore()` wraps a `SyncStore` (and so the collection-backed graph
edges in it): keys, collection names, `keys()` prefix scans, and atomic targets, versions, and
idempotency receipts cannot see or reach another namespace. The name must be non-empty and must
not contain U+001F. `namespaceAsyncStore()` is the same binding over an `AsyncStore`, with the same
physical keys and version tokens. Vector and search facets are not wrapped by `namespaceStore()`; partition them
by collection name. Use separate physical databases when the data has different trust, retention,
backup, or lifecycle needs.

## Full-text search

`SearchStore` indexes documents by `id` and returns BM25-ranked keyword matches. Use `text` for one
field, or `fields` for named fields that you can weight at query time:

```ts
import { InMemorySearchStore, toAsyncSearch } from "@mirk/store/search";

const search = new InMemorySearchStore();
search.index("pages", { id: "a", fields: { title: "Opal guide", body: "plain body" } });
search.index("pages", { id: "b", fields: { title: "plain title", body: "Opal guide" } });
search.search("pages", "opal", { fieldWeights: { title: 4, body: 1 } }); // [a, b]

const asyncSearch = toAsyncSearch(search);
await asyncSearch.search("pages", "opal");
```

The first document indexed into a collection fixes its field names; later documents must use the
same ones. `text` and `fields: { text }` are the same single-field schema, kept for backwards
compatibility. Remote search backends implement `AsyncSearchStore` directly; local sync backends
are lifted with `toAsyncSearch`.

## Graph helpers

`@mirk/store/graph` stores links (edges) as ordinary collection records with `id`, `from`, `to`,
and `type`, and walks them through the collection interface. Which edges count is your decision,
expressed as a `StoreFilter`. Remote adapters with a real graph engine can implement
`AsyncGraphTraversal`; `traverse()` and `traverseFrontierBatched()` use that native path only for
collections where `canTraverseGraph(collection)` is true. Otherwise `traverseFrontierBatched()`
uses `listWhereIn` when the store has it, and falls back to loading the edges once.

```ts
import { traverse } from "@mirk/store/graph";

kv.put("edges", { id: "e1", from: "node:a", to: "node:b", type: "knows" });
kv.put("edges", { id: "e2", from: "node:b", to: "node:c", type: "knows" });

const hits = await traverse(toAsync(kv), "edges", {
  start: "node:a",
  depth: 2,
  direction: "out",
});
hits.nodes; // ["node:b", "node:c"]: the nodes reached, not including the start node
```

## The SQLite adapters

`SqliteAdapter` (`@mirk/store/sqlite`, on better-sqlite3) and `NodeSqliteAdapter`
(`@mirk/store/node-sqlite`, on `node:sqlite`) are the same adapter on two drivers. Each opens one
database and exposes `.kv` (`SyncStore`), `.vector` (`VectorStore`), and `.search` (`SearchStore`)
over that one connection. They have the same facets, transaction modes, and schema, and each can
reopen files the other wrote.

```ts
import { SqliteAdapter } from "@mirk/store/sqlite";

// .kv and .search work at once; vector dimensions are inferred on the first write.
const db = new SqliteAdapter({ path: "data.db" });

db.kv.set("user:1", { name: "Ada" });
db.search.index("pages", { id: "intro", fields: { title: "Intro", body: "hello world" } });
db.search.search("pages", "hello", { fieldWeights: { title: 4, body: 1 } });

const embedding = new Float32Array(768); // your real embedding here
db.vector.upsert("docs", { id: "a", vector: embedding });
db.vector.search("docs", embedding, { topK: 10 }); // ranked by cosine

db.transaction(() => {
  db.kv.set("jobs:next", 42);
  db.kv.put("audit", { id: "42", event: "allocated" });
}, "immediate");

db.close();
```

To own connection setup yourself, pass an open connection as `db`: a better-sqlite3 `Database` to
`SqliteAdapter`, or a `node:sqlite` `DatabaseSync` to `NodeSqliteAdapter`.

### Options

Both adapters take the same options; only the type of `db` differs.

| Option            | Type                            | Notes                                                                                                                                                          |
| ----------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`            | `string`                        | Database file path, or `":memory:"`.                                                                                                                           |
| `db`              | `Database` / `DatabaseSync`     | Reuse an existing connection instead of opening one.                                                                                                           |
| `dimensions`      | `number`                        | Optional embedding size. If omitted, it is inferred and stored from the first vector `upsert` / `upsertMany`; `search` still needs known dimensions.           |
| `busyTimeoutMs`   | `number`                        | Bounded wait for another SQLite writer. Defaults to 30 seconds; accepts `0` through `2_147_483_647` ms, and applies to owned and caller-supplied connections. |
| `atomicLimits`    | `Partial<AtomicMutationLimits>` | Override the in-process atomic request limits (see [Request limits](#request-limits)).                                                                        |
| `versionIdentity` | `string`                        | Prefix for atomic version tokens, written once when the file is first set up; a file that already has one keeps it. Defaults to a random UUID.                 |

Every connection the adapter opens or receives is switched to WAL mode with foreign keys on.

### Transactions

`transaction(work, mode?)` runs synchronous facet operations atomically on the adapter's
connection. Modes are `deferred` (the default), `immediate`, and `exclusive`. The callback must not
do asynchronous or external work. A callback that returns a Promise or other thenable is rejected,
and its synchronous writes are rolled back. This helper is SQLite-only; the portable contract is
[`mutateAtomically`](#atomic-mutations).

### Awaitable access

`asyncKv` is the same store as `.kv`, awaitable, with versioned reads and atomic mutations.
`asyncTransaction(work)` and `afterCommit(notify)` implement the portable
[async transaction contract](#async-transactions) over this connection with `BEGIN IMMEDIATE`.

```ts
await sqlite.asyncTransaction(async () => {
  await sqlite.asyncKv.put("jobs", { id: "job-1", state: "leased" });
  await sqlite.asyncKv.set("workspace", nextState);
  sqlite.afterCommit(() => wakeWorkers());
});
```

SQLite has one writer, so awaitable work is serialized per database file across every adapter in
the process: `asyncKv` calls and transactions queue behind an open transaction. While asynchronous
work owns the file, the synchronous facets and `transaction()` throw `SqliteAdapterError` with code
`async-operation-active` unless they are called from inside that transaction, and opening another
adapter on the file throws the same error. Open adapters before starting asynchronous work, and
do not await a second handle on the same file inside a transaction: it waits for the transaction
that is waiting for it. Across processes, use a single writer process, or
[`@mirk/store-postgres`](../store-postgres).

### Several processes, one file

SQLite runs one write transaction at a time. Several processes may open the same file: WAL lets
readers continue while one process writes, the busy timeout turns a collision into a bounded wait,
and a wait that runs out surfaces as `SQLITE_BUSY` (or `AtomicMutationBackendError` from an atomic
batch), never as lost data. Keep write transactions short and free of network or application
callbacks, and bound your own retries. This suits a modest number of cooperating processes. For
sustained concurrent writers, use [`@mirk/store-postgres`](../store-postgres). For critical sections
that must await external IO, use [async coordination](#async-coordination).

### Inspection, checkpoints, and backups

`inspect()` is read-only and does not run a checkpoint:

```ts
const state = db.inspect();
// state.journalMode, state.busyTimeoutMs, state.pageCount, state.walFileSizeBytes
```

The result leaves out the database path unless you ask for it with
`db.inspect({ debugPaths: true })`, for local diagnostics.

WAL maintenance is explicit. Call `checkpoint()` with `passive`, `restart`, or `truncate`; it
returns `{ busy, logFrames, checkpointedFrames }`:

```ts
const checkpoint = db.checkpoint("passive");
```

Mirk adds no checkpoint policy of its own. SQLite's default auto-checkpoint (every 1000 WAL pages,
reported by `inspect()` as `walAutocheckpointPages`) still runs during ordinary writes. Call
`checkpoint()` when you need a specific mode or timing.

To back up a live database, take a consistent SQLite snapshot (better-sqlite3's `db.backup()` or
`VACUUM INTO`), or stop the writers first. Copying the main file without its WAL is not a backup.
The adapter has no backup or restore operation.

### Vectors

A `Vector` is a `Float32Array`. The SQLite adapters store vectors as little-endian float32 BLOBs
and rank them by **exact cosine**, accumulated in float64. That is their only search path, so
`db.vector.meta.accelerated` is always `false`. `sqlite-vec` is no longer a peer dependency; files
written by versions that declared it still open and read normally. `compareCodePoints` from
`@mirk/store/vector` gives other adapters the same deterministic ID ordering as the reference
store.

## Atomic mutations

Sometimes several writes must happen together, and only if the data is still what you read. The
classic case is "create this counter only if it does not exist yet", or "move this record only if
nobody changed it since I looked". `@mirk/store/atomic` adds versioned reads and a bounded,
declarative mutation batch for that, without changing the base `SyncStore` or `AsyncStore`
interfaces.

The in-memory reference, the `.kv` facet of both SQLite adapters, and `@mirk/store-indexeddb`
implement it. Check for it with `supportsAtomicMutation` (or `supportsAsyncAtomicMutation` after
`toAsync`). Stores that do not implement it, including the libSQL, PostgreSQL, and SurrealDB
adapters today, are still valid stores; do not emulate atomicity with sequential writes.

```ts
import { InMemoryKv, supportsAtomicMutation } from "@mirk/store";

const counters = new InMemoryKv();
if (supportsAtomicMutation(counters)) {
  const result = counters.mutateAtomically({
    conditions: [{ target: { kind: "key", key: "counter" }, expected: "missing" }],
    operations: [{ op: "set", key: "counter", value: 1 }],
    idempotency: { key: "initialize-counter", outcome: { accepted: true } },
  });
  result.status; // "applied"; a retry with the same key and request returns "replayed"
}
```

Conditions are checked at one decision point, and an applied batch returns one opaque version per
operation target. The contract:

- **Operations** are `set` / `delete` on keys and `put` / `remove` on collection records. The whole
  batch commits, or none of it does. Search, vector, filesystem, network, and application callbacks
  cannot be part of a batch.
- **Conditions** are `expected: "missing"`, `"present"`, or `"version"` (with a version from
  `getVersioned(target)`). They are sorted canonically (key targets before record targets, then by
  code point), and a `conflict` result reports the first failing one in that order.
- **Versions** are opaque tokens compared for equality only. Every successful write issues a fresh
  version, even when the value is unchanged. Deleting and recreating a target never revives an old
  version, and a version from one namespace is invalid in another. `delete` and `remove` report
  `version: null`. A stale version is a `conflict`, not an instruction to retry.
- **Validation** happens before the decision point. Duplicate targets, repeated conditions, empty
  batches, non-JSON values (`undefined`, non-finite numbers, `bigint`, cycles, class instances), and
  exceeded limits throw `AtomicMutationRejectedError` with a `code`, never a partial write.
- **Idempotency** is optional and per namespace. The store computes `requestDigest` (SHA-256 over
  canonical JSON of the conditions, operations, and outcome). The receipt commits atomically with
  an applied mutation; a `conflict` does not reserve the key. Repeating the key with the same
  request returns `replayed` with the original versions and outcome; a different request returns
  `idempotency-conflict`. Receipts never expire and are durable in SQLite. Ordinary writes are not
  idempotent.
- **Failures:** `AtomicMutationBackendError` means the failure happened before any possible commit,
  and says whether it is `retryable`. `AtomicMutationIndeterminateError` means the commit may have
  happened; recover with `retry-with-same-key` or `manual-reconciliation`, as it says. Adapters
  never retry an indeterminate mutation for you.

`namespaceStore()` keeps the capability, and binds targets, versions, and receipt keys to the
namespace. One batch cannot span namespaces.

### Request limits

Request limits guard the wire contract, so the right values depend on how far a request travels.
Every atomic store publishes the limits it enforces as `store.atomicLimits`, and a wrapper
(`namespaceStore`, `toAsync`) reports the limits of the store underneath it.

| Limit             | `DEFAULT_ATOMIC_LIMITS` | `IN_PROCESS_ATOMIC_LIMITS` |
| ----------------- | ----------------------- | -------------------------- |
| `maxOperations`   | 128                     | 4096                       |
| `maxConditions`   | 128                     | 1024                       |
| `maxRequestBytes` | 1 MiB                   | 16 MiB                     |

`InMemoryKv` and the SQLite adapters' `.kv` run in the calling process and use the in-process set:
the request is never serialized onto a network, and the SQLite batch is one local
`BEGIN IMMEDIATE`. A remote or unknown transport should keep `DEFAULT_ATOMIC_LIMITS`.

Override any field when you construct the adapter:

```ts
const adapter = new SqliteAdapter({
  path: "world.sqlite",
  atomicLimits: { maxOperations: 512 },
});
adapter.kv.atomicLimits.maxOperations; // 512
adapter.kv.atomicLimits.maxConditions; // 1024, the in-process default
```

A rejection names the limit and its value, for example
`request has 11 operations; this store's maxOperations is 10`.

**The idempotency outcome cap is not configurable.** An outcome is kept under its key forever, so
`MAX_ATOMIC_OUTCOME_BYTES` (64 KiB) is a hard cap in every backend, whatever the limits above.

## Async transactions

`AsyncStoreTransactions` is the adapter-level contract for short, database-only transactions over
an async store. `@mirk/store-postgres` and the SQLite adapters' awaitable access implement it.

```ts
interface AsyncStoreTransactions {
  transaction<T>(work: () => T | Promise<T>): Promise<T>;
  afterCommit(notify: () => void): void;
}
```

- Every store call the adapter receives inside `work` joins the transaction. Reads, `getVersioned`,
  and `mutateAtomically` conditions see the transaction's own uncommitted writes.
- A nested `transaction()` joins the outer one as a savepoint. If the nested work throws, only its
  writes roll back, and the outer transaction can still commit. If the outer work throws,
  everything rolls back, nested work included.
- Another adapter instance on the same database is serialized against an open transaction. Its
  compare-and-set waits for the transaction to end and then decides against the committed state,
  so it never succeeds against a version the transaction replaced.
- `afterCommit` callbacks run once each, in registration order, after the outermost commit and
  before `transaction()` resolves. They run outside the transaction, so they can read the store or
  start a new transaction. A rollback discards them, including the callbacks of a nested
  transaction that rolled back. A callback that throws, or returns a rejected promise, does not
  stop the others or fail the commit. Outside a transaction, `afterCommit` runs the callback at
  once.
- **`afterCommit` is best effort.** If the process dies between the commit and the callback, the
  notification is lost. Use it to wake workers early, and keep the durable state that lets them
  find the work without it.

- A version token minted inside work that rolled back is never issued again, so a caller that
  kept it cannot match a later write by accident.

Await every store call inside `work`. A call that outlives its transaction throws
`TransactionScopeError` (`transaction-ended`). Calls made from the parent while a nested
transaction runs, and sibling nested transactions, wait for it to finish, so they never land in a
savepoint that may roll back. Do network and object-storage work before or after a transaction,
never inside it: the transaction holds the database's write lock until it ends.

The contract is checked by a shared test suite that every implementing adapter runs, with two
adapter instances on one database. The JSON conformance corpus does not express it: its rules need
interleaved awaits, callbacks, and a second connection. Adapter authors implement it with
`AsyncTransactionCoordinator` from `@mirk/store/transaction`, which owns nesting, scoping across
awaits, and callback delivery over the adapter's begin, commit, rollback, and savepoint statements.

## Encrypted records

`@mirk/store/encrypted` seals record bytes for vaults that your product owns, so a storage operator,
sync server, or backup holds only ciphertext. You own account membership, device enrollment, key
creation, recovery, and key rotation. Mirk validates the envelope and binds it to the storage
context you expect.

```ts
import { openEncryptedRecord, sealEncryptedRecord } from "@mirk/store/encrypted";

const context = {
  tenantScope: "tenant:example",
  vaultId: "vault:private-profile",
  recordId: "conversation:welcome",
  revisionId: "rev:0001",
};

const vaultKey = crypto.getRandomValues(new Uint8Array(32));
const envelope = await sealEncryptedRecord(
  context,
  new TextEncoder().encode("private conversation bytes"),
  vaultKey,
  "epoch:alpha",
);

const opened = await openEncryptedRecord(context, envelope, vaultKey);
```

Record V1 uses built-in WebCrypto AES-256-GCM (no dependencies, the same code in browsers and Node)
with a fresh random 96-bit nonce per seal. The additional authenticated data is the canonical JSON
UTF-8 header: version, suite, purpose, tenant scope, vault, record, revision, and key ID. The
JSON-safe envelope is that header plus base64url `nonce` and `ciphertext`. The header has fixed
fields, and unknown fields are rejected. Keys are 32 raw bytes. Context fields are limited to
1 KiB, the key ID to 256 bytes, and plaintext to 64 MiB, checked before allocation and after
decryption.

`openEncryptedRecord` takes the context the caller expects, not the one the envelope claims, so an
envelope moved to another tenant, vault, record, or revision fails. Failures throw
`EncryptedRecordError` with a stable `code`: `authentication-failed` (wrong key, changed bytes, or
substituted context), `invalid-context`, `invalid-envelope`, `invalid-key`, or
`unsupported-format`. It never returns unauthenticated plaintext. Use
`validateEncryptedRecordEnvelope(value)` when a server needs the shared envelope parser without
decrypting.

**What this protects:** the payload's confidentiality and integrity, bound to its context, against
anyone who holds stored envelopes but not the key, such as a storage operator, a sync server, or a
backup. **What it does not:** identifiers, sizes, write timing, and access patterns stay visible;
an endpoint that holds the key sees plaintext; and authentication cannot prove freshness. A server
can withhold records or return an older valid envelope, so detect rollback in your own protocol.

The caller owns:

- creating random vault keys and storing them in a device keystore or an encrypted wrapper;
- choosing the `keyId`, keeping old keys while retained revisions still need them, and
  re-encrypting explicitly when rotating;
- choosing a new `revisionId` for every changed plaintext, and sealing each revision once. Retries
  must resend the exact same envelope, which keeps atomic idempotency digests stable;
- serializing and validating the payload schema, and protecting any decrypted local indexes.

Encrypted artifacts, key distribution, and sync are not provided.

## Async coordination

A SQLite transaction must finish synchronously, so it cannot cover work that awaits: writing
Markdown files, calling git, or talking to an object store. `@mirk/store/coordination` gives
cooperating writers one critical-section primitive for that work:

```ts
import { createSqliteCoordinator } from "@mirk/store/coordination";

const coordinator = createSqliteCoordinator({
  path: "var/coordination.sqlite",
  namespace: "specs",
});

await coordinator.runExclusive(
  "specs",
  async (guard) => {
    guard.assertOwned();
    // Read files, write Markdown, update revision state, or run git here.
    guard.assertOwned();
  },
  { waitMs: 5_000, leaseMs: 2_000, renewEveryMs: 500 },
);
```

Each successful owner receives a unique `ownerToken`, a monotonic `fencingGeneration`, an
`AbortSignal`, and `assertOwned()`. The coordinator renews the lease while the callback runs. If
the process stalls past expiry and another owner takes over, the stale guard is aborted and
`assertOwned()` throws `CoordinationOwnershipLostError`. Release and renewal only affect the
current owner token and generation, so a stale owner cannot delete or renew a successor's lease.

The SQLite database stores lease metadata only. Acquisition, renewal, stale recovery, and release
use short synchronous SQLite statements; no database transaction is held while the callback awaits.
Use it to serialize cooperating writers and make ownership loss visible. It is not a transaction
over Markdown files, arbitrary filesystem writes, object stores, or git commits, and it cannot roll
back partial external side effects after a crash. Call `assertOwned()` around each external
mutation phase, and keep your own revision or idempotency checks where those semantics matter.

Defaults are `waitMs` 30 s and `leaseMs` 5 s. A wait that runs out throws
`CoordinationTimeoutError`; an aborted wait throws `CoordinationAbortedError`. Release succeeds
only while the lease is still unexpired. The coordination file is runtime state: keep it outside
authored or versioned content, at a path the host chooses.

## Sync by design

Embedded backends are **synchronous**. A local SQLite call finishes in microseconds, and an
async-everywhere interface would wrap every local call in a Promise it does not need. A `SyncStore`
lifts to the async interface with `toAsync(store)`, and a `SearchStore` with
`toAsyncSearch(search)`; the reverse is impossible. Use sync for embedded and local stores, and
async only where a remote backend needs it.

## What this package does not do

- Present async behaviour as synchronous, or emulate a capability an adapter cannot honestly
  provide. Unsupported behaviour fails explicitly.
- Run more than one SQLite write transaction at a time, or hide overload behind unbounded retries.
- Provide a writer daemon, job queue, message bus, or append-only log interface.
- Offer synchronous callback transactions as a portable contract, or atomic batches across
  namespaces.
- Manage encryption keys, encrypt artifacts, or sync devices.

## License

Apache-2.0. See [LICENSE](LICENSE).
