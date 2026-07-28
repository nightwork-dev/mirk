# PostgreSQL store adapter specification

## Status

Implementation specification for `@mirk/store-postgres` 0.1.

## Purpose

`@mirk/store-postgres` implements `@mirk/store`'s remote-capable key-value and collection contracts over PostgreSQL. It is an adapter package, not a new storage port. One adapter owns or borrows one `pg.Pool`, and its capability facets share that pool.

Version 0.1 exposes one facet:

- `adapter.kv`: `AsyncStore & AsyncStoreInQuery`

The package root remains explicit and does not re-export PostgreSQL from `@mirk/store`.

## Connection and ownership

`PostgresAdapter.open()` accepts either:

- a connection string plus optional pool configuration, in which case the adapter owns the pool; or
- an existing `pg.Pool`, in which case the caller owns it.

The two forms are mutually exclusive. `close()` is idempotent. It ends only an adapter-owned pool. Initialization failure follows the same ownership rule.

## Physical model

The default schema is `mirk`. Version 0.1 uses two fixed tables:

```sql
mirk.kv(key text primary key, value jsonb not null, updated_at timestamptz not null)
mirk.records(collection text, id text, data jsonb not null, ordinal bigint generated as identity,
             updated_at timestamptz not null,
             primary key(collection, id))
```

Collection names and record IDs are bound values. They do not create tables or become identifiers. A custom schema is safely quoted once during adapter construction.

## Contract semantics

- Values and records must be JSON-serializable and round-trip through `jsonb`.
- `get` and `getById` return `null` when absent.
- `set` and `put` are upserts.
- `delete` and `remove` report whether a row existed.
- `keys` is lexically ordered and its prefix is literal, including `%` and `_`.
- `where` is exact top-level JSON equality and distinguishes a missing key from an explicit JSON `null`.
- `listWhereIn` applies exact top-level JSON membership in addition to ordinary filters.
- Unsorted collection reads preserve insertion order; updating a record does not move it.
- Sorted reads put missing and JSON-null values last and preserve insertion order for ties.
- `count` applies `where` but ignores pagination and sorting.
- Negative or fractional `limit` and `offset` values are rejected.

All data values use query parameters. PostgreSQL identifiers are never derived from keys, collections, record IDs, or filter fields.

## Conformance and release gates

Release requires:

1. real PostgreSQL tests for the full `AsyncStore` surface;
2. exact-filter, ordering, pagination, null/missing, and `listWhereIn` parity checks;
3. persistence across independently opened pools;
4. proof that closing an adapter does not close a caller-owned pool;
5. schema-identifier injection coverage;
6. workspace build, typecheck, and test passes;
7. packed-package installation and a clean-consumer round trip.

## Deliberately excluded from 0.1

- Transactions or batch mutation APIs: no corresponding Mirk port exists yet.
- Change streams through `LISTEN`/`NOTIFY`: no proven consumer contract exists.
- PostgreSQL full-text search: a future facet must preserve `SearchStore` weighting, filtering, ranking, update, and removal behavior.
- Vector search: a future facet must preserve `AsyncVectorStore` cosine and filter semantics, with exact search as the baseline and approximate indexes explicitly opt-in.
- Migrations beyond idempotent initial provisioning: destructive or versioned schema evolution needs a separate migration contract.
