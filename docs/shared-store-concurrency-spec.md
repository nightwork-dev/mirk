# Mirk shared-store concurrency specification

**Status:** MR-15 foundation, MR-16 atomic mutation, and MR-17 inspection/checkpoint/evidence surfaces are
implemented locally; the coordinated writer profile remains deferred

**Primary package:** `@mirk/store`

**Roadmap:** MR-15, MR-16, MR-17

**Related packages:** `@mirk/store-libsql`, `@mirk/migrate`, `@mirk/store-postgres`, and
`@mirk/surreal`

## Summary

Mirk supports many logical stores sharing a host-selected transactional database without turning
each namespace into a directory, database file, connection, or lifecycle. The MR-15 and G3 surfaces
provide the foundation: logical namespaces, bounded SQLite waits, synchronous transaction
modes, and fenced coordination for cooperating writers whose critical sections include external IO.

The remaining concurrency decision is deliberately evidence-led. The local source now includes the
optional backend-neutral atomic mutation capability, read-only SQLite inspection, explicit checkpoint
operations, and a repository-owned two-process fault/contention harness. A coordinated writer
profile or daemon remains deferred until those generic results and any backend evaluation show that
the existing substrate cannot meet a declared bounded workload.

This specification does not choose a writer daemon in advance. A coordinated writer service is a
separate future proposal only if generic evidence shows that direct SQLite and existing backends
cannot meet a declared bounded workload. Direct multi-process SQLite remains an explicit opt-in
profile, not a universal default. Mirk owns the generic contracts and harness; consuming projects
own their workload, deployment, and adoption evidence.

References:

