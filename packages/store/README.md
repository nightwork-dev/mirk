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
| `@mirk/store/encrypted`    | WebCrypto AES-256-GCM encrypted record envelopes for caller-owned vault keys                                                                      | none                                                  |
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

A namespace is a logical partition, not a path, file, table, or connection: many namespaces share
one physical store, and callers never build prefixes themselves. `namespaceStore()` binds a
`SyncStore` (and therefore collection-backed graph edges) so that keys, collection names, `keys()`
prefix scans, and atomic targets, versions, and idempotency receipts cannot see or reach another
namespace. The name must be non-empty and must not contain U+001F. Vector and search facets are not
wrapped by `namespaceStore()`; partition them by collection name. Separate physical databases
remain the right choice for different trust, retention, backup, or lifecycle boundaries.

## Base store contract

The in-memory reference and the SQLite adapter follow these rules, pinned by the shared conformance
corpus in both languages; `@mirk/store-indexeddb` replays the same corpus in a real browser. Other
adapters are not yet run against the corpus; in particular the PostgreSQL adapter orders `keys()` by
the database collation.

- `get` returns `null` both for a missing key and for a stored `null`. `has` is the only existence
  test.
- `keys()` returns code point order, not insertion order.
- Unsorted `list()` returns insertion order.
- A dotted `where` field such as `"a.b"` is one literal top-level key, never a nested path. Filters
  match JSON scalars only; `where { v: null }` matches a stored `null`, never a missing field.
- Sorted results put `null` and missing values last, ascending and descending; `0` is a value and
  sorts before `null`.

## Optional atomic mutation

`@mirk/store/atomic` adds versioned reads and a bounded declarative mutation batch without changing
the base `SyncStore` or `AsyncStore` ports. The in-memory reference, `SqliteAdapter.kv`, and `@mirk/store-indexeddb`
implement the capability; discover it with `supportsAtomicMutation` (or
`supportsAsyncAtomicMutation` after `toAsync`). Stores that do not implement it — including the
libSQL, PostgreSQL, and SurrealDB adapters today — are still valid stores; do not emulate atomicity
with sequential writes. Conditions are checked at one decision point, and an applied batch returns
one opaque version per operation target:

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

The contract:

- **Operations** are `set` / `delete` on keys and `put` / `remove` on collection records. The whole
  batch commits or none of it does. Search, vector, filesystem, network, and application callbacks
  cannot be part of a batch.
- **Conditions** are `expected: "missing"`, `"present"`, or `"version"` (with a version from
  `getVersioned(target)`). They are sorted canonically (key targets before record targets, then by
  code point) and a `conflict` result reports the first failing one in that order.
- **Versions** are opaque tokens compared for equality only. Every successful write issues a fresh
  version, even when the value is unchanged; deleting and recreating a target never revives an old
  version; a version from one namespace is invalid in another. `delete` and `remove` report
  `version: null`. A stale version is a `conflict`, not an instruction to retry.
- **Validation** happens before the decision point. Duplicate targets, repeated conditions, empty
  batches, non-JSON values (`undefined`, non-finite numbers, `bigint`, cycles, class instances), and
  exceeded limits throw `AtomicMutationRejectedError` with a `code`, never a partial write.
- **Idempotency** is optional and per namespace. The store computes `requestDigest` (SHA-256 over
  canonical JSON of the conditions, operations, and outcome). The receipt commits atomically with an
  applied mutation; a `conflict` does not reserve the key. Repeating the key with the same request
  returns `replayed` with the original versions and outcome; a different request returns
  `idempotency-conflict`. Receipts never expire and are durable in SQLite. Ordinary writes are not
  idempotent.
- **Failures:** `AtomicMutationBackendError` means the failure happened before any possible commit
  and says whether it is `retryable`. `AtomicMutationIndeterminateError` means the commit may have
  happened; recover with `retry-with-same-key` or `manual-reconciliation` as it says. Adapters
  never retry an indeterminate mutation for you.

`namespaceStore()` preserves the capability while binding targets, versions, and receipt keys to the
namespace. A single batch cannot span namespaces.

## Encrypted records

`@mirk/store/encrypted` seals opaque record bytes for product-owned vaults. The caller owns account
membership, device enrollment, key creation, recovery, and key rotation; Mirk validates the envelope
and binds it to the expected storage context.

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

Record V1 uses built-in WebCrypto AES-256-GCM (no dependencies, same code in browsers and Node) with
a fresh random 96-bit nonce per seal. The additional authenticated data is the canonical JSON UTF-8
header: version, suite, purpose, tenant scope, vault, record, revision, and key ID. The JSON-safe
envelope is that header plus base64url `nonce` and `ciphertext`; the header has fixed fields and
unknown fields are rejected. Keys are 32 raw bytes. Context fields are limited to 1 KiB, the key ID
to 256 bytes, and plaintext to 64 MiB, checked before allocation and after decryption.

