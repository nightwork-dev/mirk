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
db.vector.ensureSpace("text", { dimensions: 3 });
db.vector.upsert("docs", { id: "a", vectors: { text: new Float32Array([1, 0, 0]) } });
db.vector.search("docs", { space: "text", vector: new Float32Array([1, 0.1, 0]) }, { topK: 5 }); // [{ id: "a", ... }]

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
| `@mirk/store`              | the interfaces, their in-memory references, `toAsync` / `toAsyncSearch` / `toAsyncLog`, `namespaceStore` / `namespaceAsyncStore`, the `AsyncStoreTransactions` contract, graph contract types, cosine helpers | none |
| `@mirk/store/kv`           | the `SyncStore` interface (key-values and collections), `InMemoryKv`, `toAsync`, `sortAndPageStoreItems`                                         | none                        |
| `@mirk/store/atomic`       | optional versioned reads, declarative atomic mutations, idempotent receipts, canonical request digests, and capability checks                    | none                        |
| `@mirk/store/transaction`  | `createMemoryTransactions` and `AsyncTransactionCoordinator`, the shared transaction implementation                                       | `node:async_hooks`          |
| `@mirk/store/vector`       | the `VectorStore` interface, `InMemoryVectorStore`, cosine helpers, `compareCodePoints`                                                          | none                        |
| `@mirk/store/search`       | the `SearchStore` / `AsyncSearchStore` interfaces, `InMemorySearchStore`, `toAsyncSearch`, BM25-style keyword search                             | none                        |
| `@mirk/store/log`          | the `LogStore` / `AsyncLogStore` interfaces, `InMemoryLogStore`, `toAsyncLog`: an append-only log of JSON records in per-stream sequence  | none                        |
| `@mirk/store/graph`        | graph helpers over collections (`neighbors`, `traverse`, `traverseFrontierBatched`) plus `AsyncGraphTraversal` for native graph adapters         | none                        |
| `@mirk/store/sql`          | SQL adapter contract types                                                                                                                       | none                        |
| `@mirk/store/encrypted`    | WebCrypto AES-256-GCM encrypted record envelopes for caller-owned vault keys                                                                     | none                        |
| `@mirk/store/coordination` | portable async lease contracts, guard errors, and clock types | none |
| `@mirk/store/coordination/memory` | explicitly shared in-memory lease state | none |
| `@mirk/store/coordination/sqlite` | durable SQLite leases for cooperating processes | `better-sqlite3` (peer) |
| `@mirk/store/sqlite`       | `SqliteAdapter`, the SQLite source adapter on better-sqlite3: one connection with `.kv`, `.vector`, `.search`, and `.log`                        | `better-sqlite3` (peer)     |
| `@mirk/store/node-sqlite`  | `NodeSqliteAdapter`, the same facets and file schema on Node's built-in `node:sqlite` `DatabaseSync`                                             | Node.js 24+ (`node:sqlite`) |

Source adapters are reached **only** through their own subpath (`/sqlite` or `/node-sqlite`). The
root and the interface subpaths never re-export them, so importing `@mirk/store`, `/kv`,
`/vector`, `/search`, `/log`, or `/graph` never pulls a native binding into a bundle.

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
- A dotted `where` field such as `"a.b"` is one literal top-level key, never a nested path. A JSON
  scalar matches exactly. `where: { v: null }` matches a stored `null`, never a missing field.
- A `where` value made only of `gt`, `gte`, `lt` and `lte` bounds is a range:
  `where: { seenAt: { gte: since } }`. A number bound matches only numbers. A string bound matches
  only strings, compared by Unicode code point. `null` and missing never match a range, and bounds
  of both kinds match nothing. A bound that is not a finite number or a string throws
  `StoreFilterError` with code `invalid-range-bound`; any other object or array value throws code
  `non-scalar-filter`.
- A `NaN` or infinite number in `where` or `listWhereIn` throws `StoreFilterError` with code
  `non-finite-number`. A field name may hold any character, including `"`, `\` and NUL.
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
kv.list("posts", { where: { publishedAt: { gte: "2026-10-01" } } });
kv.count("posts"); // 1
kv.remove("posts", "p1");
kv.keys("user:"); // key-value keys starting with "user:", in code point order
```

### Declared indexes

`kv.ensureIndex(collection, field)` declares that queries filter or sort on `field`. Call it on
every start; it is idempotent and runs one statement. It changes no query's result. The SQLite,
libSQL and PostgreSQL adapters create an index that serves equality, `listWhereIn`, ranges and (on
SQLite and libSQL) `sortBy` on that field. The in-memory reference and IndexedDB accept the call and
do nothing, so portable code can always make it. The capability is typed as `SyncStoreIndexes` and
`AsyncStoreIndexes`, and `toAsync` lifts it.