- [SQLite appropriate uses](https://www.sqlite.org/whentouse.html)
- [SQLite WAL concurrency](https://www.sqlite.org/wal.html)

## Decision

Mirk owns backend-neutral storage contracts, adapter configuration, namespace isolation, migration
integration, and cross-backend contract tests. A caller chooses physical topology and injects store
handles; it does not recreate namespace, conditional-mutation, retry, or migration semantics.

MR-16 is an optional declarative atomic mutation capability. It must not widen the base store ports
with transaction callbacks or pretend that sequential writes are atomic. Embedded adapters may keep
local callback helpers, such as `SqliteAdapter.transaction()`, but those helpers are not the portable
contract.

MR-17 begins with inspection, a generic two-process harness, declared workload limits, and evaluation
of existing backends. Only proven need can justify a coordinated writer boundary, and that boundary
requires its own protocol, authorization, lifecycle, and failure specification. PostgreSQL remains
the independently supported sustained multi-writer path; SurrealDB remains an independently
motivated backend.

## Current implementation record — MR-15

MR-15 ships logical `namespaceStore()` views, a bounded SQLite busy timeout, and synchronous
`deferred`, `immediate`, and `exclusive` transaction modes. These are a direct-connection foundation;
they do not claim that direct SQLite is a universal multi-process default or that a coordinated writer
profile is complete.

## Current implementation record — MR-16

The local `@mirk/store` implementation adds `/atomic` plus root and `/kv` capability types and
guards. In-memory and SQLite KV facets implement versioned reads and bounded declarative mutation
batches with canonical request digests, durable idempotency receipts, namespace preservation, and
typed rejection/backend/indeterminate errors. Package tests cover cross-backend semantics, conflict
ordering, replay, limits, reopen, and competing processes. The base `SyncStore` and `AsyncStore`
ports remain unchanged.

This is local implementation and package-test evidence. The manifest version, registry publication,
and consumer/runtime adoption are separate states.

## Current implementation record — MR-17 evidence

The local SQLite adapter exposes read-only `inspect()` and explicit `checkpoint()` operations. The
repository test harness launches independent processes against generated records, injects before- and
after-commit kills, reconciles idempotent outcomes, checks namespace isolation and reopen state, and
records latency, busy, WAL, checkpoint, and recovery metrics against generic thresholds. The harness
is test/tooling code, not a public package export and not a writer daemon.

## Current implementation record — G3 async coordination

The G3 slice adds `@mirk/store/coordination`, a SQLite-backed keyed async coordinator for
cooperating writers whose critical section includes awaited filesystem, Markdown, object-store, or
git work. It is deliberately narrower than the full MR-17 coordinated profile: it does not create a
writer service, does not add backend-neutral async transactions, and does not make direct SQLite a
general multi-writer answer.

The coordinator stores only lease metadata in SQLite:

- namespace plus coordination key;
- owner token;
- monotonic fencing generation;
- acquisition/update timestamps;
- expiry timestamp.

Acquisition and stale takeover use short synchronous SQLite transactions over that metadata. The
caller callback runs after acquisition and outside any SQLite transaction. Renewal and release match
the exact owner token and fencing generation, and release also requires the lease to still be
unexpired. A stalled owner whose lease expires can be overtaken with a higher fencing generation; if
it resumes, its guard's `AbortSignal` and `assertOwned()` make the loss observable before the next
cooperating mutation phase.

This primitive is not a filesystem transaction and not a git transaction. It serializes admitted
cooperating writers and prevents stale owners from renewing or deleting a successor lease. It cannot
roll back a process that crashed after one external side effect and before another. Consumers must
keep revision, idempotency, or recovery records where the application contract needs them.

The coordination database is runtime state and must remain outside authored or staged content. Its
path is selected by the host; Mirk does not prescribe a repository layout.

## Goals

1. Store many logical namespaces in one host-selected database.
2. Add optional atomic mutation with versioned reads, explicit conditions, bounded declarative
   operations, idempotency, and typed completed/indeterminate outcomes.
3. Make SQLite configuration, checkpoints, and contention observable without hidden maintenance work.
4. Prove close/reopen, crash, conflict, and idempotency behavior with independent processes.
5. Integrate consolidation migrations with `@mirk/migrate`.
6. Keep adapters substitutable without claiming false behavioral parity.
7. Establish generic evidence gates before adding coordinated writer infrastructure.

## Non-goals

- Making SQLite execute more than one write transaction simultaneously.
- Hiding overload or poor transaction design behind unbounded retries.
- A general job queue, message bus, workflow engine, or application event system.
- Absorbing artifact bytes, Git-authored material, fixtures, or application authorization into the
  generic store.
- Selecting SurrealDB solely as a workaround for SQLite contention.
- Requiring every backend to expose identical engine-specific capabilities.

## Evidence boundary

Mirk's acceptance evidence is package-owned: real adapters, generic records, independent processes,
fault injection, reopen checks, and deterministic contract suites. Historical reports from consuming
systems can motivate this work, but they are not a consumer matrix, workload registry, or Mirk release
claim. A consumer's latency budget, deployment topology, and adoption status remain outside this
repository.

## Current Mirk substrate and gaps

Mirk already has synchronous and asynchronous store ports, SQLite WAL with logical namespace views,
bounded busy waits, local transaction modes, a remote-capable libSQL adapter, the G3 fenced async
coordination primitive, MR-16 atomic mutation, and MR-17 inspection/checkpoint/harness evidence. The
remaining gap is admission of a coordinated writer profile: the generic evidence must remain
bounded, and any service or daemon requires a separate protocol and authorization decision.

These gaps do not justify a writer daemon by themselves. A coordinated profile is admitted only after
the generic harness and backend evaluation show that the existing substrate cannot meet a declared
bounded workload.

## Namespace model

Namespaces are logical data partitions. They must not automatically become paths, files, connections,
environment variables, or processes.

Every persisted identity includes the namespace before reaching shared physical tables:

```text
(namespace, key)
(namespace, collection, record_id)
(namespace, vector_space, vector_id)
(namespace, search_collection, document_id)
(namespace, migration_id)
```

Namespaces isolate:

- KV keys and collections;
- vector dimensions and indexes;
- search field schemas and indexes;
- graph collections;
- migration versions and receipts;
- transaction and CAS targets.

The public shape may be a bound view:

```ts
const adapter = new SqliteAdapter({ path: databasePath });
const stores = createNamespacedStores(adapter);

const projects = stores.namespace("app.projects.v1").kv;
const workspaces = stores.namespace("app.workspaces.v1").kv;
```

The API is illustrative. The invariant is that consumers never construct database prefixes or table
names themselves.

### Append-only records

Mirk's current public store ports do not expose `log()`. This specification does not assume one.
Append-only records should initially use an ordinary namespaced collection with immutable IDs and
ordering fields. A dedicated log port requires its own demonstrated consumer and conformance contract.

## Backend-neutral atomic mutation

MR-16 is a deliberately optional capability. It is declarative so a remote adapter does not need to
execute an arbitrary caller callback inside a transaction, and it does not widen `SyncStore` or
`AsyncStore`.

The capability combines versioned reads, explicit preconditions, and a bounded JSON-safe mutation
batch. A condition is evaluated at the same atomic decision point as the batch. Version tokens are
opaque, scoped to one bound namespace, and refreshed by every successful write, including an
identical-value write. A stale version is a typed conflict, not an automatic retry instruction.

Supported v1 operations are `set`, `delete`, `put`, and `remove` against key and collection targets.
Repeated targets, empty batches, unsupported values, and exceeded request limits are rejected before
the decision point. Search, vector, graph, filesystem, object-store, network, and application
callbacks are outside the batch.

Completed decisions are `applied`, `replayed`, `conflict`, or `idempotency-conflict`. Invalid input,
unsupported operations, and limits are typed rejections. A known pre-commit backend failure is typed
and retryable only when safe; a failure that may have happened after commit is indeterminate and
requires same-key retry or explicit reconciliation.

Idempotency keys are namespace-scoped. The implementation computes a canonical request digest, and
the mutation plus receipt commit atomically. Repeating the same key and digest returns the original
result; a different digest returns `idempotency-conflict`. V1 receipts do not expire. Any future
compaction needs a namespace-epoch or tombstone protocol that prevents an old key from executing
again. Ordinary writes are not implicitly idempotent, and adapters never retry an indeterminate
mutation behind the caller's back.

An embedded adapter may retain a local callback transaction helper for backend-specific work, but
that helper is not a portable transaction or idempotency contract. Cross-namespace atomic mutation is
out of scope for a namespaced handle and requires a separately specified capability.

## Direct SQLite profile

The local adapter exposes a bounded busy timeout, transaction modes, an operational inspection
surface, and an explicit checkpoint operation rather than a hidden checkpoint policy. The inspection
uses read-only PRAGMA queries and optional filesystem metadata; it must not invoke
`wal_checkpoint` or otherwise change database state. Checkpoint calls are explicit infrastructure
operations with `passive`, `restart`, or `truncate` modes and report busy, log-frame, and
checkpointed-frame counts.

Required behavior for an admitted direct profile is:

- WAL and foreign-key invariants are enabled and verified on every connection;
- busy waits are nonzero, bounded, classified, and measured;
- write transactions remain short and contain no network or application callbacks;
- retry policy is bounded and limited to operations whose complete semantics are safe to retry;
- checkpoint ownership, cadence, and limits are explicit and observable; and
- connection close and crash recovery are tested across independent processes.

A busy timeout is not proof of correctness. It converts some immediate conflicts into bounded
waiting. The admission decision depends on observed tail latency, timeout frequency, recovery, and
throughput from the generic harness.

## Two-process conformance harness

The repository-owned black-box harness uses generated generic records and launches two independent
operating-system processes against the same database path. Worker threads, two handles in one
process, and mocks are insufficient substitutes.

The harness must prove:

1. two namespaces remain isolated across close and reopen;
2. simultaneous inserts into different namespaces persist without loss;
3. competing conditional mutations admit exactly one winner;
4. atomic mutation batches commit completely or not at all;
5. readers observe only committed state;
6. sustained write bursts produce bounded waits or typed failures, never silent loss;
7. killing either process at defined transaction points leaves an integral database;
8. restart recovers to a known committed-or-not state;
9. WAL growth and checkpoint behavior remain within declared limits;
10. migration exclusion prevents ordinary writes from observing partial imports;
11. backup and restore reproduce namespaces, versions, receipts, and generic metadata;
12. clean shutdown closes both connections without leaving an unrecoverable state.

The harness records at minimum:

- operation count and write mix;
- median, p95, p99, and maximum latency;
- busy waits, `SQLITE_BUSY` failures, retry count, and retry delay;
- transaction duration;
- WAL size and checkpoint duration;
- committed, conflicted, rejected, and indeterminate operations.

## Generic workload gate

The harness may add a deterministic workload mix with realistic transaction sizes and think time,
startup, migration, checkpoint, backup, and shutdown overlap. It must use generic records and must not
encode a consuming project's schema, traffic profile, latency budget, or deployment topology.

Thresholds are declared before the final run. At minimum:

- zero lost or torn writes;
- zero unclassified database-lock failures;
- zero indeterminate committed outcomes without idempotent recovery;
- bounded p99 write latency appropriate to interactive use;
- bounded startup, checkpoint, and shutdown time;
- recovery from every injected crash point.

Threshold values belong in the harness run receipt, not a consumer matrix in this specification. A
result that barely avoids failure while saturating the declared generic budget is a no-go.

## Migration through `@mirk/migrate`

The current `@mirk/migrate` package provides plan-bound checkpoint v2, explicit v1 upgrades, and
caller-owned verification. Consolidation builds on it; it does not create a parallel migration
subsystem.

Required caller-owned composition work includes:

- inventorying legacy database paths and mapping each to a destination namespace;
- using its collection, graph, vector, search, and object copy helpers where their contracts apply;
- persisting migration checkpoint progress in a restart-safe store rather than only reporting it to
  an in-memory progress callback;
- adding namespace-aware migration receipts around the package's plan identity;
- verifying counts, IDs, revisions, vector dimensions, search schemas, and graph edges before marking
  a lane complete;
- leaving source files untouched through the rollback window;
- excluding ordinary writes while a namespace cutover is incomplete;
- resuming idempotently after interruption.

The package itself does not enumerate non-KV sources, infer schemas, delete source data, or claim a
cutover is complete from a checkpoint alone.

Migration orchestration may need a higher-level plan API, but copying and checkpoint vocabulary remain
owned by `@mirk/migrate`.

## Backup, restore, and reset

Direct SQLite backup must use a documented consistent snapshot operation while connections are live or
coordinate an exclusive maintenance interval. Copying the main database file without its transactional
context is not accepted.

Backup manifests bind:

- database snapshot identity;
- schema and migration versions;
- namespace inventory;
- artifact snapshot identity and referenced metadata;
- creation time and integrity hashes.

Restore verification detects missing artifacts, unknown namespaces, incompatible schema versions, and
incomplete migration receipts. Reset quarantines recoverable state and never follows consumer-supplied
paths outside the host-selected data root.

## Implementation and deferred admission

The local source implements read-only inspection, explicit checkpoints, and the generic two-process
fault/contention harness. Keep direct SQLite as an explicit bounded-workload option when the generic
evidence is comfortably green. Evaluate the existing `@mirk/store-libsql` adapter against a supported
local or managed server before admitting a coordinated profile. Only if a coordinated boundary is
still required should Mirk write a separate protocol specification for client identity, namespace
grants, lifecycle, queueing, idempotency, readiness, and failure semantics. A writer daemon is not an
implicit MR-17 deliverable.

### PostgreSQL

PostgreSQL is the preferred profile for sustained multi-writer demand. Its MVCC model allows readers
and writers to proceed concurrently while providing row-level conflict and serializable transaction
mechanisms. Candidate `@mirk/store-postgres` work remains outside this tranche and still needs
namespace, transaction, CAS, and conformance parity before satisfying this contract.

Reference: [PostgreSQL concurrency control](https://www.postgresql.org/docs/current/mvcc.html).

## SurrealDB disposition

SurrealDB remains an independently motivated backend, not part of satisfying the baseline shared-store
fix.

A real single-node SurrealDB server can coordinate multiple clients, execute transactions, and detect
write conflicts. Candidate Mirk adapter work covers shared-connection store, graph, vector, and
object-storage surfaces, but remains independent of this tranche. A consumer that wants SurrealDB's
document, graph, vector, permissions, live-query, or deployment model should evaluate that work on its
own merits.

Embedded SurrealDB does not create a shared process boundary. For coordinated multi-process use, a
server endpoint is required, and the exact WebSocket/HTTP transaction capabilities must be proven.
SurrealDB is too consequential a product and operational choice to introduce solely as a workaround
for SQLite contention.

References:

- [SurrealDB architecture](https://surrealdb.com/docs/architecture)
- [SurrealDB transactions](https://surrealdb.com/docs/learn/querying/concepts-and-guides/transactions)
- [SurrealDB single-node deployment](https://surrealdb.com/docs/running/overview)

## Integration boundary

A host receives one composition and injects namespaced handles into its repositories. Mirk's generic
contract does not prescribe the host's physical topology. Callers must not:

- translate namespaces into paths or files;
- open one database per extension or repository;
- implement their own CAS or transaction emulation;
- add unbounded lock retries;
- run migrations opportunistically during ordinary requests;
- simulate conditional mutation, atomicity, or idempotency with sequential independent writes.

Hosts may choose separate physical databases for legitimate lifecycle, trust, retention, backup, or
measured contention boundaries. A logical package or extension name alone does not justify another
database.

## Delivery sequence

1. **MR-15 — implemented locally:** retain logical namespaces, bounded SQLite waits, and synchronous
   transaction modes.
2. **MR-16 — implemented locally:** retain the optional declarative atomic mutation capability,
   including versioned reads, conditions, idempotency, typed conflicts, and indeterminate outcomes.
3. **MR-17 evidence — implemented locally:** retain read-only SQLite inspection, explicit checkpoints,
   generic thresholds, and the two-process fault/contention harness.
4. **MR-17 coordinated profile — deferred:** evaluate direct SQLite and existing backends before
   specifying any writer service or daemon.
5. Use PostgreSQL when sustained concurrent writing justifies a general client/server database.
6. Evaluate SurrealDB only through an independently approved backend decision.
7. Extend caller-owned consolidation plans with `@mirk/migrate` after the selected backend and
   rollback path pass.

## Acceptance

This specification is satisfied when:

- logical namespaces share one host-selected database without collisions;
- optional atomic mutation, versioned reads, idempotency, conflict classification, and lifecycle
  behavior are public and covered by local package tests;
- direct SQLite has explicit contention and checkpoint configuration for its remaining single-owner
  and opt-in uses;
- two real client processes pass the generic conformance and fault gates in repository test tooling;
- migration reuses and extends `@mirk/migrate` rather than bypassing it;
- no consumer-specific locking or retry implementation is required;
- any coordinated service has its own protocol, authorization, lifecycle, and failure review before
  implementation;
- PostgreSQL remains the supported sustained multi-writer path;
- SurrealDB remains an independent backend decision;
- legacy databases remain recoverable through a declared rollback window.

## Stop conditions

Stop or change direction if:

- a design treats a consumer report as package-owned acceptance evidence;
- direct SQLite is made the multi-process default by passing only a synthetic or low-contention test;
- transactions are simulated by sequential independent calls;
- retries can duplicate committed effects;
- namespace consolidation crosses real lifecycle, trust, retention, or backup boundaries merely to
  reduce file count;
- migration duplicates `@mirk/migrate` instead of extending its proven seams;
- a proposed service is introduced before generic evidence and backend evaluation;
- measured contention exceeds the declared budget and the implementation continues to call SQLite
  admitted without escalation.
