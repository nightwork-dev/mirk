# mirk-store

The Python port of `@mirk/store`: substrate-agnostic key-value and collection
storage primitives: the KV, collection, vector, search, append-only log, and
graph ports over two backends, an in-memory reference and SQLite.

The SQLite adapter opens files the TypeScript adapter wrote and writes files it
can read. Same tables, same pragmas, same JSON encoding, and the same atomic
bookkeeping rows on every write.

## Install

```bash
uv add mirk-store
```

The import package is `mirk.store`, inside the shared `mirk` namespace.

Zero runtime dependencies. Every port, the vector one included, needs nothing
beyond the standard library.

## Namespace package

`mirk` is a PEP 420 namespace package. There is no `src/mirk/__init__.py`, so
the `mirk-fixtures` distribution installs `mirk.fixtures` beside `mirk.store`,
like the npm `@mirk/*` scope. Do not add one.

## Use

```python
from mirk.store import InMemoryStore, SqliteStore, namespace_store

store = SqliteStore("data.db")
store.set("greeting", {"hello": "world"})
store.put("things", {"id": "t1", "weight": 2})
store.list("things", {"sortBy": "weight", "sortDir": "desc"})
store.ensureIndex("things", "weight")
store.list("things", {"where": {"weight": {"gte": 2}}})
store.close()
```

`ensureIndex(collection, field)` declares a field that queries filter or sort
on. It is idempotent; call it on every start. On `SqliteStore` it creates the
same expression index as the TypeScript adapter, under the same name, so either
language sees the other's index as present. `InMemoryStore` accepts it and does
nothing. A `where` value made only of `gt`, `gte`, `lt` and `lte` bounds is a
range, with the TypeScript semantics: a number bound matches only numbers, a
string bound only strings by code point, and `None` or a missing field never
matches. A NaN or infinite number in a filter raises `StoreFilterError`
(`non-finite-number`), and `listWhereIn` takes at most `MAX_IN_VALUES`
(10,000) values. An integer above 2^53 in a filter is normalized the way a
stored one is, so it matches the record it was written as.

Method names keep the TypeScript camelCase spelling (`getById`, `listWhereIn`)
so a corpus `op` string dispatches identically in both languages.

## Idempotency receipt expiry

Both stores keep every idempotency receipt forever by default. Pass
`receipt_retention_ms` to let receipts expire, and `now` (milliseconds since
the epoch; wall time by default) to inject a clock:

```python
store = SqliteStore("data.db", receipt_retention_ms=7 * 24 * 60 * 60 * 1000)
store.pruneExpiredReceipts()  # how many expired receipts were deleted
```

The rules match the TypeScript stores and are pinned by the corpus. A receipt
is live while its age is at most the window and expired once its age is
greater; a replay does not renew it. A request whose key matches only an
expired receipt is evaluated and applied as new, and gets a fresh receipt. An
atomic write with an idempotency key first deletes at most
`RECEIPT_PRUNE_BATCH` (100) expired receipts; `pruneExpiredReceipts()` deletes
the rest, one transaction per batch. A receipt without a creation time, written
by an earlier release, is stamped with the current time when a store with a
window first prunes, so it expires one full window later.

**The window must be longer than the longest time a caller may retry or
reconcile a request**: a retry after it applies the mutation again. A host that
reconciles old receipts after an expired job lease should leave expiry off or
use a window of days.

## Append-only log

`mirk.store.log` provides immutable JSON records in named streams. Entries contain a positive
safe integer `generation`, a per-stream `sequence`, and the JSON `record`.

```python
from mirk.store import SqliteStore
from mirk.store.sqlite_log import SqliteLogFacet

store = SqliteStore("data.db")
log = SqliteLogFacet(store)
log.append("deliveries", {"id": "d1"})  # 1
log.append("deliveries", {"id": "d2"})  # 2
first = log.list("deliveries", {"limit": 1})[0]
log.list("deliveries", {"after": first})  # d2 in this incarnation
log.lastCursor("deliveries")  # {"generation": 1, "sequence": 2}
```

