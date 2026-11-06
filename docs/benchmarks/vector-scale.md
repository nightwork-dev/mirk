# Exact SQLite vector scaling

`packages/store/benchmarks/vector-scale.mjs` compares the ordinary JavaScript engine with the
native float64 sqlite-vec engine through the public `NodeSqliteAdapter.vector` methods. Its
seeded synthetic vectors contain no private or user data. Native scoring remains an exact scan;
it does not promise sublinear nearest-neighbor search.

Build the workspace and optional native companion, then run one benchmark process:

```sh
pnpm build
node --expose-gc packages/store/benchmarks/vector-scale.mjs --counts=1000,10000,100000 --dimensions=768 --directory=/tmp/mirk-vector-scale --output=/tmp/mirk-vector-scale.json
```

Use a new directory for each run. A mechanics-only smoke run can use `--counts=100
--dimensions=16 --repeats=1 --queries=1`. The full scale measurements are pending; no capacity
conclusion follows from that smoke run.

Each size has one canonical file, shared by both engines, with the same queries, topK and
metadata-filter conditions. The runner ingests configurable batches (default 256), then closes
and checkpoints the writer. Each mode runs in its own child process, sequentially. It refuses to
label an unavailable companion native and checks every returned ID, score and metadata value
exactly, including across repeats. The default filtered case retains one of ten metadata groups.

The JSON records hardware, Node and SQLite versions, ingestion wall/CPU time, file bytes,
per-call wall/CPU time, timer delay, memory snapshots, process maximum RSS, and p50/p95/maximum
latencies for filtered and unfiltered samples. Cold samples use fresh connections; OS file cache
is uncontrolled, so these are not measurements of disk-cold storage. Connection initialization is
recorded separately. Warm samples reuse a connection. Explicit garbage collection occurs before
each timed query when available; snapshots are not continuous peak-heap instrumentation.

Both APIs are synchronous. A native query still blocks its caller's event loop. The scheduled
timer exposes that delay, and CPU time distinguishes computation from elapsed waiting. A calling
application can move synchronous work to a worker or separate process when its own responsiveness
budget requires it. The report counts samples above illustrative 16.7 ms, 100 ms and 1,000 ms
budgets; these are comparison points, not an imposed SLA or capacity limit.
