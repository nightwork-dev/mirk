# @mirk/store-postgres

PostgreSQL source adapter for `@mirk/store`'s asynchronous key-value and collection ports. Use it
when several processes or hosts need to write the same store concurrently; PostgreSQL's MVCC lets
readers and writers proceed together, where SQLite admits one writer at a time.

```bash
npm install @mirk/store-postgres
```

`pg` and `@mirk/store` are regular dependencies.

```ts
import { PostgresAdapter } from "@mirk/store-postgres";

const postgres = await PostgresAdapter.open({
  connectionString: process.env.DATABASE_URL,
});

await postgres.kv.set("settings", { theme: "dark" });
await postgres.kv.put("projects", { id: "mirk", status: "active" });

await postgres.close();
```

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

## Physical model

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

## Contract semantics

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

## Not supported

- Atomic mutation, versioned reads, or transactions.
- `LISTEN`/`NOTIFY` change streams.
- PostgreSQL full-text search or pgvector facets.
- Schema migrations beyond the idempotent initial provisioning above.

## License

Apache-2.0
