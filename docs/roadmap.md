# Roadmap — mirk

Mirk provides substrate-level storage primitives with no application domain baked in. New primitives
must have a generic contract, clear backend parity, and demonstrated use beyond a single application.
Shipped history remains visible here so stable roadmap IDs are never reused.

Detailed sequencing for the current closure program lives in
[`substrate-work-spec.md`](substrate-work-spec.md). Mirk maintains package-owned
port and adapter contract suites; consuming projects retain their own
integration and deployment evidence outside this repository.

## How this roadmap works

Every item has a stable `MR-NN` identifier, package, horizon, and status. Items move forward when the
port is proven, real backends can meet its semantics, and critical behavior has conformance tests.
“Local” means source and package tests exist in this checkout. “Verdaccio” means published to the
canonical local registry; it does not mean public npm publication or consumer adoption.

| ID    | Title                                                     | Package                       | Horizon | Status                                      |
| ----- | --------------------------------------------------------- | ----------------------------- | ------- | ------------------------------------------- |
| MR-01 | Graph primitive — edge model and traversal                | `@mirk/store/graph`           | near    | shipped                                     |
| MR-02 | Event primitive                                           | —                             | med     | closed; outside Mirk                        |
| MR-03 | Addressable no-drop inbox                                 | `@mirk/inbox`                 | maybe   | deferred; needs a storage-only contract     |
| MR-04 | Batch/IN collection matching                              | `@mirk/store`                 | near    | shipped                                     |
| MR-05 | Full-text search primitive                                | `@mirk/store/search`          | near    | shipped                                     |
| MR-06 | Lazy SQLite vector dimensions                             | `@mirk/store/sqlite`          | near    | shipped                                     |
| MR-07 | Authored-data fixture loader                              | `@mirk/fixtures`              | near    | Verdaccio, including CLI                    |
| MR-08 | Qdrant vector adapter                                     | `@mirk/vector-qdrant`         | med     | proposed; consumer-gated                    |
| MR-09 | Shared-connection SurrealDB adapters                      | `@mirk/surreal`               | med     | core, Node, and WASM memory shipped         |
| MR-10 | Durable artifact substrate                                | `@mirk/artifact`              | near    | Verdaccio; capability-gated                 |
| MR-11 | Markdown and YAML-headmatter store                        | `@mirk/store-markdown`        | near    | shipped                                     |
| MR-12 | PostgreSQL async store adapter                            | `@mirk/store-postgres`        | near    | shipped                                     |
| MR-13 | PostgreSQL native full-text facet                         | `@mirk/store-postgres/search` | med     | proposed; parity-gated                      |
| MR-14 | PostgreSQL pgvector facet                                 | `@mirk/store-postgres/vector` | med     | proposed; consumer-gated                    |
| MR-15 | Shared logical namespaces and bounded SQLite writer waits | `@mirk/store`                 | near    | Verdaccio                                   |
| MR-16 | Backend-neutral atomic mutation capabilities              | `@mirk/store`                 | near    | Verdaccio; optional capability              |
| MR-17 | Coordinated multi-process SQLite writer profile           | package TBD                   | med     | Verdaccio evidence; writer profile deferred |

## Near term

### MR-01 · Graph primitive

`@mirk/store/graph` ships flat edge records, `neighbors()`, `traverse()`, and
`traverseFrontierBatched()` over the ordinary collection port. The optional `AsyncGraphTraversal`
capability lets an engine provide native traversal without changing the public result contract.
Traversal is cycle-safe, preserves complete edge records, supports direction and depth bounds, and
applies caller policy through `edgeFilter`.

### MR-04 · Batch/IN collection matching

The optional `SyncStoreInQuery` and `AsyncStoreInQuery` capabilities add `listWhereIn()`. Graph
frontier traversal uses the capability when available and retains the load-once fallback otherwise.
Implementations must preserve normal `StoreFilter` semantics and deterministic traversal results.

### MR-05 · Full-text search primitive

