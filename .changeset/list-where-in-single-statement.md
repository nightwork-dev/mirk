---
"@mirk/store": minor
"@mirk/store-libsql": minor
"@mirk/store-postgres": patch
---

`listWhereIn` is one index-friendly statement on every SQL backend. On SQLite (`@mirk/store/sqlite`, `@mirk/store/node-sqlite`) strings and numbers compile to a single `json_extract(data, '$."field"') IN (...)` with a `json_type` check, in place of one OR-ed clause per value, so each row's field is read once rather than once per value. On 120,000 records, 50 values went from about 810 ms to 34 ms and 500 values from about 5.9 s to 61 ms. The JSON path is written into the SQL so an expression index on the same `json_extract` can serve the query; `@mirk/store/sql` exports `jsonPathLiteral` and `buildInClause`. `@mirk/store-libsql` (and `@mirk/store-libsql/remote`) now implement `AsyncStoreInQuery` with the same SQL, one round trip per call. `@mirk/store-postgres` matches with `(data -> field) = ANY($n::jsonb[])`, which an expression index on `(collection, (data -> 'field'))` can serve. The Python SQLite store uses the same statement. The SQLite adapters' `.kv` type now declares `SyncStoreInQuery`, which it already implemented. Matching semantics are unchanged.