```ts
for (const field of ["sourceRecordId", "seenAt"]) kv.ensureIndex("sightings", field);
kv.list("sightings", { where: { seenAt: { gte: since } } });
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

## Append-only log

`LogStore` keeps immutable JSON records in named streams. Each entry carries its stream
incarnation's `generation` and its per-stream `sequence`. `append` returns the numeric sequence.

```ts
import { InMemoryLogStore, toAsyncLog, type LogCursor } from "@mirk/store/log";

const log = new InMemoryLogStore();
log.append("deliveries", { id: "d1" }); // 1
log.append("deliveries", { id: "d2" }); // 2
const first = log.list("deliveries", { limit: 1 })[0]!;
// first: { generation: 1, sequence: 1, record: { id: "d1" } }
log.list("deliveries", { after: first, limit: 100 }); // d2
log.lastCursor("deliveries"); // { generation: 1, sequence: 2 }
log.lastSequence("deliveries"); // 2
await toAsyncLog(log).append("deliveries", { id: "d3" }); // 3
```

To replay, omit `after`. To resume, keep the last handled entry's `{ generation, sequence }`
as a `LogCursor`. A bare numeric `after` is refused. `lastCursor(stream)` returns the live tail,
or `null` for an absent stream. `get(stream, sequence)` inspects a position in the current
incarnation; it is not a resume operation.

The memory reference, both SQLite adapters, and Python provide these guarantees:

- Each stream starts at sequence 1 and has no gaps among committed appends. A failed append
  consumes no sequence. Records and sequence allocation commit together.
- The first append to each incarnation allocates a fresh positive safe integer generation from
  one store-wide counter. Committed deletion and recreation never alias an old incarnation.
- A cursor against a deleted, absent, or replaced stream throws `LogInputError` with code
  `stale-cursor`, including with `limit: 0`. Epoch validation and entry reads use one SQLite
  snapshot. Without a cursor, an absent stream returns `[]` and its last sequence is 0.
- Cursor generation must be a positive safe integer; cursor sequence can be zero or a positive
  safe integer. `get` needs a positive safe sequence, and `limit` a non-negative safe integer.
  Invalid cursor shapes throw `invalid-cursor`. Exhausting the global safe integer counter
  refuses new incarnations with `generation-exhausted`; it does not wrap or reuse generations.
- An entry or cursor returned inside an uncommitted transaction is provisional. Rollback can
  reuse both its sequence and generation. Persist a cursor only after commit. Rollback restores
  deleted streams, their entries, and the prior counter, including delete-then-append work.
- Records follow the strict JSON rules of atomic writes. Non-finite numbers, `undefined`, class
  instances, sparse arrays, functions, and cycles throw `invalid-record` without writing.
  Reads return a fresh record copy. Streams are non-empty strings compared exactly.

`deleteStream(stream)` atomically removes every entry and the live registry entry. It returns
whether the stream existed. A later append starts sequence 1 under a new generation. The
singleton counter remains; no per-deleted-stream tombstones accumulate. SQLite can reuse freed
pages, but deletion does not promise immediate file shrinkage.

Applications explicitly delete their record and history together. Record deletion never infers
a stream name or cascades to history. Permanent application deletion must also invalidate the
writer's record version or job generation in that transaction. The log does not provide
consumer acknowledgements, delivery, trimming, wake-up, or permanent writer exclusion.

A transaction that reads before appending must acquire the writer lock before its first read:

```ts
const appended = db.transaction(() => {
  const cursor = db.kv.get<LogCursor>("cursor:mailer") ?? undefined;
  const batch = db.log.list("deliveries", { after: cursor, limit: 100 });
  for (const entry of batch) db.log.append("sent", { delivery: entry.sequence });
  db.kv.set("cursor:mailer", batch.at(-1) ?? cursor);
  return batch.length;
}, "immediate");
```

A deferred transaction that reads before another writer commits cannot upgrade its stale
snapshot to a writer. Its append throws `AtomicMutationBackendError` with `unavailable` and
`retryable: true`. Retry the entire transaction. Outside a caller transaction, append and
deletion use their own immediate transaction. Async transactions always begin immediate.
`InMemoryLogStore.transaction(work)` gives synchronous rollback through the same checkpoints
as shared memory transactions. Promise-returning access uses `toAsyncLog` or `.asyncLog`.

SQLite format 4 eagerly initializes these tables. Migration assigns existing streams generations
in BINARY name order without changing any record or sequence position.

```sql
CREATE TABLE _mirk_log (
  stream TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  record TEXT NOT NULL,
  PRIMARY KEY (stream, sequence)
) WITHOUT ROWID;
CREATE TABLE _mirk_log_streams (
  stream TEXT PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE CHECK (generation >= 1 AND generation <= 9007199254740991)
) WITHOUT ROWID;
CREATE TABLE _mirk_log_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL CHECK (value >= 0 AND value <= 9007199254740991)
);
```

The counter has one row with `id = 1`; a fresh file starts at `value = 0`.
`@mirk/store-postgres`, `@mirk/store-libsql`, and `@mirk/store-indexeddb` do not implement the log.

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
database and exposes `.kv` (`SyncStore`), `.vector` (`VectorStore`), `.search` (`SearchStore`), and
`.log` (`LogStore`) over that one connection. They have the same facets, transaction modes, and schema, and each can
reopen files the other wrote.

```ts
import { SqliteAdapter } from "@mirk/store/sqlite";