`@mirk/store/search` provides `SearchStore` and `AsyncSearchStore`, an in-memory BM25-style
reference, sync-to-async lifting, and an SQLite FTS5 facet. Documents may use a single text value or
stable named fields with query-time field weights. Ranking, filters, schema mismatch behavior,
updates, removals, and reopen persistence are covered by parity tests.

### MR-06 · Lazy SQLite vector dimensions

`SqliteAdapter` can open without vector dimensions. The vector facet learns dimensions from its
first write, persists them, and enforces them on reopen. Searching an empty unconfigured vector
store still requires known dimensions, preventing an accidental schema choice.

### MR-07 · Authored-data fixture loader

`@mirk/fixtures` validates and materializes authored data with deterministic layering, patch
overlays, references, provenance, and diagnostics. Core remains parser-injected and Standard Schema
based. Store integration lives at `@mirk/fixtures/store` and can both load fixture records and seed
ordinary collections.

Filesystem and file-backed package-resource sources, the explicit Node-only CLI subpath, and the
`mirk-fixtures` binary are implemented locally. Optional parser plugins
and bundled browser/edge package manifests remain separately gated future work. Publication and
consumer/runtime adoption are not asserted by this roadmap row.

Specification: [`fixtures-spec.md`](fixtures-spec.md). Package documentation:
[`packages/fixtures/README.md`](../packages/fixtures/README.md).

### MR-08 · Qdrant vector adapter

A server-side implementation of the existing vector port. It should arrive when an actual workload
outgrows the embedded and general-purpose database adapters. Release requires cross-backend cosine,
filter, update, removal, and dimensionality parity.

### MR-09 · Shared-connection SurrealDB adapters

`@mirk/surreal` owns one `SurrealConnection`; separately imported `/store`, `/graph`, `/vector`,
`/search`, `/storage`, `/node`, and `/wasm` subpaths can share it without loading unrelated
capabilities.

The graph facet uses native relation records and bounded engine traversal while preserving the same
public traversal contract as the generic helpers. Store, vector, graph, object storage, and artifact
composition are tested against the Node embedded engine and a loopback server connection.

The browser WASM helper supports `mem://`. Persistent `indxdb://` remains disabled until a released
upstream engine containing the IndexedDB transaction fix passes Mirk's write/reopen/read browser
gate. Weighted multi-field search also remains an explicit unsupported capability until the engine
can meet the search port.

Application-specific schemas, temporal validity rules, live-query policies, and domain query shapes
remain above Mirk's adapters.

### MR-10 · Durable artifact substrate

`@mirk/artifact` provides durable byte-bearing outputs, object-storage ports, integrity, portable
metadata, and source/derivative lineage. It deliberately excludes jobs, providers, workers, retries,
progress, approval, and application-specific attachment semantics.

The core package, store repository, filesystem object store, OpenDAL binding, repository-atomic
finalization, explicit single-writer versus atomic coordinator mode, repository-owned shared-writer /
exclusive-deletion object leases, and the read-only audit plus plan-first maintenance repair subpath
are implemented locally. These storage leases are distinct from
execution-system resource leases. Adapters without the required capability remain single-writer or
reject destructive repair; publication and consumer/runtime adoption are separate evidence.

Metadata uses `@mirk/store/kv`; bytes use an `ObjectStore`. `@mirk/artifact-opendal` supplies the
optional OpenDAL adapter.

Specification: [`artifact-spec.md`](artifact-spec.md).

### MR-11 · Markdown and YAML-headmatter store

`@mirk/store-markdown` implements `SyncStore` over one Markdown file per record. Configurable field
mappings support frontmatter, whole-body content, or named sections. Reads reflect current disk
state; writes preserve unknown frontmatter and unconfigured body sections, use atomic replacement,
regenerate an optional index, and can create one local Git commit per mutation.

Version 1 is single-writer and last-write-wins across processes. Corrupt records produce one typed
aggregate error containing every affected path because the current collection contract cannot return
healthy records and diagnostics together.

### MR-12 · PostgreSQL async store adapter

`@mirk/store-postgres` implements `AsyncStore` and `AsyncStoreInQuery` over one owned or
caller-provided `pg.Pool`. Fixed JSONB-backed KV and records tables keep collection names as bound
data. Tests cover exact top-level filters, insertion and sorted-tie ordering, null/missing behavior,
literal key prefixes, persistence, pool ownership, pagination, and hostile identifiers against a
real PostgreSQL server.

