---
"@mirk/store": minor
"@mirk/store-libsql": minor
"@mirk/store-postgres": minor
"@mirk/store-indexeddb": minor
"@mirk/surreal": minor
---

Declared field indexes and range filters.

`ensureIndex(collection, field)` declares that queries filter or sort on a field. It is idempotent, one statement, and safe to call on every start (`SyncStoreIndexes` / `AsyncStoreIndexes`, lifted by `toAsync`). The SQLite adapters and libSQL create `ix_<table>_<hex of field>` on `json_extract(data, '$."field"')`; the query plan then uses it for `where` equality, `listWhereIn`, ranges and `sortBy`. PostgreSQL creates `(collection, (data -> 'field'))` and `(collection, ((data ->> 'field') COLLATE "C"))` in one round trip, used for equality, `listWhereIn` and ranges. The in-memory reference, IndexedDB and SurrealDB accept the call and do nothing. On 120,000 SQLite records (`scripts/bench-list-where-in.ts`), an equality on one field went from 41 ms to 0.3 ms, `observedAt >= since` for the newest 1,200 from 42 ms to 0.9 ms, the 50 newest by `sortBy` from 118 ms to under 0.1 ms, and `listWhereIn` over 50 values from 52 ms to 9 ms. A `listWhereIn` that returns 40% of the table takes as long with the index as without.

A `where` value made only of `gt`, `gte`, `lt` and `lte` bounds is a range: `where: { seenAt: { gte: since } }`. A number bound matches only numbers; a string bound matches only strings, by Unicode code point; `null` and missing never match. A bound that is not a finite number or a string throws `StoreFilterError` with the new code `invalid-range-bound`. Every adapter that replays the store corpus implements it, and PostgreSQL now validates `where` values like the reference.

SQLite `where` and `sortBy` now write the JSON path into the SQL text, and `sortBy` sorts with `NULLS LAST`; results are unchanged. `jsonPathLiteral` always returns a string.

Fixed: a field name holding `"`, `\` or a control character never matched in `where`, `sortBy` or `listWhereIn` on SQLite and libSQL, in TypeScript and Python, because the JSON path escaped `"` as `""`. The path label is now written with JSON escapes, and `"` as `\u0022`, which SQLite 3.45 (libSQL) and later both read.

The Python `mirk-store` package gains `ensureIndex` and range filters with the same semantics, and its SQLite store creates the same index under the same name.

Filter values are validated the same way on every backend. A `NaN` or infinite number in `where` or `listWhereIn` throws `StoreFilterError` with code `non-finite-number` (SQLite used to bind it as NULL and match nothing; PostgreSQL threw `PostgresValueError`). `listWhereIn` takes at most `MAX_IN_VALUES` (10,000) values and throws code `too-many-in-values` past that, in place of SQLite's raw `too many SQL variables`. A field name holding NUL now works on SQLite, libSQL, memory and Python, where `bad JSON path` was thrown; PostgreSQL, which cannot store such a key, matches nothing. PostgreSQL validates `listWhereIn` values like the reference. In Python, an integer above 2^53 in a filter is normalized the way a stored one is, so it matches the record it was written as.
