# Roadmap — mirk

Mirk provides substrate-level storage primitives with no application domain baked in. New primitives
must have a generic contract, clear backend parity, and demonstrated use beyond a single application.
Shipped history remains visible here so stable roadmap IDs are never reused.

## How this roadmap works

Every item has a stable `MR-NN` identifier, package, horizon, and status. Items move forward when the
port is proven, real backends can meet its semantics, and critical behavior has conformance tests.

| ID | Title | Package | Horizon | Status |
| --- | --- | --- | --- | --- |
| MR-01 | Graph primitive — edge model and traversal | `@mirk/store/graph` | near | shipped |
| MR-02 | Event primitive | — | med | closed; outside Mirk's storage scope |
| MR-03 | Addressable no-drop inbox | `@mirk/inbox` | maybe | proposed |
| MR-04 | Batch/IN collection matching | `@mirk/store` | near | shipped |
| MR-05 | Full-text search primitive | `@mirk/store/search` | near | shipped |
| MR-06 | Lazy SQLite vector dimensions | `@mirk/store/sqlite` | near | implemented |
| MR-07 | Authored-data fixture loader | `@mirk/fixtures` | near | core and store slice implemented |
| MR-08 | Qdrant vector adapter | `@mirk/vector-qdrant` | med | proposed, consumer-gated |
| MR-09 | Shared-connection SurrealDB adapters | `@mirk/surreal` | med | core, Node, and WASM memory implemented |
| MR-10 | Durable artifact substrate | `@mirk/artifact` | near | implemented, pre-release |
| MR-11 | Markdown and YAML-headmatter store | `@mirk/store-markdown` | near | implemented, pre-release |
| MR-12 | PostgreSQL async store adapter | `@mirk/store-postgres` | near | implemented, pre-release |
| MR-13 | PostgreSQL native full-text facet | `@mirk/store-postgres/search` | med | proposed, parity-gated |
| MR-14 | PostgreSQL pgvector facet | `@mirk/store-postgres/vector` | med | proposed, consumer-gated |
| MR-15 | Shared logical namespaces and bounded SQLite writer waits | `@mirk/store` | near | implemented; downstream integration in progress |

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

Remaining work includes filesystem and package-resource sources, additional parser plugins, CLI
support, and broader browser and packaging verification.

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

### MR-02 · Event primitive

Closed. Event delivery, wake scheduling, and transport orchestration are not storage primitives and
do not belong in Mirk. Mirk may supply durable records beneath such systems without owning their
messaging contract.

## Maybe later

### MR-03 · Addressable no-drop inbox

A possible append-log and status primitive layered over `@mirk/store/kv`. It remains proposed until
multiple independent consumers demonstrate a shared contract that is smaller than a messaging or
workflow framework.
