# @mirk/store-postgres

> **Mirk's records in PostgreSQL, shared by every process that needs them.** Key-values,
> collections, atomic writes, and transactions, with many hosts at once.

## Why

A SQLite file admits one writer at a time. That is fine for one app on one machine. It becomes a
bottleneck when several servers, workers, or processes all write the same data, and a file on one
disk cannot be shared across hosts at all.

PostgreSQL is built for that. Its MVCC lets readers and writers proceed together. This adapter
puts Mirk's key-value and collection interfaces on top of it, so code written against `@mirk/store`
runs unchanged against a shared database.

What you give up compared with the SQLite file in `@mirk/store`:

- **Every call is async.**
- **Only key-values and collections.** No vectors, no full-text search, no links.
- **Writes to one schema are serialized.** Every write holds a schema-wide lock until it commits.
- **You run a Postgres server**, and the role needs permission to create the adapter's tables.

## A first look

```ts
import { PostgresAdapter } from "@mirk/store-postgres";

const postgres = await PostgresAdapter.open({
  connectionString: process.env.DATABASE_URL,
});

await postgres.kv.set("settings", { theme: "dark" });
await postgres.kv.put("projects", { id: "mirk", status: "active" });
await postgres.kv.put("projects", { id: "gonk", status: "paused" });

const active = await postgres.kv.list("projects", { where: { status: "active" } });
const both = await postgres.kv.listWhereIn("projects", "id", ["mirk", "gonk"]);

await postgres.close();
```

Two hosts can claim a job without both winning, and notify only when the claim commits:

```ts
await postgres.transaction(async () => {
  const job = await postgres.kv.getVersioned({ kind: "record", collection: "jobs", id: "job-1" });
  const claimed = await postgres.kv.mutateAtomically({
    conditions: [{ target: { kind: "record", collection: "jobs", id: "job-1" }, expected: "version", version: job!.version }],
    operations: [{ op: "put", collection: "jobs", item: { id: "job-1", holder: "host-a" } }],
  });
  if (claimed.status === "applied") postgres.afterCommit(() => wakeWorker("job-1"));
});
```

## Install

```bash
npm install @mirk/store-postgres
```

`pg` and `@mirk/store` are regular dependencies.

## What it covers

| Capability | Covered | Notes |
| --- | --- | --- |
| Key-values | yes | `postgres.kv` implements `AsyncStore` |
| Collections | yes | same facet, plus the optional `AsyncStoreInQuery` capability (`listWhereIn`) |
| Vectors | no | pgvector is not used |
| Full-text search | no | PostgreSQL full-text search is not used |
| Atomic writes | yes | `AsyncAtomicMutationStore`: versioned reads and declarative atomic mutations with idempotent receipts |
| Transactions | yes | the adapter implements `AsyncStoreTransactions`: `transaction()` and `afterCommit()` |

### Where it differs from the reference

