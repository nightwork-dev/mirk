# Roadmap — mirk

Mirk provides storage primitives with no application domain baked in. A new primitive needs a
generic contract, parity across real backends, and conformance tests for its critical behavior.
Every item keeps a stable `MR-NN` identifier; IDs are never reused.

Shipped items are documented in their package READMEs. This page tracks what exists and what is
still open.

| ID     | Title                                                     | Package                              | Status        |
| ------ | --------------------------------------------------------- | ------------------------------------ | ------------- |
| MR-01  | Graph primitive — edge model and traversal                | `@mirk/store/graph`                  | shipped       |
| MR-02  | Event primitive                                           | —                                    | closed        |
| MR-03  | Addressable no-drop inbox                                 | —                                    | deferred      |
| MR-04  | Batch/IN collection matching                              | `@mirk/store`                        | shipped       |
| MR-05  | Full-text search primitive                                | `@mirk/store/search`                 | shipped       |
| MR-06  | Lazy SQLite vector dimensions                             | `@mirk/store/sqlite`                 | shipped       |
| MR-07  | Authored-data fixture loader                              | `@mirk/fixtures`                     | shipped       |
| MR-08  | Qdrant vector adapter                                     | `@mirk/vector-qdrant`                | proposed      |
| MR-09  | Shared-connection SurrealDB adapters                      | `@mirk/surreal`                      | shipped       |
| MR-10  | Durable artifact substrate                                | `@mirk/artifact`                     | shipped       |
| MR-11  | Markdown and YAML-headmatter store                        | `@mirk/store-markdown`               | shipped       |
| MR-12  | PostgreSQL async store adapter                            | `@mirk/store-postgres`               | shipped       |
| MR-13  | PostgreSQL native full-text facet                         | `@mirk/store-postgres/search`        | proposed      |
| MR-14  | PostgreSQL pgvector facet                                 | `@mirk/store-postgres/vector`        | proposed      |
| MR-15  | Shared logical namespaces and bounded SQLite writer waits | `@mirk/store`                        | shipped       |
| MR-16  | Backend-neutral atomic mutation capabilities              | `@mirk/store/atomic`                 | shipped       |
| MR-17  | Coordinated multi-process SQLite writer profile           | —                                    | deferred      |
| MR-18  | Bitemporal statements persistence                         | `@mirk/statements`                   | shipped       |
| MR-19  | OpenDAL object-storage artifact adapter                   | `@mirk/artifact-opendal`             | shipped       |
| MR-20  | Python port of `@mirk/store`                              | `python/store` (`mirk-store`)        | shipped       |
| MR-21  | Collision-safe physical table naming                      | `@mirk/store`, `python/store`        | shipped       |
| MR-22  | Remove the never-executed sqlite-vec path                 | `@mirk/store/sqlite`, `python/store` | shipped       |
| MR-22b | Does the libSQL native vector path execute?               | `@mirk/store-libsql`                 | open question |
| MR-23  | Python port of `@mirk/fixtures`                           | `python/fixtures` (`mirk-fixtures`)  | shipped       |

"Shipped" means implemented and tested on the default branch. Published versions are listed in
[`CHANGELOG.md`](../CHANGELOG.md). The Python packages build as wheels but are not yet on an index.

## Open

### MR-08 · Qdrant vector adapter

A server-side implementation of the existing vector port, for workloads that outgrow the embedded
and general-purpose database adapters. Release requires cross-backend cosine, filter, update,
removal, and dimensionality parity.

### MR-13 · PostgreSQL native full-text search facet

A separately imported async search facet over the `@mirk/store-postgres` pool using `tsvector`,
`tsquery`, and GIN indexes. It lands only when field weighting, filtering, ranking order, updates,
removals, and empty-query behavior meet the existing search contract.

### MR-14 · PostgreSQL pgvector facet

A separately imported `AsyncVectorStore` facet sharing the same pool. Exact cosine search is the
parity baseline; HNSW and IVFFlat are explicit options because they trade recall for latency.

### MR-17 · Coordinated multi-process SQLite writer profile

SQLite inspection and explicit checkpoints ship in `@mirk/store/sqlite`, and several processes may
open one file directly. A coordinated writer that serializes many processes' writes through one
owner is deferred; use PostgreSQL for sustained multi-writer workloads.

### MR-22b · Does the libSQL native vector path execute?

`@mirk/store-libsql` reports `accelerated` for its `vector_top_k` path, but no test yet shows that
path executes rather than falling back to JS cosine. Until one does, treat libSQL vector search as
exact cosine.

### MR-03 · Addressable no-drop inbox

A possible append-log and status primitive over `@mirk/store/kv`, deferred until a storage-only
contract emerges. A messaging or workflow framework is out of scope.

## Closed

### MR-02 · Event primitive

Event delivery, wake scheduling, and transport orchestration are not storage primitives. Mirk may
supply durable records beneath such systems without owning their messaging contract.
