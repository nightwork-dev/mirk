# Mirk shared-store concurrency specification

**Status:** proposed architecture and conformance contract; direct SQLite characterization implemented

**Primary package:** `@mirk/store`

**Related packages:** `@mirk/store-libsql`; candidate follow-ons include `@mirk/migrate`,
`@mirk/store-postgres`, and `@mirk/surreal`

## Summary

Mirk should support many logical stores sharing one host-selected transactional database without
turning each namespace into a directory, database file, connection, or lifecycle.

Uncoordinated direct SQLite writers are not the default implementation candidate. A downstream
multi-process agent host has repeatedly experienced `database is locked` failures when parallel
harness processes load and write extension state. Its dispatch guidance therefore tells callers to
avoid parallel full-stack launches; one 16-item batch died entirely from the collision. This is an
admitted system constraint, not a hypothetical risk that each consumer must rediscover.

SQLite coordinates access across processes, WAL allows readers and a writer to overlap, and writers
can queue through the database's locking and busy-handler machinery. In this system those mechanisms
have not been reliable enough as the sole coordination boundary. Mirk should expose a reusable
single-writer profile so consumers do not build their own queueing daemon or serialize unrelated agent
work as a storage workaround.

This specification therefore defines storage semantics and a measurement ladder, not a predetermined
daemon:

1. make namespaces logical inside one database;
2. add public transactions, compare-and-set, and idempotency primitives;
3. configure SQLite contention and checkpoint behavior explicitly;
4. prove the coordinated profile with two real client processes and representative application load;
5. retain direct multi-process SQLite only as an explicit opt-in profile for a separately proven,
   bounded workload.

The coordinated profile may reuse local libSQL or use a small Mirk-owned writer service. PostgreSQL
remains the sustained multi-writer path. SurrealDB remains an independently motivated backend.

References:

- [SQLite appropriate uses](https://www.sqlite.org/whentouse.html)
- [SQLite WAL concurrency](https://www.sqlite.org/wal.html)

## Decision

Mirk owns backend-neutral storage contracts, adapter configuration, namespace isolation, migration
integration, and cross-backend conformance tests. Consumers choose physical topology and inject store
handles; they do not recreate CAS, transaction, retry, migration, or namespace behavior.

The first implementation target is the shared namespace, transaction, CAS, idempotency, migration,
and conformance substrate. Two SQLite profiles may implement it:

- **coordinated default:** one owner opens SQLite and other processes use a Mirk-owned async client
  boundary;
- **direct opt-in:** each admitted process opens the database through a correctly configured adapter,
  only after its bounded workload passes and accepts the remaining operational risk.

The coordinated profile is the safe default for multi-process consumers. Direct SQLite remains useful
for one-process embedding, tests, command-line tools with exclusive ownership, and specifically
admitted workloads. Reusable single-writer support is legitimate Mirk scope and must not be
reimplemented by each host.

## Current implementation record

The first integration slice does **not** claim that the coordinated default is complete. It adds
logical namespace views, a bounded SQLite busy timeout, and a narrow synchronous transaction primitive
in Mirk. The initial downstream host integrates those through one composition-root provider owning
one database connection per scope tier, atomic append-log offset allocation, transactionally
excluded legacy copy-forward, and a real 16-process contention regression.

That regression characterizes the direct SQLite profile: 16 independent processes complete 4,000 KV
writes and 4,000 log appends without a lock error or lost record. It is useful evidence, but it is not
a Mirk-owned writer process, does not erase the host's historical failures in other extension-owned
SQLite databases, and does not admit direct SQLite as the general multi-process default.

The public-API proof also exposes the next boundary: the host's current `StoreBackend` mutation
methods are synchronous, while a client of a writer process or local libSQL server is naturally
asynchronous. Finishing the coordinated profile therefore requires either an asynchronous backend
contract or a separately justified synchronous IPC bridge. A longer busy timeout is not that bridge.

## Goals

1. Store many logical namespaces in one host-selected database.
2. Support real concurrent access from independent local processes.
3. Expose atomic multi-operation transactions through public Mirk contracts.
4. Expose compare-and-set for revisioned repositories.
5. Define idempotency without pretending that every ordinary write is automatically retryable.
6. Configure and observe SQLite WAL, busy timeout, checkpoints, transaction duration, and contention.
7. Integrate consolidation migrations with `@mirk/migrate`.
8. Keep adapters substitutable without claiming false behavioral parity.
9. Establish quantitative gates for remaining on SQLite or escalating to another topology.

## Non-goals

- Making SQLite execute more than one write transaction simultaneously.
- Hiding overload or poor transaction design behind unbounded retries.
- A general job queue, message bus, workflow engine, or application event system.
- Absorbing artifact bytes, Git-authored material, fixtures, or application authorization into the
  generic store.
- Selecting SurrealDB solely as a workaround for SQLite contention.
- Requiring every backend to expose identical engine-specific capabilities.

## Known downstream lock evidence

The decision begins with actual failures, not a clean-room model. Parallel harness processes have
previously fought over extension SQLite databases and terminated with `database is locked`. The
recorded procedural workaround was to load only the required extension and avoid concurrent
full-stack startup. That reduces collision probability; it does not repair shared persistence.

The downstream host's sources show mixed SQLite ownership and configuration:

- some extension memory databases open `better-sqlite3` directly without WAL or a busy timeout;
- the shared memory opener enables WAL and `synchronous = NORMAL` but does not configure a busy
  timeout;
- some newer capability stores use Mirk-backed per-namespace `store.db` files;
- extension startup can therefore involve several independently owned databases and connection
  policies before ordinary work begins.

The individual failures did not all originate in the current Mirk `SqliteAdapter`; several extension
stores bypass it. That limits component-level attribution but not the system conclusion: independent
harness processes opening extension-owned SQLite state have proven operationally unreliable. The
coordinated profile exists to remove that class of ownership entirely. Direct use may still be tested
as an optimization, but it does not block delivering the safer profile.

## Current Mirk substrate and gaps

Mirk already has:

- `SqliteAdapter`, which opens a caller-selected path and enables WAL;
- internal SQLite transactions for selected vector and search operations;
- synchronous and asynchronous KV/collection ports;
- a remote-capable libSQL adapter.

PostgreSQL, SurrealDB, and generalized migration packages are active adjacent work, but this
specification does not treat their uncommitted implementations as shipped substrate.

The baseline gaps are:

- no logical namespace dimension on the current KV/collection ports;
- the public transaction primitive is currently SQLite-specific and synchronous rather than the final
  backend-neutral asynchronous contract;
- no public compare-and-set contract;
- no explicit idempotent mutation contract;
- no configurable SQLite busy timeout or checkpoint policy in `SqliteAdapterOptions`;
- no realistic two-process contention and fault suite;
- no measured application workload or admission threshold.

These are adapter and contract gaps. Together with the recorded downstream failures, they require a
reusable coordinated profile for multi-process hosts. An application host may later opt into direct
SQLite only with explicit evidence and an operational reason to accept it.

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

## Backend-neutral transactions

Mirk needs an explicit transaction capability rather than widening every store implementation
silently:

```ts
interface AsyncTransactionalStore extends AsyncStore {
  transaction<T>(work: (tx: AsyncStoreTransaction) => Promise<T>): Promise<T>;
}
```

The exact type remains to be designed. Required semantics are:

- all writes commit or all roll back;
- reads performed through the transaction participate in its isolation level;
- no adapter reports success before commit;
- nested behavior is declared and tested rather than inferred;
- transaction callbacks cannot escape and be reused after settlement;
- remote adapters may implement an explicit transaction session or submit a bounded operation batch;
- implementations identify retryable serialization conflicts separately from permanent failures.

Cross-namespace transactions are required when the namespaces share one physical database and the
host explicitly admits them. They must not cross separate database or service boundaries while
pretending to remain atomic.

## Compare-and-set

Revisioned repositories require one atomic compare-and-update operation:

```ts
interface CompareAndSetOptions<T> {
  expectedRevision: number;
  value: T;
}

const result = await projects.compareAndSet(id, {
  expectedRevision: 7,
  value: { ...next, revision: 8 },
});
```

Required results are `updated`, `missing`, or `conflict` with the observed revision when disclosure is
safe. A conflict is a normal domain-level concurrency result, not a transport failure and not an
automatic retry instruction.

The SQLite implementation must perform comparison and update inside one database transaction. File
locks or process-local mutexes are not substitutes.

## Idempotency

Idempotency is needed for mutation paths that may be retried after an ambiguous disconnect or process
failure. It should be an explicit transactional capability, not an implicit promise attached to every
`set` or `put`:

```ts
await store.idempotent("request-123", async (tx) => {
  // mutation and durable receipt commit together
});
```

Required behavior:

- the mutation and its receipt commit atomically;
- repeating a completed key returns the original outcome;
- retention bounds are declared;
- conflicting reuse of a key with a different operation fails closed;
- ordinary CAS conflicts are not concealed by idempotent replay.

## Direct SQLite profile

`SqliteAdapterOptions` should admit explicit operational configuration:

```ts
interface SqliteConcurrencyOptions {
  busyTimeoutMs: number;
  checkpoint?: {
    mode: "passive" | "restart" | "truncate";
    pages?: number;
  };
  transactionMode?: "deferred" | "immediate";
}
```

The final option names may differ. Required behavior is:

- WAL is enabled and verified on open;
- a nonzero, bounded busy timeout is configured explicitly;
- foreign keys and other connection-level invariants are applied on every connection;
- checkpoint ownership and cadence are documented and observable;
- write transactions remain short and contain no network or application callbacks;
- `SQLITE_BUSY` and related errors are classified and measured;
- retry policy is bounded and limited to operations whose complete semantics are safe to retry;
- connection close and crash recovery are tested across processes.

A busy timeout is not proof of correctness. It converts some immediate conflicts into bounded waiting.
The admission decision depends on observed tail latency, timeout frequency, recovery, and throughput.

## Two-process conformance harness

The first black-box harness targets direct `SqliteAdapter` use. It launches two independent operating
system processes against the same database path; worker threads, two handles in one process, and mocks
are insufficient substitutes.

The harness must prove:

1. two namespaces remain isolated across close and reopen;
2. simultaneous inserts into different namespaces persist without loss;
3. competing CAS operations admit exactly one winner;
4. multi-operation transactions commit and roll back atomically;
5. readers observe only committed state;
6. sustained write bursts produce bounded waits or typed failures, never silent loss;
7. killing either process at defined transaction points leaves an integral database;
8. restart recovers to a known committed-or-not state;
9. WAL growth and checkpoint behavior remain within declared limits;
10. migration exclusion prevents ordinary writes from observing partial imports;
11. backup and restore reproduce namespaces, revisions, receipts, and referenced artifact metadata;
12. clean shutdown closes both connections without leaving an unrecoverable state.

The harness records at minimum:

- operation count and write mix;
- median, p95, p99, and maximum latency;
- busy waits, `SQLITE_BUSY` failures, retry count, and retry delay;
- transaction duration;
- WAL size and checkpoint duration;
- committed, conflicted, rejected, and indeterminate operations.

## Representative workload gate

Synthetic contention is necessary but not sufficient. Admission also requires a captured or
deterministically generated workload matching the intended application processes and repositories.

The fixture should model:

- interactive application mutations;
- tool/service mutations from the second process;
- jobs, inbox, communication, memory, application records, and audit traffic where those stores are
  genuinely in scope;
- realistic transaction sizes and think time;
- startup, migration, checkpoint, backup, and shutdown overlap.

The implementation record must define thresholds before running the final gate. At minimum:

- zero lost or torn writes;
- zero unclassified database-lock failures;
- zero indeterminate committed outcomes without idempotent recovery;
- bounded p99 write latency appropriate to interactive use;
- bounded startup, checkpoint, and shutdown time;
- recovery from every injected crash point.

Threshold values belong to the consuming workload record, not this generic specification. A result
that barely avoids failure while saturating the latency budget is a no-go.

## Migration through `@mirk/migrate`

Once `@mirk/migrate` lands, consolidation builds on it; it does not create a parallel migration
subsystem.

Required additions or composition work include:

- inventorying legacy database paths and mapping each to a destination namespace;
- using its collection, graph, vector, search, and object copy helpers where their contracts apply;
- persisting `MigrationCheckpoint` progress in a restart-safe store rather than only reporting it to
  an in-memory callback;
- adding namespace-aware migration receipts;
- verifying counts, IDs, revisions, vector dimensions, search schemas, and graph edges before marking
  a lane complete;
- leaving source files untouched through the rollback window;
- excluding ordinary writes while a namespace cutover is incomplete;
- resuming idempotently after interruption.

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

## Implementation choices

The coordinated profile is required; its implementation should reuse existing substrate before adding
a bespoke protocol.

### 1. Local or remote libSQL

Test the existing `@mirk/store-libsql` adapter against a currently supported local or managed server.
`file:` mode alone does not change the cross-process topology. The server path must pass the namespace,
transaction, CAS, idempotency, fault, backup, and lifecycle gates.

### 2. Lightweight Mirk coordination service

If libSQL is unsuitable, implement the smallest bespoke `@mirk/store-service` that satisfies the
coordinated profile. It is justified by the recorded downstream failures, but must still prove that
its operational cost is materially lower than adopting a general client/server database.

It requires authenticated client identities and per-client namespace/read/write/admin
grants. One bearer token granting every namespace is not acceptable. Its protocol, lifecycle, queue,
idempotency, readiness, and failure semantics require a separate implementation specification.

### 3. Direct SQLite opt-in

Direct multi-process SQLite is an optimization profile, not the delivery prerequisite. A host may
select it only for a bounded workload that passes the same fault harness and has an explicit reason to
avoid the coordinated boundary. WAL, busy timeout, checkpoint policy, and short transactions remain
required. A passing synthetic test does not erase the historical downstream evidence.

### 4. PostgreSQL

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

## Consumer integration contract

Consumers receive one host-created store composition and inject namespaced handles into repositories.
They do not:

- translate namespaces into paths or files;
- open one database per extension or repository;
- implement their own CAS or transaction emulation;
- add unbounded lock retries;
- run migrations opportunistically during ordinary requests;
- implement their own local writer daemon instead of using the Mirk-owned coordinated profile.

Hosts may choose separate physical databases for legitimate lifecycle, trust, retention, backup, or
measured contention boundaries. A logical package or extension name alone does not justify another
database.

## Delivery sequence

1. Add logical namespaces to the backend-neutral store composition and SQLite physical schema.
2. Define transaction, CAS, idempotency, and typed conflict capabilities.
3. Add explicit WAL verification, busy timeout, checkpoint policy, and contention observability to
   `SqliteAdapter`.
4. Build one two-process contention and fault harness that exercises the coordinated profile and can
   also characterize direct SQLite without making it the delivery gate.
5. Evaluate whether existing local libSQL can supply the coordinated profile without a bespoke
   protocol; specify the Mirk-owned client/lifecycle wrapper if it can.
6. If libSQL is unsuitable, specify the smallest Mirk writer service with client identities and
   namespace-scoped grants.
7. Run the representative application workload against coordinated SQLite with predeclared
   thresholds; optionally run direct SQLite as comparative evidence.
8. Repair bounded coordinated-profile defects and rerun where evidence supports doing so.
9. Admit direct multi-process SQLite only when its bounded workload is comfortably green and the host
   explicitly selects it.
10. Use PostgreSQL when sustained concurrent writing justifies a general client/server database.
11. Evaluate SurrealDB only through an independently approved backend decision.
12. Migrate consumers with `@mirk/migrate` after the selected backend and rollback path pass.

## Acceptance

This specification is satisfied when:

- logical namespaces share one host-selected database without collisions;
- transactions, CAS, idempotency, conflict classification, and lifecycle behavior are public;
- direct SQLite has explicit contention and checkpoint configuration for its remaining single-owner
  and opt-in uses;
- two real client processes pass the coordinated-profile conformance and representative workload
  gates;
- migration reuses and extends `@mirk/migrate` rather than bypassing it;
- no consumer-specific locking or retry implementation is required;
- coordinated SQLite is available as reusable Mirk substrate rather than consumer-owned machinery;
- the coordinated service has its own protocol, authorization, lifecycle, and failure review;
- PostgreSQL remains the supported sustained multi-writer path;
- SurrealDB remains an independent backend decision;
- legacy databases remain recoverable through a declared rollback window.

## Stop conditions

Stop or change direction if:

- a design dismisses the recorded downstream failures because SQLite can theoretically queue writers;
- direct SQLite is made the multi-process default by passing only a synthetic or low-contention test;
- transactions are simulated by sequential independent calls;
- retries can duplicate committed effects;
- namespace consolidation crosses real lifecycle, trust, retention, or backup boundaries merely to
  reduce file count;
- migration duplicates `@mirk/migrate` instead of extending its proven seams;
- a fallback service has broader credentials than its client requires;
- measured contention exceeds the declared budget and the implementation continues to call SQLite
  admitted without escalation.