The in-memory and SQLite stores are the reference. This adapter follows them for filtering,
ordering, and counting (see [Contract semantics](#contract-semantics)). The differences:

- Calls are async.
- Values and records round-trip through `jsonb`, so they must be JSON-serializable.
- `keys(prefix)` and sorted strings order under the database's collation.
- Lone surrogates cannot be stored in `jsonb`.
- The atomic request limits default to the portable remote limits (`DEFAULT_ATOMIC_LIMITS`), not
  the in-process ones. Override them with the `atomicLimits` option.
- No vectors or search.

The adapter replays the shared store conformance corpus, including the atomic scenarios. Its test
suite names each skipped scenario with one of the differences above.

## Connection and ownership

`PostgresAdapter.open()` takes either a `connectionString` (plus optional `poolConfig`), in which
case the adapter owns its `pg.Pool`, or an existing `pool`, which stays caller-owned. The two forms
are mutually exclusive. `close()` is idempotent and ends only an adapter-owned pool; a failed
`open()` follows the same rule.

```ts
import { Pool } from "pg";
import { PostgresAdapter } from "@mirk/store-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const postgres = await PostgresAdapter.open({ pool, schema: "mirk" });
```

## Reference

### Physical model

The adapter provisions fixed tables in the configured schema (default `mirk`) with
`CREATE ... IF NOT EXISTS`, so the role needs permission to create them unless they already exist:

```sql
mirk.kv(key text primary key, value jsonb not null, updated_at timestamptz not null, version text)
mirk.records(collection text, id text, data jsonb not null,
             ordinal bigint generated always as identity, updated_at timestamptz not null,
             version text, primary key (collection, id))
mirk.atomic_receipts(key text primary key, request_digest text not null, result jsonb not null,
                    created_at bigint)  -- milliseconds since the epoch, indexed
mirk.atomic_state(id integer primary key, identity text not null)
mirk.atomic_versions  -- sequence
```

Opening an adapter adds the `version` columns to tables created by an earlier release and gives
existing rows a version token. It also adds `atomic_receipts.created_at`; receipts written before
it have no creation time. Upgrade every process that writes to a schema before relying on
atomic writes: an older adapter writes without the lock or a new version.

The schema name is quoted once at construction. Keys, collection names, record IDs, filter fields,
and values are always bound query parameters; they never become SQL identifiers or create tables.

### Contract semantics

`postgres.kv` implements `AsyncStore`, the optional `AsyncStoreInQuery` capability, and
`AsyncAtomicMutationStore`.

- Values and records must be JSON-serializable and round-trip through `jsonb`; `undefined`,
  functions, symbols, `bigint`, and non-finite numbers throw.
- `get` and `getById` return `null` when absent. `set` and `put` are upserts. `delete` and
  `remove` report whether a row existed.
- `keys(prefix)` matches the prefix literally (`%` and `_` are not wildcards) and returns keys in
  `ORDER BY key` order under the database's collation.
- `where` is exact top-level JSON equality and distinguishes a missing field from an explicit
  `null`. `listWhereIn` adds exact top-level membership on one field.
- Unsorted reads return insertion order; updating a record does not move it. Sorted reads put
  missing and `null` values last and break ties by insertion order.
- `count` applies `where` and ignores pagination and sorting. Negative or fractional `limit` and
  `offset` are rejected.

### Atomic writes and versions

`postgres.kv` implements `AsyncAtomicMutationStore`. Version tokens read `<identity>-v<n>`, where
`identity` is a random UUID recorded when the schema is first provisioned and `n` comes from a
per-schema PostgreSQL sequence. Every `set` and `put`, plain
or atomic, takes the next number; `delete`, `remove`, and a conflict take none. A rolled-back
write keeps its number, so no later write can reissue a token a caller already saw. Treat tokens
as opaque.

Idempotency receipts are durable rows. They survive other writes to the same target and adapter
restarts, so a retried request with the same key replays the first result. A connection failure
while a standalone `mutateAtomically` commits leaves the outcome unknown; the call throws
`AtomicMutationIndeterminateError`, and retrying with the same idempotency key is safe. A failure
before COMMIT was sent, such as a connection that could not be opened, is reported as the
underlying error: nothing was applied.

#### Receipt expiry

Receipts are kept forever by default. `receiptRetentionMs` lets them expire, with the rules in the
`@mirk/store` README's "Receipt expiry" section: a receipt is live while its age is at most the
window, a request whose key matches only an expired receipt is applied as new, and a keyed write
prunes at most 100 expired receipts under the schema lock. `postgres.kv.pruneExpiredReceipts()`
deletes the rest, one short transaction per batch, and returns how many it deleted.

```ts
const postgres = await PostgresAdapter.open({ pool, receiptRetentionMs: 3 * 24 * 60 * 60 * 1000 });
await postgres.kv.pruneExpiredReceipts();
```

The database's clock stamps and judges every receipt, so hosts with skewed clocks agree on a
receipt's age. The `now` option replaces it with a host clock, mainly for tests. A store with a
window stamps a receipt from an earlier release with the current time when it first prunes, so it
expires one full window later. **The window must be longer than the longest time a caller may
retry or reconcile a request**: a retry after it applies the mutation again. A host that
reconciles old receipts after an expired job lease, as the Foreclose app does, should leave expiry
off or use a window of days.

### Transactions

`postgres.transaction(work)` runs `work` in one transaction on one pooled client. It implements the
[`AsyncStoreTransactions`](../store/README.md#async-transactions) contract: `kv` calls inside
`work` join it, a nested call is a savepoint, and `afterCommit` callbacks run once, in order, after
the outermost commit. **`afterCommit` is best effort:** if the process dies between the commit
and the callback, the notification is lost.

Serialization is per schema. Every transaction, and every write outside one, takes a
transaction-scoped advisory lock on the schema name (`pg_advisory_xact_lock`), so writers on any
connection or host take turns. This includes conditions on targets that do not exist yet, which
row locks cannot cover. Reads do not take the lock and see committed data. The cost is write
throughput: one writer per schema at a time. Use separate schemas for independent data.

Keep transactions short and database-only. A transaction holds a pooled client and the schema lock
until it ends. A host that freezes or dies mid-transaction cannot hold the lock for long: each
transaction sets `idle_in_transaction_session_timeout` (option `transactionIdleTimeoutMs`, default
60000 ms, `0` disables), so PostgreSQL ends a session that sits idle that long and releases its
locks; that transaction then fails. Waiting for the lock behind a holder that is still working has
no limit of its own; set `lock_timeout` in `poolConfig` if you need one. Do not await another
adapter's writes to the same schema inside a transaction; they wait for the lock this transaction
holds.

An adapter that owns its pool listens for connection errors, so a session the server ends cannot
crash the process. If you pass your own `pool`, attach a `pool.on("error", …)` listener as
node-postgres recommends.

### Not supported

- `LISTEN`/`NOTIFY` change streams.
- PostgreSQL full-text search or pgvector facets.
- Schema migrations beyond the idempotent provisioning above.

## License

Apache-2.0
