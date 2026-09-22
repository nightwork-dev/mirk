# Changelog

Mirk packages are versioned independently. This file records coordinated public releases and
repository-wide contract changes; package-specific changes remain described by Changesets before
versioning.

## 2026-09-22

### Package train

- `@mirk/store@0.11.0` — encrypted record envelopes (`@mirk/store/encrypted`); per-backend atomic
  mutation limits, overridable at construction; collision-safe physical table naming through a
  `_mirk_tables` registry (existing files are adopted in place); `canonicalDigest`, `sha256Hex`,
  and `sha256HexBytes` exports; the never-executed sqlite-vec path and `forceJsCosine` removed;
  named error classes with stable codes; one busy-retry policy for the SQLite coordinator and
  adapter.
- `@mirk/store-indexeddb@0.2.0` — first public release. Browser adapter for the async store and
  atomic ports, verified against the shared conformance corpus in Chromium. Breaking against the
  earlier private builds: `openIndexedDbAdapter` is the only factory.
- `@mirk/fixtures@0.5.0` — `jsonSchema` type declarations with an injected validator; every source
  orders by code point; duplicate source ids are rejected; `@mirk/fixtures/filesystem` and
  `@mirk/fixtures/package` sources.
- `@mirk/artifact@0.3.0` — deterministic id, clock, and audit-id injection; code point ordering;
  digests reuse `canonicalDigest` (`finalizationDigest` is deprecated); coded errors.
- `@mirk/surreal@0.2.0` — code point `keys()` order; coded errors on every subpath.
  `SurrealObjectStoreGenerationError` now takes a code as its first constructor argument.
- `@mirk/store-libsql@0.2.0` — the table registry; code point vector tie-breaks; coded errors.
- `@mirk/artifact-opendal@0.2.1`, `@mirk/migrate@0.2.1`, `@mirk/statements@0.2.1`,
  `@mirk/store-markdown@0.1.3`, `@mirk/store-postgres@0.1.3` — code point ordering where they sort
  (OpenDAL `list()` also stops returning directory entries; statements fingerprints still accept
  replays written by earlier versions) and coded errors.

Across every package, error messages and base error types are unchanged, and each error class
keeps `name` on its prototype like built-in errors.

### Python

- `mirk-store` and `mirk-fixtures` 0.1.0 — the Python port, held to the same conformance corpus.

### Documentation

- Package READMEs are now the specification for each package; the separate design specs, planning
  notes, and evidence logs were removed from the repository.
- Added `CONTRIBUTING.md` for the development, conformance, and release workflow.
- Added an automated public-documentation integrity and privacy check (`pnpm docs:check`).

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
