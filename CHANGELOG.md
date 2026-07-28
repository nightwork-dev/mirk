# Changelog

Mirk packages are versioned independently. This file records coordinated public releases and
repository-wide contract changes; package-specific changes remain described by Changesets before
versioning.

## Unreleased

### Added

- `@mirk/fixtures/filesystem` for deterministic, real-path-contained Node directory sources.
- `@mirk/fixtures/package` for file-backed package resources rooted at `import.meta.url`.

### Documentation

- Reconciled public package, specification, and roadmap statuses with the released package train.
- Split the shared-store concurrency roadmap into the shipped MR-15 foundation, proposed MR-16
  atomic mutation contract, and proposed MR-17 coordinated writer profile.
- Added an automated public-documentation integrity and privacy check.

## 2026-07-28

### Consolidated public package train

- `@mirk/store@0.8.0` — logical namespaces, bounded SQLite writer waits, transaction modes, graph
  frontier batching, full-text search, and lazy vector dimensions.
- `@mirk/store-libsql@0.1.3` — released against the `@mirk/store@0.8` contract.
- `@mirk/artifact@0.1.1` and `@mirk/artifact-opendal@0.1.1` — durable artifact metadata, integrity,
  lineage, local filesystem bytes, and an OpenDAL object-store binding.
- `@mirk/fixtures@0.1.1` — core, memory, store, reference-graph, materialization, and seeding slices.
- `@mirk/migrate@0.1.1` — checkpointed copy helpers across store, vector, search, graph, and object
  lanes.
- `@mirk/store-markdown@0.1.1` — human-editable Markdown/YAML persistence with derived indexes and
  optional local Git history.
- `@mirk/store-postgres@0.1.1` — async KV and collection storage over one owned or caller-provided
  PostgreSQL pool.
- `@mirk/surreal@0.1.1` — shared-connection store, graph, vector, object-storage, Node, and browser
  WASM-memory adapters.