A bare numeric `after` is refused. Resume with `{"generation": generation, "sequence": sequence}`.
The sequence can be zero to start within a known generation. A stale cursor raises `LogInputError`
with code `stale-cursor`, including deleted/missing streams and `limit: 0`. Without a cursor,
an absent stream returns `[]`. `lastCursor` returns the live tail or `None`; `lastSequence`
returns zero when absent. `get(stream, sequence)` inspects the current incarnation rather than
resuming a cursor. Cursor fields and limits accept integral floats as TypeScript does.

`deleteStream` atomically removes entries and the live registry entry, returning whether the
stream existed. Recreating the stream starts sequence 1 under a fresh store-wide generation.
SQLite validates the cursor and reads entries in one snapshot. Format 4 eagerly creates
`_mirk_log_streams` and the singleton `_mirk_log_generation` counter alongside `_mirk_log`.
Migration assigns existing streams generations in BINARY name order without changing records
or sequence positions. Deletion retains the counter and no per-deleted-stream tombstone.
SQLite can reuse freed pages; immediate file shrinkage is not promised.

An uncommitted entry or cursor is provisional: rollback can reuse its generation and sequence.
Persist a cursor only after commit. Memory and SQLite rollback restore the prior incarnation,
including delete-then-append work. `InMemoryLogStore.transaction()` shares the memory checkpoint
hooks with cross-facet transactions and rejects calls from a foreign task or thread.