`openEncryptedRecord` takes the context the caller expects, not the one the envelope claims, so an
envelope moved to another tenant, vault, record, or revision fails. Failures throw
`EncryptedRecordError` with a stable `code` — `authentication-failed` (wrong key, changed bytes, or
substituted context), `invalid-context`, `invalid-envelope`, `invalid-key`, or
`unsupported-format` — and never return unauthenticated plaintext. Use
`validateEncryptedRecordEnvelope(value)` when a server needs the shared public envelope parser
without attempting decryption.

What this protects: the payload's confidentiality and integrity, bound to its context, against
anyone who holds stored envelopes but not the key — a storage operator, a sync server, or a backup.
What it does not: identifiers, sizes, write timing, and access patterns stay visible; an endpoint
that holds the key sees plaintext; and authentication cannot prove freshness — a server can
withhold records or return an older valid envelope, so detect rollback in your own protocol.

The caller owns:

- creating random vault keys and storing them in a device keystore or an encrypted wrapper;
- choosing the `keyId`, keeping old keys while retained revisions still need them, and
  re-encrypting explicitly when rotating;
- choosing a new `revisionId` for every changed plaintext, and sealing each revision once — retries
  must resend the exact same envelope, which keeps atomic idempotency digests stable;
- serializing and validating the payload schema, and protecting any decrypted local indexes.

Encrypted artifacts, key distribution, and sync are not provided.

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
| `atomicLimits`  | `Partial<AtomicMutationLimits>` | Override the in-process atomic request bounds (see above).                                                                                    |
| `versionIdentity` | `string` | Prefix for atomic version tokens, written once when the file is initialized; a file that already has one keeps it. Defaults to a random UUID.                |

Every connection the adapter opens or receives is switched to WAL with foreign keys on.

`transaction(work, mode?)` runs synchronous facet operations atomically on the adapter connection.
Modes are `deferred` (default), `immediate`, and `exclusive`. The callback must not perform
asynchronous or external work. This helper is SQLite-local; the portable contract is
`mutateAtomically`.

### Several processes, one file

SQLite runs one write transaction at a time. Several processes may open the same file: WAL lets
readers proceed alongside the writer, the busy timeout turns a collision into a bounded wait, and
a wait that runs out surfaces as `SQLITE_BUSY` (or `AtomicMutationBackendError` from an atomic
batch) rather than lost data. Keep write transactions short and free of network or application
callbacks, and bound your own retries. This suits a modest number of cooperating processes; for
sustained concurrent writers use [`@mirk/store-postgres`](../store-postgres). For critical sections
that must await external IO, use [async coordination](#async-coordination).

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

Mirk adds no checkpoint policy of its own. SQLite's default auto-checkpoint (every 1000 WAL pages,
reported by `inspect()` as `walAutocheckpointPages`) still runs during ordinary writes; call
`checkpoint()` when you need a specific mode or timing.

To back up a live database, use a consistent SQLite snapshot (better-sqlite3's `db.backup()` or
`VACUUM INTO`) or stop writers first. Copying the main file alone, without its WAL, is not a
backup. The adapter does not ship a backup or restore operation.

Vectors (`Vector` is a `Float32Array`) are stored as little-endian float32 BLOBs and ranked by
**exact cosine**, accumulated in float64. That is the only search path this adapter has, so
`db.vector.meta.accelerated` is always `false`. `sqlite-vec` is no longer a peer dependency; files
written by versions that declared it still open and read normally.

## Async coordination

`@mirk/store/coordination` exposes one cooperating-writer critical-section primitive for async
external work that cannot live inside a synchronous SQLite transaction:

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

Defaults are `waitMs` 30 s and `leaseMs` 5 s. A wait that runs out throws
`CoordinationTimeoutError`; an aborted wait throws `CoordinationAbortedError`. Release succeeds
only while the lease is still unexpired. The coordination file is runtime state: keep it outside
authored or versioned content, at a path the host chooses.

## Sync by design

Embedded backends are **synchronous** — `better-sqlite3` is synchronous, and an async-everywhere
interface would tax every local call with a Promise it doesn't need. A `SyncStore` lifts to an
async API via `toAsync(store)`, and a `SearchStore` lifts via `toAsyncSearch(search)`; the reverse
is impossible. Pick sync for embedded/local, and reach for async only where a remote backend
genuinely requires it.

## What this package does not do

- Project async behavior as synchronous, or emulate a capability an adapter cannot honestly
  satisfy — unsupported behavior fails explicitly.
- Run more than one SQLite write transaction at a time, or hide overload behind unbounded retries.
- Provide a writer daemon, job queue, message bus, or append-only log port.
- Offer callback transactions as a portable contract, or atomic batches across namespaces.
- Manage encryption keys, encrypt artifacts, or sync devices.

## License

Apache-2.0. See [LICENSE](LICENSE).
