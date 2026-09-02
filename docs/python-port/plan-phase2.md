# Python port, phase 2 — fixtures and artifact

> **For agentic workers:** each task is a brief for one fresh executor. Read
> `docs/python-port-spec.md`, the digest named in your task, and
> `conformance/README.md` before touching code. Phase 1 conventions apply
> unchanged: camelCase op names, corpus generated not authored, no skips,
> authors never write `conformance/`, executors never commit.

**Goal:** `@mirk/fixtures` and `@mirk/artifact` run in Python as `mirk-fixtures`
and `mirk-artifact` (namespace `mirk.fixtures`, `mirk.artifact`), proven
identical to TypeScript by corpus directories `store/atomic/`, `fixtures/`, `artifact/hashing/`,
and `artifact/`, with byte-identical hashing.

**Digests:** `docs/python-port/digests/fixtures.md`,
`docs/python-port/digests/artifact.md`.

## Rulings that shape the work

Reviewed 2026-09-02 by a codex Luna lane in fresh context
(`docs/python-port/reviews/2026-09-02-plan2-review-luna.md`); the review
restructured wave 0 and cut scope. What stands:

1. **The atomic mutation API ports first, as its own wave.** Artifact depends
   on `getVersioned`, `mutateAtomically`, receipts and canonical request
   digests, so `mirk.store.atomic` (with `mirk.store.canonical`) is wave 0,
   owned by the store, with corpus directory `store/atomic/` and a SQLite
   exchange in both directions. The corpus pins: the three bookkeeping tables
   (columns, initialization, key encoding), `getVersioned` missing/present and
   the version token serialization, sequence allocation and whether failed
   mutations consume values, `mutateAtomically` conditions, operation order,
   conflict result, rollback, receipt shape `{requestDigest, recordId}`,
   canonical request fields and omissions, lowercase SHA-256 over UTF-8.
2. **The thinnest real transaction runs before any port beyond atomic.**
   TypeScript (`ArtifactCoordinator` + `StoreArtifactRepository` over SQLite
   + `FileObjectStore`) finalizes one artifact with injected id and clock; a
   fresh Python process opens the same file and directory, verifies it, reads
   bytes and lineage; then the reverse. Recorded as dated evidence.
3. **Canonical JSON contract.** Code point key order; ECMAScript
   `Number::toString` (shortest round-trip digits, exponent form when the
   decimal exponent is >= 21 or <= -7, `-0` prints `0` including nested in
   arrays and objects, integral values without a fraction; pinned cases
   include `5e-324`, `1e100`, `1e21`, `1e-7`, `2^53+1` clamped to float64);
   non-finite numbers rejected with `non-finite numbers are not JSON-safe`;
   lone surrogates ARE in contract and serialize as `\udXXX` escapes (Python
   escapes them before UTF-8 encoding). Corpus directory
   `artifact/hashing/{bytes,canonical-json,fingerprint,finalization}` per
   the artifact digest's proposal. The `hash` port is an explicit extension
   of the runner contract in both languages and the README, not an ad hoc
   target.
4. **Nondeterminism is injectable.** Artifact ids, audit ids and clocks get
   optional injected generators in TypeScript; defaults unchanged.
5. **Every remaining `localeCompare` goes**, five in artifact and the fixtures
   filesystem/store sources and CLI graph sort, each pinned.
6. **Fixture types carry `jsonSchema`, validators are injected.** The
   TypeScript loader and the Python loader take a JSON Schema validator
   function; neither package depends on Ajv or `jsonschema` (browser safety,
   zero runtime deps). Test suites inject Ajv 2020 (`allErrors: true`) and
   `jsonschema` (Draft202012Validator). Validation scenarios compare the set
   of **flattened leaf instance paths** of failures: Python flattens
   `context`, Ajv reports all errors, aggregate keyword paths (`oneOf`,
   `if`) are excluded from the set by both. The scenario format gains a
   validation expect form `{"invalidPaths": [...]}` (sorted) in the schema
   and both runners. Existing callers untouched.
