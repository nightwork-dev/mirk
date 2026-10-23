# @mirk/store-postgres

> **Mirk's records in PostgreSQL, shared by every process that needs them.** Key-values and
> collections, with many writers at once.

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
- **No atomic batches and no transactions** through the store interface.
- **You run a Postgres server**, and the role needs permission to create two tables.

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
| Atomic writes | no | no atomic mutation, versioned reads, or transactions |

### Where it differs from the reference

The in-memory and SQLite stores are the reference. This adapter follows them for filtering,
ordering, and counting (see [Contract semantics](#contract-semantics)). The differences:

- Calls are async.
- Values and records round-trip through `jsonb`, so they must be JSON-serializable.
- `keys(prefix)` orders under the database's collation.
- No vectors, search, or atomic mutation.

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

The adapter provisions two fixed tables in the configured schema (default `mirk`) with
`CREATE ... IF NOT EXISTS`, so the role needs permission to create them unless they already exist:

```sql
mirk.kv(key text primary key, value jsonb not null, updated_at timestamptz not null)
mirk.records(collection text, id text, data jsonb not null,
             ordinal bigint generated always as identity, updated_at timestamptz not null,
             primary key (collection, id))
```

The schema name is quoted once at construction. Keys, collection names, record IDs, filter fields,
and values are always bound query parameters; they never become SQL identifiers or create tables.

### Contract semantics

`postgres.kv` implements `AsyncStore` and the optional `AsyncStoreInQuery` capability.

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

### Not supported

- Atomic mutation, versioned reads, or transactions.
- `LISTEN`/`NOTIFY` change streams.
- PostgreSQL full-text search or pgvector facets.
- Schema migrations beyond the idempotent initial provisioning above.

## License

Apache-2.0
