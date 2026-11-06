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

`mirk.store.log` is the Python side of `@mirk/store/log`: per-stream sequences
that start at 1, with no gaps among committed appends.

```python
from mirk.store import SqliteStore
from mirk.store.sqlite_log import SqliteLogFacet

store = SqliteStore("data.db")
log = SqliteLogFacet(store)  # shares the store's connection and file
log.append("deliveries", {"kind": "submitted", "id": "d1"})  # 1
log.list("deliveries", {"after": 0, "limit": 100})
log.lastSequence("deliveries")  # 1
```

`InMemoryLogStore` is the in-memory reference; its `transaction()` context
manager restores appends and whole-stream deletions inside a block that raises. The block belongs
to the asyncio task (or, outside an event loop, the thread) that opened it:
while it is open, any call from another task or thread raises
`LogTransactionError`, so an `await` inside the block cannot let another task's
appends be rolled back with it.

On SQLite, an append inside a transaction already open on the connection joins
it and rolls back with it, and a rolled-back append's sequence goes to the next
append. A transaction that reads and then appends should start with
`BEGIN IMMEDIATE`, for the reason the TypeScript README gives; an append that
cannot get the write lock raises `AtomicMutationBackendError` with code
`unavailable` and `retryable` true. Sequences, `after` and `limit` accept an
integral float such as `2.0`, as TypeScript does, and return `int`. The
facet reads and writes the same `_mirk_log` table as the TypeScript adapter, so
either language can continue a log the other wrote. The guarantees and limits
are in the [`@mirk/store` README](../../packages/store/README.md#append-only-log).

`deleteStream(stream)` atomically deletes all entries and returns whether the stream existed.
After deletion, `get` returns `None`, `list` returns `[]`, and `lastSequence` returns 0. Recreating
it starts at sequence 1. Deletion rolls back with the caller's transaction, including deletion
followed by append. Applications explicitly coordinate record and history deletion; no inferred
stream-name cascade exists. Use a new stream incarnation in the name when reusing a record ID.

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

`_mirk_meta` holds `schema_version`, currently `2`. Opening a file whose version
is higher than this adapter understands raises rather than reading it by rules
that no longer apply. The TypeScript adapter uses the same registry, the same
candidate sequence, and the same version, so both languages resolve a shared file
to the same tables. When two connections race to register the same new logical
name, the loser's `_mirk_tables` insert raises a constraint violation; both
languages catch it and restart resolution, up to five attempts, so the loser
ends up reading the winner's row as a registry hit instead of surfacing the
error from an ordinary write.

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
- **The vector facet has no accelerated path.** `SqliteAdapter.vector` always
  computes exact float64 cosine similarity; there is no `sqlite-vec`
  extension to install and no `vec` extra. `meta.accelerated` is always
  `false`.
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

`await coordinator.tryAcquire(key, leaseMs=5000, signal=signal)` makes one atomic attempt and
returns a dictionary: `{"status": "acquired", "lease": lease}`, `{"status": "held", "expiresAt": ms}`,
or `{"status": "unavailable", "retryable": True}`. SQLite lock contention is unavailable;
other failures are errors. No sleep, local queue, or native lock wait occurs in this operation.
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