Specification: [`store-postgres-spec.md`](store-postgres-spec.md). Package documentation:
[`packages/store-postgres/README.md`](../packages/store-postgres/README.md).

### MR-15 · Shared logical namespaces and bounded SQLite writer waits

`@mirk/store@0.9.0` implements logical `namespaceStore()` views, a 30-second default SQLite busy timeout,
and synchronous `deferred`, `immediate`, and `exclusive` transaction modes on `SqliteAdapter`. These
are the admitted direct-connection foundation; they do not claim that direct SQLite is a universal
multi-process default.

The broader concurrency specification is split across MR-15's shipped foundation, MR-16's implemented
optional atomic mutation contract, and MR-17's implemented evidence surfaces with its coordinated
writer profile still deferred:
[`shared-store-concurrency-spec.md`](shared-store-concurrency-spec.md).

### MR-16 · Backend-neutral atomic mutation capabilities

`@mirk/store@0.9.0` implements a deliberately optional declarative atomic mutation
capability with versioned reads, explicit conditions, bounded mutation batches, no-expiry idempotency
receipts, and typed conflict, backend, and indeterminate outcomes. It does not widen the base store
ports with arbitrary transaction callbacks or pretend a sequence of independent writes is atomic.
In-memory and SQLite contract tests cover the capability; publication and consumer/runtime adoption
remain separate evidence.

## Medium term

### MR-13 · PostgreSQL native full-text search facet

A separately imported async search facet over the MR-12 pool using PostgreSQL `tsvector`, `tsquery`,
and GIN indexes. It lands only when field weighting, filtering, ranking order, updates, removals, and
empty-query behavior meet the existing search contract. Language configuration and index migrations
must be explicit.

### MR-14 · PostgreSQL pgvector facet

A separately imported `AsyncVectorStore` facet sharing the MR-12 pool. Exact cosine search is the
parity baseline. The vector extension and codec remain dependencies of this subpath only; HNSW and
IVFFlat are explicit operational options because they may trade recall for latency.

### MR-17 · Coordinated multi-process SQLite writer profile

`@mirk/store@0.9.0` implements read-only SQLite inspection, explicit checkpoint
operations, declared generic thresholds, and a two-process fault/contention harness with generated
records, reconciliation, reopen, and WAL evidence. The coordinated client/writer boundary remains
deferred: no writer daemon is part of MR-17, and any future service requires separate protocol and
authorization evidence. Direct multi-process SQLite remains an explicit opt-in rather than the
default.

### Migration and release evidence

`@mirk/migrate@0.2.0` is published to local Verdaccio with plan-bound checkpoint v2, explicit v1
upgrades, caller-owned post-copy verification, and the existing manifest copy lanes. Public npm
publication and consumer adoption are not asserted here.

`pnpm release:verify` exercises package build, tests, typecheck, packed contents, export resolution,
dependency boundaries, and a temporary generic install. `pnpm release:receipt` additionally requires
a clean source tree for a publication receipt. These commands provide package-owned build evidence;
they do not prove registry publication or downstream runtime adoption.

### `@mirk/statements` · specialized package

`@mirk/statements` is a SQLite-backed persistence package for the separately versioned
`statements-storage/v1` schema, including admission receipts, bitemporal indexes, replay, and its
legacy dual-read parity harness. It may use Mirk's general store and coordination capabilities, but
its domain-shaped schema is independently versioned and does not widen the general store ports.

### MR-02 · Event primitive

Closed. Event delivery, wake scheduling, and transport orchestration are not storage primitives and
do not belong in Mirk. Mirk may supply durable records beneath such systems without owning their
messaging contract.

## Maybe later

### MR-03 · Addressable no-drop inbox

A possible append-log and status primitive layered over `@mirk/store/kv`. It is deferred and treated
as closed for the current roadmap until a proven storage-only contract emerges. A messaging or
workflow framework is out of scope; no inbox package is admitted on the basis of a single consumer.