// Declare each embedding space before writing vectors.
const db = new SqliteAdapter({ path: "data.db" });

db.kv.set("user:1", { name: "Ada" });
db.search.index("pages", { id: "intro", fields: { title: "Intro", body: "hello world" } });
db.search.search("pages", "hello", { fieldWeights: { title: 4, body: 1 } });

const embedding = new Float32Array(768); // your real embedding here
db.vector.ensureSpace("text", { dimensions: 768 });
db.vector.upsert("docs", { id: "a", vectors: { text: embedding } });
db.vector.search("docs", { space: "text", vector: embedding }, { topK: 10 }); // ranked by cosine

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
| `namespace` | `string` | Vector namespace; defaults to `"default"`. Space definitions and documents are isolated per namespace. KV/search/log keep their own existing names. |
| `vectorEngine` | `SqliteVectorEngine` | Optional native search engine on the same connection. |
| `busyTimeoutMs`   | `number`                        | Bounded wait for another SQLite writer. Defaults to 30 seconds; accepts `0` through `2_147_483_647` ms, and applies to owned and caller-supplied connections. |
| `atomicLimits`    | `Partial<AtomicMutationLimits>` | Override the in-process atomic request limits (see [Request limits](#request-limits)).                                                                        |
| `versionIdentity` | `string`                        | Prefix for atomic version tokens, written once when the file is first set up; a file that already has one keeps it. Defaults to a random UUID.                 |
| `receiptRetentionMs` | `number`                     | How long an idempotency receipt is kept. Off by default: receipts are kept forever. See [Receipt expiry](#receipt-expiry).                                    |
| `now`             | `() => number`                  | The clock, in milliseconds since the epoch, that stamps and expires receipts. Defaults to `Date.now`.                                                         |

Every connection the adapter opens or receives is switched to WAL mode with foreign keys on.

### `listWhereIn`

`kv.listWhereIn(collection, field, values, filter?)` is one statement. Strings and numbers become
`json_extract(data, '$."field"') IN (?, …)`, with a `json_type` check that keeps a stored boolean
from matching `1` or `0`. A boolean or `null` value adds its own term on the same expression. A
string never matches a number. `null` matches a stored `null` and never a missing field. The libSQL
adapter uses the same SQL. One call takes at most `MAX_IN_VALUES` (10,000) values on every backend;
more throw `StoreFilterError` with code `too-many-in-values`. Split a longer list yourself: each
call stays one statement.

### Indexes and query plans

`ensureIndex(collection, field)` runs
`CREATE INDEX IF NOT EXISTS ix_<table>_<hex of field> ON <table> (json_extract(data, '$."field"'))`
on the collection's table. The hex is of the UTF-8 of the path label, which is the field itself
unless the field needs JSON escapes. The Python adapter derives the same name and the same path,
so either language sees and uses the other's index. Every `where` term, `listWhereIn` and `sortBy` write the JSON path into
the SQL text, not as a bound parameter, so the index matches. `jsonPathLiteral` in
`@mirk/store/sql` returns that literal. With the index, `EXPLAIN QUERY PLAN` shows `SEARCH … USING
INDEX` for equality, `listWhereIn` and ranges, and `SCAN … USING INDEX` for `sortBy`. Sorting puts
missing values last with `NULLS LAST`. A range term carries an `unlikely()` hint, because without
`ANALYZE` statistics SQLite would otherwise scan the table in insertion order to skip a sort.

### Transactions

`transaction(work, mode?)` runs synchronous facet operations atomically on the adapter's
connection. Modes are `deferred` (the default), `immediate`, and `exclusive`. The callback must not
do asynchronous or external work. A callback that returns a Promise or other thenable is rejected,
and its synchronous writes are rolled back. This helper is SQLite-only; the portable contract is
[`mutateAtomically`](#atomic-mutations).

### Awaitable access

`asyncKv` is the same store as `.kv`, awaitable, with versioned reads and atomic mutations.
`asyncLog` is the same log as `.log`, awaitable.
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
the process: `asyncKv` and `asyncLog` calls and transactions queue behind an open transaction. While asynchronous
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
Migration can request a pre-upgrade snapshot with `backupPath`; ordinary backup and restore remain connection-level operations.

### Migration policy

Both local adapters accept `migration: "auto" | "explicit" | "refuse"` (default `auto`),
`backupPath?: string`, and `legacyVectorSpace?: string` (default `default`). An ordinary open
with `explicit` rejects an older file with `migration-required`; `refuse` rejects it with
`migration-refused`. New files initialize normally under all policies. Unsupported future and
malformed formats always fail. Read-only connections never migrate.

Use `SqliteAdapter.migrate(options)` or `NodeSqliteAdapter.migrate(options)` to migrate without
opening application facets. The result is `{ fromVersion, toVersion, changed, backupPath? }`;
`fromVersion` is null for unversioned/new files. Explicit invocation accepts policy `explicit`,
but honors `refuse`; change a refusal pin deliberately before migration. Current files return
`changed: false`, and do not create a backup or rename spaces.

`backupPath` applies only to an actual upgrade of a local file. The source holds its SQLite
writer lock while a separate read-only connection runs `VACUUM INTO`, so the snapshot includes
committed WAL data and no competing writer can change the preimage before migration. An existing
destination, unavailable directory, or snapshot failure raises `backup-failed` and prevents the
upgrade. The destination is never overwritten. In-memory sources cannot create a migration
backup (`unsupported-backup`). A snapshot remains available if a later migration step rolls back.

`legacyVectorSpace` selects the old single-vector data's new name inside namespace `default`.
The name must be nonempty. Existing named spaces are unchanged. Conflicting destination definitions
or document identities abort the whole upgrade; migration never merges or discards records.
Format 3 log streams receive generations in SQLite BINARY stream order, preserving sequences and
records. Existing old receipt tables gain their missing `created_at` column before format 4 is
stamped; a format 4 file missing that canonical column is malformed.

### Shared SQLite file format

The shared SQLite format is **4**, recorded as a decimal string in
`_mirk_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)` under `schema_version`. Package versions
are independent. Both Node drivers and Python use these tables and keys:

| Table | Columns and identity |
| --- | --- |
| `_kv` | `key` primary key, JSON text `value`, `created_at`, `updated_at` |
| `_mirk_tables` | `kind`, logical `name`, unique `table_name`; primary key `(kind,name)` |
| Collection tables | `id` primary key, JSON text `data`, `created_at`, `updated_at`; `rowid` preserves insertion order |
| Declared collection indexes | Ordinary SQLite indexes over JSON expressions, named by the shared index naming function |
| `_mirk_search_schema` | `collection` primary key, `fields_json` array; registry-resolved docs/FTS5 tables and triggers store searchable text and nullable metadata |
| `_mirk_vector_spaces` | `namespace`, `name`, positive integer `dimensions`, `metric='cosine'`, `encoding='float32'`; primary key `(namespace,name)` |
| `_mirk_vector_documents` | `namespace`, `collection`, `id`, nullable JSON text `metadata`; primary key `(namespace,collection,id)` |
| `_mirk_vector_values` | `namespace`, `collection`, `id`, `space`, `vec` BLOB; primary key `(namespace,collection,id,space)`; foreign keys reference the document and space; document deletion cascades |
| `_mirk_log` | `stream`, positive `sequence`, JSON text `record`; primary key `(stream,sequence)` |
| `_mirk_log_generation` | Singleton `id=1`, safe nonnegative `value` allocating generations |
| `_mirk_log_streams` | `stream` primary key, unique positive safe integer `generation` |
| `_mirk_atomic_versions` | `kind`, `collection`, `target_key`, `version`; primary key `(kind,collection,target_key)` |
| `_mirk_atomic_identity` / `_mirk_atomic_sequence` | Singleton `id=1`, `value`; identity prefixes opaque tokens and sequence allocates them |
| `_mirk_atomic_receipts` | `idempotency_key` primary key, `request_digest`, JSON text `result_json`, nullable millisecond `created_at` |

Vector namespaces default to `default`; collections share space declarations only inside that
namespace. Each `vec` is exactly `dimensions * 4` bytes in little-endian IEEE float32 order.
Metadata SQL NULL means absent, distinct from JSON `{}`. JSON uses ordinary UTF-8 JSON text with
object/array order preserved; no language-specific object encoding is stored. Optional coordination
tables `_mirk_coordination_generations`, `_mirk_coordination_leases`, and
`_mirk_coordination_meta` use their separately documented versioned lease format and are preserved.

Open validates version metadata before schema changes. Malformed metadata and unsupported future
versions fail. Recognized pre-registry or version-1/2/3 files migrate atomically under `BEGIN
IMMEDIATE`, with a version recheck after writer admission. Legacy `vectors` and `_vec_meta` move to
the `default` namespace and the selected legacy space (default `default`); raw BLOBs and nullable metadata are copied unchanged.
Invalid dimensions or BLOB lengths abort the migration. An empty legacy file with no dimensions
creates no space. Obsolete vector tables are dropped only after successful copying; the version
is written last. Rollback preserves the old format. Application tables, row order, atomic identity,
versions, receipts and log positions remain intact. Concurrent openers converge on one migration.
A read-only connection requiring migration raises `migration-required` and never migrates.

For a portable single-file handoff, use the consistent backup operation, or finish a checkpoint
and close writers before copying. Copying the main file alone during active WAL writes omits data.

### Vectors

A `Vector` is a `Float32Array`. Declare spaces with `ensureSpace(name, { dimensions })`;
`listSpaces()` returns `{ name, dimensions, metric: "cosine", encoding: "float32" }` in Unicode
code-point name order. Names are nonempty and dimensions are positive integers. Definitions are
shared by collections in the vector namespace and cannot change: an identical declaration is
idempotent; another dimension raises `space-definition-conflict`.

Documents contain `{ id, vectors: { [space]: embedding }, metadata? }`. The vector map must be
nonempty and each space must already exist. A document may omit any space. `upsert` replaces the
complete map and metadata, removing omitted embeddings. `upsertMany` validates and commits the
whole batch atomically. `get` returns every embedding; `count` counts documents; `remove` deletes
the document and all its embeddings. Vector and KV records with the same collection/ID remain
separate facets; use the adapter transaction when both must change together.

Search takes `search(collection, { space, vector }, options)`. Unknown spaces raise
`unknown-space`; known spaces with no matching documents return `[]`. Metadata filters run before
ranking, `whereNot` excludes a full conjunction, `minScore` is inclusive, and equal scores use
Unicode code-point ID order. Zero or non-finite stored vectors remain readable but do not match.
The ordinary engine computes exact cosine with float64 accumulation over float32 components.
`meta.engine` reports `javascript`; `meta.accelerated` is false. The optional
`@mirk/store/sqlite-vec` engine performs native computation on the existing connection and reports
its engine name after initialization. An absent companion package or binary, or a companion built
for another platform, selects the same ordinary exact search path on that connection.
`compareCodePoints` is exported for adapters that need the same ordering.

Install the optional `@mirk/sqlite-vec-native` companion to select native search:

```ts
import { NodeSqliteAdapter } from "@mirk/store/node-sqlite";
import { sqliteVecEngine } from "@mirk/store/sqlite-vec";

const db = new NodeSqliteAdapter({ path: "vectors.db", vectorEngine: sqliteVecEngine() });
```

The companion pins sqlite-vec 0.1.6 with an additional ordered float64 scalar. Upstream float32
functions remain available. Native cosine, metadata filtering, ranking, and limiting run on the
adapter's connection; only result IDs, scores, and metadata cross into JavaScript. The same file
opens with the ordinary engine. `SqliteVecError` reports code `native-vector-engine` when loading
or execution fails unexpectedly. Missing native capability reports `meta.engine="javascript"` and
`meta.accelerated=false`; malformed binaries/manifests, version mismatches and executed-query
failures raise instead of silently downgrading. Selection is independent for each connection.
`meta.accelerated` means native computation,
not an approximate-neighbor algorithm or a workload-independent speed guarantee.

The companion requires a C compiler during installation. Its npm tarball and Python source/wheel
paths have been exercised on macOS arm64. Other platform builds have not been exercised in this
change. See the [companion contract](../sqlite-vec-native/README.md).


## Atomic mutations

Sometimes several writes must happen together, and only if the data is still what you read. The
classic case is "create this counter only if it does not exist yet", or "move this record only if
nobody changed it since I looked". `@mirk/store/atomic` adds versioned reads and a bounded,
declarative mutation batch for that, without changing the base `SyncStore` or `AsyncStore`
interfaces.

The in-memory reference, the `.kv` facet of both SQLite adapters, `@mirk/store-indexeddb`,
`@mirk/store-postgres`, and `@mirk/store-libsql` implement it. Check for it with
`supportsAtomicMutation` (or `supportsAsyncAtomicMutation` after `toAsync`). Stores that do not
implement it, including the SurrealDB adapter today, are still valid stores; do not emulate
atomicity with sequential writes.

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
  `idempotency-conflict`. By default receipts never expire; see [Receipt expiry](#receipt-expiry).
  Receipts are durable in SQLite. Ordinary writes are not idempotent.
- **Failures:** `AtomicMutationBackendError` means the failure happened before any possible commit,
  and says whether it is `retryable`. `AtomicMutationIndeterminateError` means the commit may have
  happened; recover with `retry-with-same-key` or `manual-reconciliation`, as it says. Adapters
  never retry an indeterminate mutation for you.

`namespaceStore()` keeps the capability, and binds targets, versions, and receipt keys to the
namespace. One batch cannot span namespaces.

### Your own record types

`JsonValue` has an index signature, so an `interface` is not assignable to it even when every field
is JSON. Build operations with `atomicSet` and `atomicPut` instead of casting. They accept any
type whose parts are all JSON, optional fields included, and refuse at compile time a function, a
method, a `Date`, a `Map`, a symbol, a `bigint`, a required field that may be `undefined`, and a
field typed `unknown`. `jsonValue` does the same for an outcome.

```ts
import { atomicPut, atomicSet, jsonValue, type SyncAtomicStore } from "@mirk/store";

interface Grant { accountId: string; access: ("read" | "write")[]; note?: string }

function grant(store: SyncAtomicStore, key: string, value: Grant) {
  return store.mutateAtomically({
    operations: [atomicSet(key, value)],
    idempotency: { key: `grant:${key}`, outcome: jsonValue(value) },
  });
}
```

`SyncAtomicStore` is `SyncStore & SyncAtomicMutationStore`, and `AsyncAtomicStore` is
`AsyncStore & AsyncAtomicMutationStore`. The request is still checked when it runs: a class
instance with only data fields looks like a plain object to TypeScript, and is refused then.

### Receipt expiry

Every receipt is kept forever by default, so the receipt table only grows. Pass
`receiptRetentionMs` to an atomic store to let receipts expire. Every atomic store takes the same
option and an injectable `now` clock.

- **The boundary.** A receipt is live while its age is at most `receiptRetentionMs`, and expired
  once its age is greater. A replay does not renew a receipt.
- **An expired receipt is absent.** A request whose key matches only an expired receipt is
  evaluated as new: its conditions are checked again, it is applied if they hold, and it gets a
  fresh receipt. A different request under that key is no longer an `idempotency-conflict`. A
  `conflict` never writes a receipt, with or without expiry.
- **Pruning is lazy and bounded.** An atomic write that carries an idempotency key first deletes at
  most `RECEIPT_PRUNE_BATCH` (100) expired receipts in its own transaction. There are no timers, so
  short-lived serverless functions need nothing extra. A host that prefers a schedule calls
  `pruneExpiredReceipts()`, which deletes every expired receipt, one batch per transaction, and
  returns how many it deleted. Pruning never deletes a live receipt. With no window it returns 0.
- **Receipts from an earlier release** carry no creation time. A store with a window stamps them
  with the current time when it first prunes, so they expire one full window later.
- **Whose clock.** Embedded stores use the host's clock. `@mirk/store-postgres` and
  `@mirk/store-libsql` use the database's clock, so hosts with skewed clocks still agree on a
  receipt's age. An injected `now` replaces the clock everywhere for that store; if several hosts
  inject their own clocks, skew between them moves the boundary by the same amount.

**The window must be longer than the longest time a caller may retry or reconcile a request.** A
retry after the window applies the mutation a second time. For example, the Foreclose app
reconciles old receipts after a job lease expires, so a host like it should leave expiry off or use
a window of days, not minutes.

```ts
const store = new InMemoryKv({ receiptRetentionMs: 7 * 24 * 60 * 60 * 1000 });
store.pruneExpiredReceipts(); // 0 until a receipt is older than seven days
```

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

**The idempotency outcome cap is not configurable.** An outcome is kept under its key for as long
as its receipt lives, which is forever by default, so
`MAX_ATOMIC_OUTCOME_BYTES` (64 KiB) is a hard cap in every backend, whatever the limits above.

## Async transactions

`AsyncStoreTransactions` is the adapter-level contract for short, database-only transactions over
an async store. `@mirk/store-postgres`, `@mirk/store-libsql`, and the SQLite adapters' awaitable
access implement it.

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
- If a nested transaction's savepoint cannot be rolled back, the nested call still rejects with
  its work's own error, with the rollback failure attached as `rollbackError`. Its writes may still
  be in the transaction, so the outermost transaction rolls back instead of committing and rejects
  with the rollback failure.

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

## Transactions across memory stores

`createMemoryTransactions({ kv, log })` from `@mirk/store/transaction` binds an existing
`InMemoryKv` and `InMemoryLogStore` to one transaction domain. It implements
`AsyncStoreTransactions`; synchronous calls to those supplied stores participate directly:

```ts
const transactions = createMemoryTransactions({ kv, log });
await transactions.transaction(() => {
  kv.put("jobs", { id: "job-17", state: "queued" });
  log.append("job/job-17", { type: "queued" });
  transactions.afterCommit(() => notify());
});
```

An exception or rejection restores KV values, collections and their ordering, versions, receipts,
and complete log streams. Nested transactions use savepoints; rolled-back scopes discard their
notifications. Committed callbacks run in registration order after the outermost commit and unlock.
Version allocation continues forward on rollback so an exposed rolled-back token is not reused.
A store can belong to only one domain. During an active transaction, foreign synchronous calls
throw; calls through the existing `toAsync` and `toAsyncLog` bridges queue until it ends. Ended
transaction contexts reject further calls. Keep transactions limited to short storage work and
run provider or network calls outside them. Plain memory imports remain free of native bindings
and Node async-context imports; this factory uses the existing Node transaction engine.

Memory lease state joins this same domain only when explicitly supplied:

```ts
const state = createMemoryCoordinationState();
const coordinator = createMemoryCoordinator({ state });
const transactions = createMemoryTransactions({ kv, log, coordination: state });
await transactions.transaction(async () => {
  const result = await coordinator.tryAcquire("job/job-17");
  if (result.status !== "acquired") throw new Error(result.status);
  kv.put("jobs", { id: "job-17", state: "claimed" });
  log.append("job/job-17", { type: "claimed" });
});
```

Enlisted acquisition, renewal, and release roll back with KV and log, including nested savepoints.
Generation allocation always advances: rollback leaves gaps rather than reusing an exposed fencing
identity, even with a repeated injected owner token. A rolled-back acquisition invalidates its
escaped handle. Rolling back renewal restores the previous handle expiry. Ownership-loss aborts
caused by provisional release or failed ownership checks are delivered after commit; the check
still throws immediately. Rollback discards those aborts and preserves a previously valid handle.
The clock and external cancellation are not rolled back. Callers can observe provisional results;
external work started from them cannot be undone by this transaction.

On enlisted state, `tryAcquire` returns `unavailable` immediately when a foreign transaction or
nested sibling scope prevents admission, without inspecting provisional lease state. `runExclusive`
uses its normal clock-driven retry, cancellation, and timeout loop. Renewal and release use the
domain's admission queue; foreign synchronous `assertOwned()` and `expiresAt` access fail during
a transaction. Without explicit enlistment,
shared memory coordination remains independently committed. A state can belong to only one domain.

## Async coordination

A SQLite transaction must finish synchronously, so it cannot cover work that awaits: writing
Markdown files, calling git, or talking to an object store. The coordinator gives
cooperating writers one critical-section primitive for that work:

```ts
import { createSqliteCoordinator } from "@mirk/store/coordination/sqlite";

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

`@mirk/store/coordination/core` provides the native-free contracts, errors, and production
`systemClock`. The memory entry remains native-free. The historical `@mirk/store/coordination`
entry re-exports the actual `SqliteCoordinator` and factory for compatibility and loads the optional
`better-sqlite3` peer; this import is deprecated in favor of `/coordination/sqlite`.

Each owner receives a unique `ownerToken`, a monotonic `fencingGeneration`, a guard `signal`,
and `assertOwned()`. `runExclusive` renews while its callback runs and releases in `finally`.
Ownership loss aborts the signal. Renewal cannot revive an expired lease, and stale renewal or
release cannot affect a successor. Checking ownership before an unconditional application write
does not fence that write: the application must enforce the generation or record version itself.

For manual ownership, `await coordinator.tryAcquire(key, { leaseMs, signal })` makes one atomic
attempt without queuing, lease contention polling, or sleeping. Explicitly enlisted memory state
returns `unavailable` if its transaction domain cannot admit the attempt immediately. Results are `{ status: "acquired", lease }`,
`{ status: "held", expiresAt }`, or `{ status: "unavailable", retryable: true }`. The SQLite
source uses a non-waiting native lock attempt; a busy database is unavailable, never evidence of
a held lease. Other backend errors propagate. A manual lease adds `expiresAt`,
`renew(leaseMs): Promise<boolean>`, and `release(): Promise<boolean>` to the guard. It never starts
automatic renewal. Release is idempotent and succeeds only for the current unexpired lease.

`createMemoryCoordinator({ state: createMemoryCoordinationState() })` from
`@mirk/store/coordination/memory` implements the same contract. Pass the same state to independent
handles to make them contend. Distinct states are isolated. Generation history survives release
for the lifetime of the shared state. For rollback, explicitly enlist the state as described above.

Both sources accept `clock: { now(), sleep(ms, signal?) }`. The default uses epoch milliseconds
and real timers. An injected clock controls acquisition deadlines, retry sleeps, and renewal.
Its sleep must wake on cancellation and remove pending timers/listeners on completion. Frozen
time leaves waits pending. A wake reevaluates the clock; missed renewal cannot extend an expired
lease retroactively. Contenders on the same handle can take over an expired callback. There is
no local queue hiding expired ownership. All handles sharing a file need comparable epoch clocks.

Defaults are `waitMs` 30 s and `leaseMs` 5 s. Positive waits time out before another attempt at
or after their deadline; `waitMs: 0` makes exactly one immediate attempt. Timeout throws
`CoordinationTimeoutError`; cancelled admission throws `CoordinationAbortedError` without
entering caller work. `busyTimeoutMs` controls constructor schema initialization only, separately
from lease time. Call `close()` on SQLite handles when finished.

The durable coordinator opens its own SQLite connection and commits lease metadata independently
of KV/log transactions, even when both connections use the same file. It does not enlist in those
transactions. Its short lease transactions never remain open while callback work awaits.
Coordination cannot roll back files, object-store writes, or other external effects. A live lease
shows cooperative ownership, not operating-system process liveness.

Renewal and release retry transient native lock contention through the injected clock, stopping
at the current lease expiry. These retries never use a native busy wait. A busy operation does
not by itself establish ownership loss.

### Coordination file format

The source can open a standalone file or coexist with store tables. Its independent format is
version 1: `_mirk_coordination_meta` has exactly one `schema_version INTEGER NOT NULL` row.
Unsupported or malformed versions fail before schema or lease mutations. Recognized unversioned
legacy lease tables are adopted atomically under `BEGIN IMMEDIATE`, preserving leases and generation
history. An unrecognized or incomplete layout is rejected. This version is separate from
`_mirk_meta.schema_version`.

`_mirk_coordination_generations(namespace TEXT NOT NULL, key TEXT NOT NULL,
last_generation INTEGER NOT NULL)` has primary key `(namespace, key)` and retains history after
release. `_mirk_coordination_leases` has the same primary key, followed by `owner_token TEXT NOT NULL`,
`fencing_generation INTEGER NOT NULL`, `acquired_at_ms INTEGER NOT NULL`, `expires_at_ms INTEGER NOT NULL`,
and `updated_at_ms INTEGER NOT NULL`. Timestamps are epoch milliseconds. A lease is expired when
`expires_at_ms <= now`. The default namespace is `default`. TypeScript and Python use these same tables.

## Sync by design

Embedded backends are **synchronous**. A local SQLite call finishes in microseconds, and an
async-everywhere interface would wrap every local call in a Promise it does not need. A `SyncStore`
lifts to the async interface with `toAsync(store)`, a `SearchStore` with
`toAsyncSearch(search)`, and a `LogStore` with `toAsyncLog(log)`; the reverse is impossible. Use sync for embedded and local stores, and
async only where a remote backend needs it.

## What this package does not do

- Present async behaviour as synchronous, or emulate a capability an adapter cannot honestly
  provide. Unsupported behaviour fails explicitly.
- Run more than one SQLite write transaction at a time, or hide overload behind unbounded retries.
- Provide a writer daemon, job queue, or message bus. The [append-only log](#append-only-log) stores
  records; it does not deliver them.
- Offer synchronous callback transactions as a portable contract, or atomic batches across
  namespaces.
- Manage encryption keys, encrypt artifacts, or sync devices.

## License

Apache-2.0. See [LICENSE](LICENSE).

Before a format upgrade, quiesce existing clients and reopen them afterward. Existing handles can retain cached schema across a migration. Concurrent openers running the current release are tested; hot cross-version clients are outside this guarantee.

Commit caller-owned transactions before requesting an upgrade backup; a second connection cannot snapshot their uncommitted state. An existing destination vector space or document identity aborts legacy-vector migration rather than merging existing named state.