7. **Scope cut.** Fixture sources: memory and store only in the corpus;
   filesystem source ports with language-local tests; package-resource
   source and the CLI are out. Artifact: records, lineage, verification,
   write protocol over `InMemoryObjectStore` and `FileObjectStore`,
   maintenance with injected ids. OpenDAL adapter is out of this phase.
   TypeScript-only error cases live in language-local tests, never as
   corpus skips.
8. **Python workspace.** `python/` becomes a uv workspace with members
   `store`, `fixtures`, `artifact`. The conformance runner resolves a port
   target by trying `mirk.store.<port>` then `mirk.<port>`.

## Waves

```
Wave 0  S0 atomic API + canonical JSON: TS extraction + scenarios (store/atomic/, artifact/hashing/),
           Python mirk.store.atomic + canonical, SQLite exchange both ways
        R0 the real transaction: TS finalizes an artifact, Python verifies; reverse (evidence)
Wave 1  F1 fixtures TS: jsonSchema + injected validator, code point sorts, scenarios, invalidPaths form
        F2 fixtures Python port (memory, store, filesystem sources)
        A1 artifact TS: injectable ids/clock, code point sorts, addLineage order, scenarios (artifact/)
        A2 artifact Python port over mirk.store + mirk.store.atomic
Wave 2  I2 integration, evidence, receipts, roadmap MR-23/MR-24, cross-lineage code review
```

R0 depends on S0 (atomic interop) and on A1's injectable ids landing first
in TypeScript; run it as soon as those two exist, before A2.

### S0 · Atomic API and canonical JSON — DONE 2026-09-02

Landed with the A1 TypeScript prep (injectable ids and clocks, code point sorts,
`addLineage` order). Evidence:
`docs/evidence/python-port/2026-09-02-atomic-exchange.md`. Cross-lineage code
review is the next step before wave 1 starts.

TypeScript: extract `canonicalJson`, `compareCodePoints` use, and SHA-256
into `packages/store/src/canonical.ts` (re-exported from atomic.ts); scenario
modules `scripts/scenarios/atomic.ts` (ops `getVersioned`, `mutateAtomically`
over the store target, with version tokens compared by shape not value where
they embed the identity UUID — decide the exact rule in the scenario file
header) and `scripts/scenarios/hashing.ts` (ports `["hash"]`). Python:
`mirk.store.canonical` (`canonical_json`, `js_number_to_string`,
`sha256_hex`), `mirk.store.atomic` (request validation with the exact
messages, canonical request digest, receipts, `getVersioned`,
`mutateAtomically` on memory and SQLite, maintaining the bookkeeping rows the
KV facet already writes). Compat test: TypeScript mutates atomically into a
file, Python reads versions and replays the idempotent request and gets the
receipt, and back.

#### S0 rulings (strategist, 2026-09-02)

The plan left four things to "decide in the scenario file header". Decided
here so the three S0 executors share one source.