SQLite writes join the caller's transaction or acquire an immediate transaction themselves.
Read-then-append work needs `BEGIN IMMEDIATE`. Lock contention raises retryable
`AtomicMutationBackendError` with code `unavailable`. Applications explicitly coordinate record
and history deletion; no inferred stream-name cascade or permanent writer exclusion exists.
The complete contract and table layouts are in the
[`@mirk/store` README](../../packages/store/README.md#append-only-log).

`create_memory_transactions(kv=kv, log=log)` from `mirk.store.transaction` binds the supplied
`InMemoryStore` and `InMemoryLogStore`. `SqliteTransactions(store)` provides the same contract over
an existing SQLite connection. Use `with transactions.transaction():` or
`async with transactions.transaction():`; call `transactions.after_commit(callback)` inside the
block to register a notification. Nested blocks roll back to savepoints. An exception, including
cancellation, restores all participants and discards that scope's notifications. Memory rollback
restores values, insertion order, versions and receipts; version allocation continues forward.
Callbacks run in registration order after outer commit and unlock; their failures cannot undo
committed data. Foreign task or thread calls fail while a block owns the stores. Async transaction
admission waits for the prior owner. A store belongs to one domain. Keep blocks to short storage
work; run provider and network calls outside them.

## Named vectors

```python
from mirk.store.sqlite_vector import SqliteVectorFacet

vectors = SqliteVectorFacet(store.connection, namespace="default")
vectors.ensureSpace("text", {"dimensions": 2})
vectors.ensureSpace("image", {"dimensions": 3})
vectors.upsert("assets", {
    "id": "a", "vectors": {"text": [1.0, 0.0], "image": [0.0, 1.0, 0.0]},
})
vectors.search("assets", {"space": "image", "vector": [0.0, 1.0, 0.0]})
```

`InMemoryVectorStore()` implements the same port. `ensureSpace` is idempotent for matching
positive integer dimensions and rejects changes with `space-definition-conflict`. `listSpaces`
returns definitions in code-point name order. Collections in one namespace share definitions.
A document has shared metadata and a nonempty `vectors` map; every named space must exist.
`upsert` replaces the entire document, removing omitted vectors and metadata. `upsertMany`
validates and commits the whole batch atomically. `get` returns every vector, `count` counts
documents, and `remove` removes all embeddings. Unknown search spaces raise `unknown-space`;
a known empty space returns `[]`. Search preserves metadata prefiltering, full-conjunction
`whereNot`, inclusive `minScore`, float64 cosine, and code-point ID ties. Stored zero or non-finite
vectors remain readable but do not match. Components round to float32 on write and query.
The ordinary SQLite engine reports `meta.engine="python"` and `accelerated=False`.
Pass `vector_engine=sqlite_vec_engine()` from `mirk.store.sqlite_vec` for optional native
computation on the same connection. An absent companion package or binary selects the existing
ordinary exact path and reports `meta.engine="python"`, `accelerated=False`. Other initialization
failures, including a malformed binary or version mismatch, and executed-query failures raise
visibly. Each connection selects independently. Install the `vec` extra
with `uv add 'mirk-store[vec]'`. The optional `mirk-sqlite-vec-native` package builds pinned
sqlite-vec with ordered float64 scoring; it requires a C compiler for a source installation.
Only final IDs, scores, and metadata cross into Python. The ordinary engine reads the same file.
The native package's Python 3.12.15 and 3.13 wheel paths have been exercised on macOS arm64.


## Threads and transactions

One connection per thread; sync by design. `SqliteStore` is thread-affine, the
way `sqlite3` opens a connection by default and the way the TypeScript adapter's
single-threaded model works. A store used from a second thread raises
`sqlite3.ProgrammingError`. Build a second store for a second thread.

The store owns transaction semantics on whatever connection it is given. Every
write runs inside an explicit `BEGIN IMMEDIATE`, so a connection you supply is
switched to `isolation_level = None` (SQLite autocommit). That commits any
transaction you left pending on it.

```python
connection = sqlite3.connect("data.db")
store = SqliteStore("data.db", connection=connection)  # takes over autocommit
```

## Migration policy

`SqliteStore(path, migration="auto", backup_path=None, legacy_vector_space="default")` retains
automatic upgrades by default. Ordinary opens with `migration="explicit"` raise
`migration-required` for older files; `"refuse"` raises `migration-refused`. New files initialize
under either policy. Future/malformed formats fail and read-only connections never migrate.

`migrate_sqlite(path, migration="explicit", backup_path=None, legacy_vector_space="default")`
from `mirk.store.sqlite` performs only the explicit format operation. It returns
`{"fromVersion": old_or_none, "toVersion": 4, "changed": bool, "backupPath": path_if_created}`.
Explicit operations honor a `"refuse"` policy too. Current files are unchanged, create no backup,
and do not rename existing spaces.

Commit caller-owned transactions before requesting an upgrade backup; a second connection cannot
snapshot their uncommitted state.

For an actual upgrade, `backup_path` creates a consistent SQLite snapshot including committed WAL
records. Writer admission is held from snapshot through migration. The implementation uses a
separate read-only connection and `VACUUM INTO`; an existing destination or backup failure raises
`backup-failed` before migration, without overwriting the destination. Memory databases raise
`unsupported-backup`. A successful snapshot remains if a later migration fails.
`legacy_vector_space` must be nonempty and maps old vectors into that name in namespace `default`.
Destination conflicts abort atomically, without lossy merging. Format 4 assigns old log streams
generations in SQLite BINARY order and repairs the historical missing receipt `created_at` column
before stamping the version. A current-format file missing that column is malformed.

Before a format upgrade, quiesce existing clients and reopen them afterward. Existing handles
can retain cached schema across a migration. Concurrent openers running the current release are
tested; hot cross-version clients are outside this guarantee.

## File layout and schema version

A SQLite file carries a table registry, `_mirk_tables(kind, name, table_name)`,
that maps a logical name to its physical table. `kind` is `collection` or
`search`. The physical name is still derived from the logical one, sanitized and
hashed, but that derived name is only the first candidate: when a different
logical name already holds it, the next candidate appends `_2`, `_3`, and so on,
past every candidate another name holds or an unregistered table already sits on.
Two collections whose names sanitize and hash alike therefore get two tables
instead of silently sharing one, and a stray table is never absorbed by a
suffixed candidate. The FTS index for a search collection is named
after its docs table, so one registry row governs both.

A file written before the registry existed keeps working. The first open records
the table it already has under its logical name, in place, with no rewrite.


### Shared SQLite file format

The normative [SQLite format specification](../../docs/format.md) documents historical layouts,
independent-reader requirements, and immutable golden files.

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

## The contract

The corpus at `conformance/` in the repository root is the contract. Both the
TypeScript suite and this package replay every scenario against every backend
they implement. A behavior that is not in the corpus is not contractual, and a
behavior that differs between backends is a bug in one of them.

## Known differences from TypeScript

These are outcomes a user of both languages can actually hit. Where the
contract picked a side, the TypeScript side listed here is the one that
changed to match; where it says "not pinned," both languages may keep
differing.

- **Mutation after `put`/`get` is undefined.** The Python in-memory store
  copies records on write and on read; the TypeScript in-memory store hands
  out live references. A consumer that mutates an object after `put`, or
  mutates a value returned from `get`/`list`, gets different results by
  language today. Do not rely on it either way.
- **Integers above 2^53** are out of the shared contract: a Python `int`
  beyond that range is stored as its nearest float64, matching how numbers
  round-trip through the TypeScript adapter's JSON. Not pinned in the corpus.
- **`NaN` and infinite floats are rejected**, not converted. Python's encoder
  raises rather than silently writing `null` (which is what TypeScript's
  `JSON.stringify` does with those values).
- **Lone surrogates** (an unpaired UTF-16 code unit) are contractual as
  stored VALUES on both languages, escaped the same way in JSON. They are not
  contractual as identifiers: a key, record id, collection name, or filter
  value containing one is bound as SQLite TEXT. Python's `sqlite3` refuses to
  encode it; TypeScript's better-sqlite3 silently replaces it with U+FFFD.
- **`keys()` ordering, `count` with `limit`/`offset`, negative `limit`,
  `where`/`listWhereIn` on non-scalar values, and boolean vs. `1`
  distinguishing** all had a TypeScript backend disagree with itself
  (memory vs. SQLite) before this port; the corpus now pins one answer for
  both languages and both backends: `keys()` sorts by code point; `count`
  ignores `sortBy`/`limit`/`offset`; a negative `limit` returns nothing;
  `where`/`listWhereIn` on an object or array value that is not a range
  throws `Store filters only support JSON scalar values.`; and `where {v:
  true}` never matches a stored `1`.
- **Sort ties** land in insertion order on both backends; SQLite achieves
  this with `rowid` as the final `ORDER BY` key, which is equivalent to
  insertion order for every observable case.
- **Mixed number/string values in one sort field** are unspecified — not
  pinned in the corpus. JavaScript's coercion and SQLite's type ranking can
  disagree. Do not sort a field holding both types and expect a particular
  order.
- **Search tokenization diverges deliberately and is not fixed.** The SQLite
  FTS5 tokenizer strips diacritics (`café` indexes as `cafe`); the in-memory
  tokenizer keeps them, in both languages. No document mixing the two is in
  the corpus. Don't compare indexed diacritics across backends.
- **Physical table naming can collide only in principle, not in practice.**
  Two collection or search names that sanitize and hash to the same physical
  name still get two distinct tables: the registry described above appends
  `_2`, `_3`, and so on for a name that would otherwise collide.

## Adding a port

The conformance runner resolves a scenario's port to a target by convention.
The names `store`, `kv`, `collection`, and `atomic` mean the backend store
itself. Any other port name `p` is resolved by importing `mirk.store.<p>` and
then `mirk.<p>`, and calling the first module's module-level factory:

```python
def conformance_target(backend: str, connection: object) -> object: ...
```

`backend` is `"memory"`, `"sqlite"`, or `"markdown"`. For the memory and SQLite
backends, `connection` is the open store handle, so a facet shares the
connection the runner already opened. The Markdown target receives no store
connection and creates its temporary filesystem itself.

If the module or factory is missing, the runner records a skip so the test
report names the missing target. `ALLOWED_SKIPPED_PORTS` in
`tests/test_conformance.py` is empty in a complete checkout, so any such skip
fails the test run.

`tests/test_sqlite_compat.py` exports `run_node_script` for cross-language
tests: hand it ESM source and argv, get back the JSON its last stdout line
printed.

## Conformance

The shared corpus covers the memory and SQLite store backends. Cross-language
tests also exchange SQLite files with TypeScript. Contributor setup and test
commands are in [`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Async coordination

`mirk.store.coordination` defines the portable coordinator, guard, manual lease, abort signal,
clock, and errors. `createMemoryCoordinator(state=createMemoryCoordinationState())` from
`mirk.store.coordination_memory` shares cooperative ownership among handles given the same state.
`SqliteCoordinator(path="leases.db")` from `mirk.store.coordination_sqlite` uses durable leases.
Both use the same lease state machine. The SQLite source has `close()`.

Memory state can opt into the existing transaction domain with
`create_memory_transactions(kv=kv, log=log, coordination=state)` from `mirk.store.transaction`.
Acquisition, renewal, and release then roll back with KV and log, including nested scopes.
Generation allocation continues forward through rollback, so repeated owner tokens cannot revive
an escaped provisional handle. Rollback invalidates new handles and restores prior handle expiry.
Ownership-loss signal effects from provisional release or failed assertions wait until commit;
assertions still throw immediately. Rollback discards those effects and preserves previously valid
handles. Immediate acquisition returns `unavailable` when foreign transaction ownership prevents
admission, without reading provisional leases. `runExclusive` retains clock-driven retries,
cancellation, and timeouts. Renewal and release queue behind foreign ownership; synchronous
assertions and expiry reads reject foreign access. A state can join only one domain. Unenlisted state remains
independently committed. Clock advancement, external cancellation, and external side effects are
outside rollback; callers may already have observed provisional results.

The durable coordinator opens its own SQLite connection and commits lease metadata independently
of KV/log transactions, including when the connections share one file. It does not enlist in a
store transaction. This is distinct from the opt-in memory participant above.

`await coordinator.tryAcquire(key, leaseMs=5000, signal=signal)` makes one atomic attempt and
returns a dictionary: `{"status": "acquired", "lease": lease}`, `{"status": "held", "expiresAt": ms}`,
or `{"status": "unavailable", "retryable": True}`. SQLite lock contention is unavailable;
other failures are errors. The lease attempt does not queue, poll, or wait on a native lock.
Explicitly enlisted memory state returns `unavailable` if admission cannot happen immediately.
A lease exposes `key`, `ownerToken`, `fencingGeneration`, `expiresAt`, `signal`, `assertOwned()`,
`await renew(leaseMs)`, and `await release()`. Manual leases do not renew automatically.
Renewal and release succeed only for the current unexpired token and generation; repeat release
returns false. Expiry cannot be revived. Generations increase across release and reacquisition.

`await coordinator.runExclusive(key, work, waitMs=30000, leaseMs=5000, renewEveryMs=...)` manages
renewal and release around an async callback. Ownership loss aborts the guard signal. A positive
wait checks its deadline before another acquisition attempt; zero wait makes one immediate
attempt. Cancellation wakes waits without advancing time and prevents callback admission.
The supplied `CoordinationAbortSignal` supports `abort(reason)`. Async task cancellation also
cleans up managed renewal and release.

Inject `clock` with `now() -> int` and `async sleep(ms, signal=None)` to control every lease,
retry, deadline, and renewal. Sleep must honor cancellation and remove its pending work on exit.
The default uses epoch milliseconds. All handles over one durable state need comparable epoch
clocks. Frozen clocks leave timed waits pending; missed renewals cannot extend expired leases.
`busyTimeoutMs` bounds constructor schema initialization separately; lease operations never wait
for a native SQLite lock. Leases coordinate cooperative work and do not roll back application data.
Application writes require a generation or record-version condition to enforce fencing.

Renewal and release retry transient native lock contention through the injected clock, stopping
at the current lease expiry. These retries never use a native busy wait. A busy operation does
not by itself establish ownership loss.

The standalone coordination format is version 1, independently of `_mirk_meta.schema_version`.
`_mirk_coordination_meta(schema_version INTEGER NOT NULL)` contains exactly one row with value 1.
Unsupported or malformed metadata fails before mutation. Recognized legacy tables without metadata
are adopted atomically under `BEGIN IMMEDIATE`; unrecognized or incomplete layouts are rejected.
`_mirk_coordination_generations(namespace TEXT NOT NULL, key TEXT NOT NULL,
last_generation INTEGER NOT NULL)` retains history after release, with primary key `(namespace,key)`.
`_mirk_coordination_leases` has primary key `(namespace,key)`, both non-null TEXT, followed by
`owner_token TEXT NOT NULL`, `fencing_generation INTEGER NOT NULL`, `acquired_at_ms INTEGER NOT NULL`,
`expires_at_ms INTEGER NOT NULL`, and `updated_at_ms INTEGER NOT NULL`. Times are epoch milliseconds;
expiry is inclusive at `expires_at_ms <= now`. The default namespace is `default`.
These are the same tables used by the TypeScript source; they can coexist with store tables.
