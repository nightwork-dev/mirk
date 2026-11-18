# Query statistics, indexes over several fields, and many readers

Date: 2026-11-16. Machine: Apple M5 Max, Node 24.22.1 (SQLite 3.53.4), libSQL client 0.14.0
(SQLite 3.45.1). Other work was running on the machine, so numbers under about 1 ms vary by two to
three times between runs.

Two scripts produce the tables (the refresh costs come from short probes, run once):

- `packages/store/scripts/bench-query-plans.ts` loads 300,000 `links` and 600,000 `membership`
  records through `NodeSqliteAdapter`, then times three reads on fresh connections.
- `packages/store-libsql/bench/concurrency.mjs` loads 300,000 records and times fast reads while a
  slow read runs, for `NodeSqliteAdapter` and the libSQL file adapter.

## Query statistics

SQLite picks an index from statistics that `ANALYZE` writes into the file. Mirk 0.14.0 never wrote
them. With none, SQLite guessed: for `{ to, type }` on links it read the `type` index, which matches
a fifth of the table, instead of the `to` index, which matches one row.

| Read | 0.14.0 | Statistics refreshed by Mirk | Plus an index over product, kind, state |
|---|---|---|---|
| one link by `{ to, type }` | 23.2 ms | 0.08 ms | 0.05 ms |
| ranked page: `listWhereIn` product, `where` kind and state, sorted, 90 rows | 85.5 ms | 13.1 ms | 0.29 ms |
| write that reads links first, then puts three rows | 74.4 ms (worst 1,285 ms) | 1.2 ms (worst 5.3 ms) | 1.2 ms (worst 1.8 ms) |

Medians of 30 runs. The middle column comes from a run on this branch after a full `ANALYZE`; the
run that relied only on Mirk's automatic refresh chose the same indexes, and its one-link median
was 1.5 ms because it ran straight after the load, with a large WAL file.

How the refresh works: SQLite 3.46 and later have the rule in the engine. `PRAGMA optimize` with
mask `0x10002` checks every table and analyzes one whose indexes have no statistics or whose row
count changed tenfold, under a temporary analysis limit
([SQLite documentation](https://sqlite.org/pragma.html#pragma_optimize)). Mirk calls it when an
adapter opens, after `ensureIndex`, after a transaction that brings the rows the connection has
changed since the last refresh to 1,000, and at close. On an older engine, such as libSQL's 3.45,
`PRAGMA optimize` only analyzes tables the connection has queried, so Mirk runs a bounded `ANALYZE`
(`analysis_limit` 1,000) on the tables that need it. One rule, `statisticsRefresh` in
`@mirk/store/sql`, serves both SQLite adapters, libSQL and (ported) Python.

Cost, measured on 900,000 records with five indexes: a refresh that had to analyze everything took
174 ms, about the same as a full `ANALYZE` (172 ms) on this file. A refresh with nothing to do took
0.05 ms. A probe of 1,000 no-op checks over 30 tables averaged 6 microseconds each; reading the
connection's changed-row count costs about 1 microsecond.

## Indexes over several fields

SQLite uses one index per table in a query. With an index on each field, a filter on product, kind
and state reads every row of one product and checks the rest row by row. With fresh statistics it
picks the best single field (13.1 ms above). One index over the three fields reads only the rows
that match (0.29 ms). `ensureIndex(collection, ["product", "kind", "state"])` declares it, so apps
no longer build a joined key such as `product|kind|state`.

## Many readers

Both SQLite adapters are synchronous. A query holds its thread until it ends. Fast reads are a
`getById` due every 2 ms for 4 seconds; the wait counts from when a read was due. The slow read is
a `where` on an unindexed field, a full scan (75 ms on `NodeSqliteAdapter`).

| Adapter and setup | Fast read 99th percentile | Worst | Other |
|---|---|---|---|
| `NodeSqliteAdapter`, fast reads alone | 1.29 ms | 18.1 ms | |
| `NodeSqliteAdapter`, slow read every 400 ms on the same adapter | 72.9 ms | 83.8 ms | |
| `NodeSqliteAdapter`, slow reads on a second adapter in a worker thread | 1.29 ms | 1.37 ms | 59 slow reads ran meanwhile |
| `NodeSqliteAdapter`, 4 reader processes, 1 slow-read process, 1 writer process | 0.03 ms | 5.05 ms | 408,320 reads a second; 470 writes of 100 puts |
| libSQL file, slow read every 400 ms on the same adapter | 87.1 ms | 110 ms | |
| libSQL file, slow reads on a second adapter in a worker thread | 8.63 ms | 37.1 ms | 2 slow reads failed `busy` |
| libSQL file, 4 reader processes, 1 slow-read process, 1 writer process | 0.03 ms | 3,385 ms | 338,146 reads failed `busy`; 10 writes, worst 9.6 s |

What this shows:

- The stall is the thread, not SQLite. Another connection on the same file, in a worker thread or
  another process, reads while the first one scans or writes. `NodeSqliteAdapter` sets WAL mode,
  which lets readers and one writer run at once.
- The libSQL file adapter does not avoid it. Its local engine runs on the calling thread too, it
  does not set WAL mode, and its reads do not retry a lock, so readers fail with `SQLITE_BUSY`
  while another connection writes. Its "fast reads alone" run also had stalls of up to 3.2 s that
  this note does not explain (guessed: connection replacement or lock waits; check with a trace of
  `LibsqlDatabase.alone`). The package README already directs local storage to
  `@mirk/store/node-sqlite`.

### Recommendation for a server with many readers

1. Use `NodeSqliteAdapter` (or the better-sqlite3 adapter).
2. Keep one adapter on the main thread for writes and quick reads.
3. Run slow reads (large lists, totals, sweeps) on a second adapter opened on the same file in a
   worker thread, or in another process. No change to Mirk is needed for this.
4. Use PostgreSQL when many processes or machines must write at once.

A read replica does not apply to a local file. libSQL's embedded replicas sync from a server and
were not measured.

### Not built: a reader pool in Mirk

A pool would give apps step 3 without writing worker code: `openSqliteReaders({ path, size })`
returns an `AsyncStore`-shaped object whose `list`, `listWhereIn`, `count` and `getById` run on one
of `size` worker threads, each with its own read-only `NodeSqliteAdapter`. Writes stay on the
caller's adapter. Rows come back by structured clone, which adds roughly the cost of parsing them
again. A reader sees what was committed when its statement started. Build it when a second app
needs it; until then the worker pattern above is a few lines in the app.