- **Version tokens are compared by exact value.** The identity prefix
  becomes injectable: `InMemoryKv({ versionIdentity })`,
  `SqliteAdapter({ versionIdentity })` (used only when `_mirk_atomic_identity`
  is first inserted; a file's persisted identity wins), Python
  `InMemoryStore(version_identity=...)`, `SqliteStore(path,
  version_identity=...)`. Defaults unchanged (`m<N>` in memory, a UUID in
  SQLite). Both conformance runners build stores with identity
  `"conformance"`, so a token is `conformance-v<n>` and the corpus pins
  sequence allocation exactly: the sequence starts at 1 per store, every
  `set`/`put` (plain or atomic) consumes one value, `delete`/`remove` consume
  none, a conflict or a rejected request consumes none.
- **Two new port names, `atomic` and `hash`.** `atomic` binds the store
  target (the runner adds `getVersioned` and `mutateAtomically` to the store
  method list). `hash` binds a zero-native pure target in both languages with
  ops `canonicalJson(value) → text`, `sha256Hex(text) → hex over UTF-8`,
  `sha256Bytes(bytes) → {algorithm, value, sizeBytes}`, and
  `canonicalDigest(value) → sha256Hex(canonicalJson(value))`. A1 later adds
  `metadataFingerprint` and `finalizationDigest` to the same target. Python:
  `mirk.store.hash.conformance_target`. Both `BACKEND_PORTS` lists and the
  README's port vocabulary grow by these two names.
- **Wrapper expansion for the `hash` target only**, mirroring how the vector
  target gets `Float32Array`: in args, an object with exactly one key among
  `$num` (parse this decimal text as a float64: `-0`, `NaN`, `Infinity`,
  `9007199254740993`), `$codepoints` (build a string from these code points,
  lone surrogates allowed), `$b64` (raw bytes), `$utf8` (bytes of this
  string) is replaced, recursively through arrays and objects, before
  dispatch. Results are strings and hex, so the expect side needs no
  wrapper.
- **Nested corpus directories.** Scenario ids allow two or more segments
  (`store/atomic/<name>`, `artifact/hashing/canonical-json/<name>`). The
  first segment is the generator's clear-and-count unit; `artifact` joins the
  generated directory list in the generator and in both replay suites.
- **Python result shapes are plain dicts with the TypeScript key spelling**
  (`status`, `requestDigest`, `versions: [{target, version}]`, `outcome`,
  `condition`, `observed`, `key`, `expectedRequestDigest`,
  `receivedRequestDigest`); `getVersioned` returns `{"value", "version"}` or
  `None`. Rejections raise `AtomicMutationRejectedError(code, message)` whose
  `str()` is the exact TypeScript message. TypeScript-only rejections
  (sparse arrays, symbol keys, `undefined`, class instances, cyclic values)
  live in `packages/store/src/canonical.test.ts`, never in the corpus.

### R0 · The real transaction

Evidence file `docs/evidence/python-port/<date>-artifact-handshake.md` with
commands and output. This is the phase's first acceptance proof; nothing
in wave 1 A2 starts until it has run at least one direction.

### F1 / F2 · fixtures

As ruled above. F1 scenario module `scripts/scenarios/fixtures.ts` covering
the digest's 44 pure scenarios over the memory source plus store-source
scenarios seeded via `put` plus `invalidPaths` validation scenarios. Corpus
directory `fixtures/`. F2: `python/fixtures` (`mirk-fixtures`, depends on
`mirk-store` only), registry, define type, layering with the exact precedence
and merge semantics, keyed maps, explain, refs, memory/store/filesystem
sources, `conformance_target`. Changeset minor for `@mirk/fixtures`.

### A1 / A2 · artifact

A1 (TypeScript prep DONE 2026-09-02 with S0: `auditIdFactory`,
`leaseIdFactory` on the store repository, three artifact `localeCompare`
sites, `addLineage` order; the two fixtures sites belong to F1): remaining is
the scenario module `scripts/scenarios/artifact.ts` over `InMemoryArtifactRepository` +
`InMemoryObjectStore` + the memory/sqlite store; bytes as base64. Corpus
directory `artifact/`. A2: `python/artifact` (`mirk-artifact`, depends on
`mirk-store`): types, `InMemoryObjectStore`, `FileObjectStore`, repository,
coordinator, verification, maintenance, `conformance_target`. Cross-language
test is R0 promoted into the suite.

### I2 · integration

Regenerate, both suites green with zero skips and matching per-directory
counts, evidence, receipts record the new directories, roadmap rows MR-23
(fixtures Python) and MR-24 (artifact Python), CLAUDE.md workspace commands,
cross-lineage code review before merge.

## Out of scope, named

Fixtures CLI and package-resource source; OpenDAL adapter (own item after
this phase); statements; migrate; PyPI publication (registry decision still
open); the libSQL vector probe (MR-22b).
