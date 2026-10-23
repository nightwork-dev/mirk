# Changelog

Mirk releases as one version set. Every `@mirk/*` npm package and every `mirk-*` Python
distribution carries the same version and is bumped together, so "mirk 0.12.0" means the same
thing in every package and both languages. Releases up to 2026-09-22 were versioned independently.
This file records each release and repository-wide contract changes.

## 0.12.0 — 2026-10-23

The first release as one version set: every package moves to 0.12.0.

### Security

Every package now requires a patched Node release: 22.23.4, 24.22.1, or 26.12.1 and later
(CVE-2026-111497). Build and test tooling is updated so `pnpm audit` reports no findings. The
remaining upstream gaps (libSQL's bundled SQLite, and older native TLS libraries in the OpenDAL and
SurrealDB engines) are documented in those packages' READMEs.

### Changes

- `@mirk/store` — `@mirk/store/node-sqlite`, a built-in SQLite adapter on `node:sqlite` with the
  same facets and file format as the better-sqlite3 adapter; better-sqlite3 13 support; a
  transaction whose work returns a promise is rolled back and rejected; the shared
  `sortAndPageStoreItems` helper and code point comparator are exported.
- `@mirk/surreal` — **breaking for older remote servers:** the store now keeps insertion order
  using a SurrealDB sequence, so a remote server must support sequences. Records written by earlier
  versions still load. The store now passes every applicable shared store scenario: empty ids, lone
  surrogates in values, and non-scalar filters now behave as in the other stores. The embedded
  engines are pinned to 3.3.4 and need their separate `node-native` or `wasm-native` peer.
- `@mirk/store-libsql` — `@mirk/store-libsql/remote`, an engine-free remote entry; native vector
  search now runs (the neighbour count was sent as a float and silently fell back to a full scan),
  and native search errors are reported instead of hidden.
- `@mirk/vector-qdrant` — first public release. Async Qdrant vector adapter with exact cosine
  scores, metadata filters, and the storage format shared with the Python adapter.
- `@mirk/artifact` — artifact commits are bound to matching object leases, and direct deletion is
  protected from concurrent writers.
- `@mirk/store-markdown` — empty keys are rejected, index filename collisions and case aliases are
  guarded, and Git commits include only each mutation's own files.
- `@mirk/artifact-opendal` requires OpenDAL Node binding 0.49.13 or later. The other packages
  carry the patched Node baseline and dependency updates.

### Python

- `mirk-artifact`, `mirk-store-markdown`, `mirk-artifact-opendal`, and `mirk-vector-qdrant` are
  new distributions sharing storage formats and conformance scenarios with their TypeScript
  packages. All six Python distributions move to 0.12.0 with the version set.

### Documentation

- Every README is rewritten for first-time readers. Each opens with why you would use the package
  and a runnable example, and keeps its full contract below.
- The Electron compatibility harness is removed; Mirk targets Node runtimes.

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
