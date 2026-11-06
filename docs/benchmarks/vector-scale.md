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
--dimensions=16 --repeats=1 --queries=1`.

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


## Measured results, 6 November 2026

The run used packed Mirk 0.16.0 artifacts on macOS arm64, an Apple M5 Max with 18 logical CPUs
and 128 GiB RAM, Node 24.22.1, SQLite 3.53.4, and the pinned sqlite-vec 0.1.6 companion.
Own builds and tests were idle during measurement; OS caching and unrelated machine activity
were uncontrolled. Each cell below reports milliseconds, p50 / p95, across 21 warm searches
(three seeded queries, seven repeats), with `topK: 10`. The filter selects 10% of records.

| Vectors × 768 | JavaScript, all | Native, all | JavaScript, filtered | Native, filtered |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 3.73 / 3.94 | 1.64 / 1.77 | 1.77 / 1.98 | 0.65 / 0.75 |
| 10,000 | 45.82 / 48.45 | 15.55 / 16.18 | 19.70 / 20.90 | 5.89 / 6.04 |
| 100,000 | 515.90 / 540.98 | 184.95 / 231.09 | 224.17 / 236.78 | 64.20 / 69.01 |

| Vectors | Ingest seconds | Database MiB | JavaScript peak RSS MiB | Native peak RSS MiB |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 0.039 | 4.17 | 76.8 | 65.1 |
| 10,000 | 0.324 | 40.62 | 238.5 | 65.8 |
| 100,000 | 3.013 | 405.54 | 798.6 | 69.7 |

Ingestion used batches of 256 and includes the final checkpoint and close. RSS is the search
child process high-water mark, including its runtime and connection. Native metadata reported
`accelerated: true`; ordinary metadata reported `false`. Every returned ID, score, and metadata
value matched exactly across both engines, all three sizes, filtered queries, and repetitions.

At 100k, fresh-connection unfiltered p50 was 543.14 ms for JavaScript and 223.14 ms for native.
Those samples do not establish disk-cold behavior. Warm unfiltered timer-delay p50 was 516.20 ms
and 185.00 ms respectively, which confirms that native execution still blocks the calling thread.

For this dataset, JavaScript exceeded the illustrative 16.7 ms budget at 10k. Native stayed
within that budget at 10k in this run, but both engines exceeded 100 ms for unfiltered 100k
queries. At 100k, native was about 2.8 times faster for unfiltered searches and used much less
process memory. It remains a linear exact scan; use the application's own latency budget to
decide when to move this synchronous work off its request or UI thread. These measurements do
not establish production capacity, concurrent throughput, or performance on other platforms.
