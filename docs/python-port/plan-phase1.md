# Python port, phase 1 — implementation plan

> **For agentic workers:** each task below is a self-contained brief for one
> fresh executor. Read `docs/python-port-spec.md` and the digest named in
> your task before touching code. Checkboxes track completion.

**Goal:** `@mirk/store` phase 1 ports (KV, collection, vector, search, graph)
run in Python over memory and SQLite, proven identical to TypeScript by a
generated conformance corpus both languages replay, including shared SQLite
files.

**Architecture:** Scenario inputs are declared in TypeScript; a generator runs
them against the TypeScript memory reference and SQLite adapter, refuses to
write on disagreement, and emits `conformance/**/*.json`. Both languages
replay the corpus against both backends. The Python package is a
re-implementation over stdlib `sqlite3`, with `sqlite-vec` as an optional
extra.

**Tech stack:** TypeScript (vitest, tsup, tsx), Python 3.12 (uv, hatchling,
pytest, pyright strict, ruff), SQLite with JSON1, FTS5, sqlite-vec 0.1.9.

**Spec:** `docs/python-port-spec.md`. **Evidence so far:**
`docs/evidence/python-port/2026-09-01-handshake.md`. **Digests:**
`docs/python-port/digests/`.

## Global constraints

- Spec rulings override current TypeScript behavior. Fix TypeScript, pin with
  a scenario, never special-case a backend in the corpus.
- No barrels, no `export *`, Standard Schema not zod, ESM with `.js` imports.
- Python: camelCase method names identical to TypeScript so corpus `op`
  strings dispatch by the same name in both languages. Zero runtime deps.
- Tie-break order everywhere is Unicode code point order of the id.
- Every scenario passes on both TypeScript backends at generation time.
- Executors do not commit and do not run `git stash|checkout|reset`; several
  executors share the checkout on disjoint files. The strategist commits per
  wave.
- Scenario authors never write `conformance/`. Verify with
  `pnpm conformance:gen --out <tmp>`; the integrator runs the real generation
  once per wave. Python port authors never edit the conformance runner; they
  expose `conformance_target(backend, connection)` in their own module and
  the runner finds it by convention.
- Scenarios contain JSON values only: no `undefined`, `Date`, `NaN`, or
  infinities, however the digests list them. Those behaviors are outside the
  contract and stay in TypeScript-only unit tests.

## Heritage, identity, cost

- Heritage: pin-derive's generated fixture corpus and freshness gate
  (`docs/python-port/digests/heritage-pin-derive.md`). Copied: generation
  from the reference, `rm -rf` then porcelain check, per-family lower-bound
  guards, exact error strings, `1e-6` for float scores only. Changed: stateful
  step sequences instead of `{spec, expected}`, ports instead of kinds.
- Identity fit: core. Mirk is the substrate; a second language over the same
  files is the substrate doing its job.
- Cost class: like porting pin-derive's replay to a stateful domain plus a
  mechanical port of about 5.6k lines. Nothing unlike what we have shipped.

## Waves

```
Wave 0  T0 generator framework + first store scenarios   P0 Python scaffold + KV/collection + runner
Wave 1  T1 store parity fixes + scenarios                P1 Python vector (memory + sqlite)
        T2 vector/search parity fixes + scenarios        P2 Python search (memory + sqlite)
        T3 graph scenarios                               P3 Python graph
Wave 2  I1 both runners green on full corpus, handshake test hardened, receipts, docs
Review  cross-lineage plan and code review (codex lane), findings folded back
```

Wave 1 tasks depend only on wave 0 landing (the framework's authoring API and
the Python package skeleton). Within a wave every task touches disjoint files.

---

## Wave 0

### T0 · Conformance generator framework (TypeScript)

**Files:** `packages/store/scripts/conformance/{format,define,runner,compare}.ts`,
`packages/store/scripts/conformance/scenarios/store.ts`,
`packages/store/scripts/gen-conformance.ts`,
`packages/store/scripts/check-conformance-current.ts`,
`packages/store/src/conformance.test.ts`, `conformance/README.md`,
`conformance/scenario.schema.json` (generated), `package.json` scripts.

**Produces:** `defineScenario({id, title, ports, capabilities?, steps})` where
authored steps carry no expected values, only markers: `throws: true`,
`{approxFields, tol}`, `{ids: true}`. `executeStep(target, step)`.
`compareExpect(expect, actual): string | null`. Scripts `conformance:gen` and
`conformance:current`. Scenario files at `conformance/<port>/<name>.json`.

**Acceptance:** `pnpm conformance:gen` writes the store scenarios from digest
section 8 items 1–11 and 23–35; `pnpm --filter @mirk/store test` replays them
on memory and sqlite; `pnpm conformance:current` exits 0 after a clean regen
and 1 after any hand edit to a scenario file.

- [ ] framework files, generator, freshness check, replay test, README
- [ ] output of gen, test, typecheck, current pasted in report

### P0 · Python scaffold, KV/collection port, corpus runner

**Files:** `python/store/**` (pyproject, `src/mirk/store/{__init__,types,
filter,memory,sqlite,namespace}.py`, `src/mirk/store/conformance/{loader,
runner,compare}.py`, `tests/`).

**Produces:** `SyncStore` and `SyncStoreInQuery` Protocols; `InMemoryStore`;
`SqliteStore(path, busy_timeout_ms=30000)` opening TypeScript-written files
and maintaining atomic bookkeeping rows; `namespace_store`; `hash_name`;
corpus loader/runner/compare; `tests/test_conformance.py` parametrized over
(backend, scenario) with skips only for unimplemented ports recorded as data;
`tests/test_sqlite_compat.py` running Node against the built dist for the
real cross-language exchange, including a versioned read of a Python-written
item.

**Acceptance:** `uv run pytest -q`, `uv run pyright`, `uv run ruff check .`
green; the corpus replay executes every `store/*` scenario on both backends.

- [ ] package, ports, memory, sqlite, namespace, runner, tests
- [ ] cross-language compat tests pass against `packages/store/dist`

---

## Wave 1

### T1 · Store parity fixes and divergence scenarios (TypeScript)

**Digest:** `docs/python-port/digests/store-kv-collection.md` sections 1–4,
8 items marked `[P]` and `[D]`. **Spec:** rulings table.

**Files:** `packages/store/src/backends/memory.ts`, `packages/store/src/sql.ts`,
`packages/store/src/adapters/sqlite.ts` (KV facet only),
`packages/store/scripts/conformance/scenarios/store.ts` (append),
existing store tests where a fix changes an asserted behavior.

**Changes:** memory `keys()` sorted by code point; memory `count` ignores
sort/limit/offset; memory `limit < 0` returns none; memory `where` and
`listWhereIn` with non-scalar values throw with the SQLite message; SQLite
`where` distinguishes boolean from 0/1 via `json_type`; SQLite ORDER BY adds
`rowid` as the final key; string comparisons in memory sort use code point
order, not `<` on UTF-16 or `localeCompare`. `@mirk/store-libsql` shares
`sql.ts`; run its suite too.

**Scenarios:** one per `[P]` and `[D]` item that uses JSON values (skip
items 15, 17, 18, 19, 20, 55: precision above 2^53, `undefined`, `Date`,
`NaN`, undefined-stripping, undefined where), plus the contract statements in
the spec's rulings section, plus an astral-plane id tie-break scenario.

**Acceptance:** `pnpm conformance:gen` succeeds (memory and sqlite agree on
every new scenario); full `pnpm test` and `pnpm -r typecheck` green.

- [ ] fixes landed with the scenarios that pin them
- [ ] libsql adapter suite still green

### T2 · Vector and search parity fixes and scenarios (TypeScript)

**Digest:** `docs/python-port/digests/store-vector-search.md`.

**Files:** `packages/store/src/vector/memory.ts`,
`packages/store/src/search/memory.ts`,
`packages/store/src/adapters/sqlite.ts` (vector and search facets),
`packages/store/scripts/conformance/scenarios/{vector,search}.ts`.

**Changes:** id tie-breaks by code point in both memory stores; vec0 path
applies `minScore` before `topK` (fetch without SQL limit when `minScore` is
set, or route to the exact path); search memory treats a document as matched
when any field has the term regardless of a zero weight, matching FTS5;
search memory deduplicates query tokens, matching FTS5.

**Scenarios:** vector: upsert/get/has/remove/count, dimension mismatch
message, zero stored vectors excluded from search but present for get/count
(NaN cannot appear in JSON; keep that case in the TypeScript unit test), zero query vector scores all zero in id order, topK default 10,
minScore inclusive, where and whereNot pre-filter, tie-break by id, metadata
absent vs present, byte-identical Float32 round trip (a scenario stores
`[0.1, 0.2, 0.3]` and gets back the float32-rounded values), upsertMany
atomicity on a mid-array mismatch. Search: text vs fields documents, field
list pinned per collection with the exact error, weights validation order,
unknown weight name, tokenizer cases (`v1.2`, `don't`, mixed case, Greek
final sigma, precomposed vs decomposed é, numerals like ² and Ⅷ), OR
semantics, empty query, limit, meta filter applied before limit, ranking with
the `ids` form, meta-filter results with `values` plus `ignoreFields:
["score"]`, zero-weight and duplicate-token scenarios pinning the fixes.

**Acceptance:** generator agrees across backends on all of them; full test
suite and typecheck green.

- [ ] fixes and scenarios landed
- [ ] every search scenario uses `ids` or exact non-score fields, never scores

### T3 · Graph scenarios (TypeScript)

**Source:** `packages/store/src/graph.ts`, `graph.test.ts`, and the
graph/sqlite digest at `docs/python-port/digests/store-graph-sqlite.md`
when present.

**Files:** `packages/store/scripts/conformance/scenarios/graph.ts`,
`packages/store/src/graph.ts` (the terminal sorts use JS `<`, which is
UTF-16 code unit order; change to a code point comparison per the spec, and
pin with an astral-plane node id scenario). The runner already binds a graph
facade over `toAsync(store)`.

**Scenarios:** neighbors out/in/both with dedup, edgeTypes filter, edgeFilter
push-down, full edge record returned untouched; traverse depth 0 and negative
empty, depth 1 direct neighbors, cycle termination, `both` adjacency, nodes
exclude start, sorted nodes and edges, edgeFilter at load; frontier-batched
traversal equals load-once traversal on the same graphs (both ops in one
scenario), frontier field overriding a same-named caller where. Every graph
test assertion becomes a scenario.

**Acceptance:** generator agrees across backends; graph directory guard in
the replay test now fires.

- [ ] scenarios landed and replayed

### P1 · Python vector port

**Digest:** `docs/python-port/digests/store-vector-search.md` section A.
**Files:** `python/store/src/mirk/store/vector.py` (Protocol, `VectorDocument`,
`InMemoryVectorStore`, `cosine_similarity`, `vector_to_bytes`,
`bytes_to_vector`, `is_usable_vector`, `matches_where`),
`python/store/src/mirk/store/sqlite_vector.py` (facet over the same
connection as `SqliteStore`; `vectors` base table, `_vec_meta`, per-collection
vec0 table when the `vec` extra is installed and loadable, exact-cosine path
otherwise; both paths produce identical results), `tests/test_vector.py`.

**Rules:** components rounded to float32 on store (`struct` `<f`), cosine in
float64 with two-sqrt denominator, results by score desc then id code point,
filter before topK, minScore before topK on every path, `metadata` field
name. Expose `conformance_target(backend, connection)` in `vector.py` so the
runner picks up `vector/*` scenarios without edits. Extend
`tests/test_sqlite_compat.py` with a vector exchange: TypeScript writes a
vector, Python asserts the `vectors.vec` blob bytes equal
`struct.pack("<3f", ...)` of the float32-rounded values and that `get`
returns them; Python writes one, TypeScript searches and finds it.

- [ ] memory and sqlite facets, corpus replay of `vector/*` on both

### P2 · Python search port

**Digest:** `docs/python-port/digests/store-vector-search.md` section B.
**Files:** `python/store/src/mirk/store/search.py` (Protocol, tokenizer via
`unicodedata.category` L*/N* runs on `str.lower()`, `sanitize_fts_query`,
field normalization with exact error messages, in-memory bm25 with k1 1.2 b
0.75, query tokens deduplicated, matched if any field has the term),
`python/store/src/mirk/store/sqlite_search.py` (FTS5 external-content
tables, triggers, `_mirk_search_schema`, column naming `f<i>_<hash>`,
`-bm25()` scoring, meta filter after order before limit), `tests/test_search.py`.

**Rules:** `meta` field name; result order score desc then id code point;
cross-backend contract is ranking and set, so search scenarios use `ids` or
`values` with `ignoreFields: ["score"]`. Expose `conformance_target` in
`search.py`; do not edit the runner.

- [ ] memory and sqlite facets, corpus replay of `search/*` on both

### P3 · Python graph module

**Source:** `packages/store/src/graph.ts` and the graph digest.
**Files:** `python/store/src/mirk/store/graph.py` (`neighbors`, `traverse`,
`traverse_frontier_batched` over any `SyncStore`, using `listWhereIn` when
the store has it), `tests/test_graph.py`. The Python port is synchronous; the
corpus graph ops are the same names. Expose `conformance_target` in
`graph.py` returning a facade with `neighbors`, `traverse`,
`traverseFrontierBatched` bound to the backend store; do not edit the runner.

- [ ] module and corpus replay of `graph/*` on both backends

---

## Wave 2

### I1 · Integration, hardening, receipts

- [ ] `pnpm conformance:gen && pnpm test && pnpm -r typecheck` green at root.
- [ ] `cd python/store && uv run pytest -q && uv run pyright && uv run ruff check .` green; `ALLOWED_SKIPPED_PORTS` emptied so any skip fails; per-port executed counts all > 0.
- [ ] Executed scenario counts match between the two runners per port; record both in `docs/evidence/python-port/<date>-phase1-green.md` with the commands and output.
- [ ] Falsification: break the Python memory sort tie-break, run the corpus, record the failing scenario name in the evidence file, revert.
- [ ] `pnpm conformance:current` wired into `release:receipt` so a stale corpus fails a receipt; receipt records the scenario count.
- [ ] Root `README.md` and `docs/roadmap.md` gain one row/paragraph: MR-20 Python port phase 1, status per the roadmap vocabulary. `CLAUDE.md` build section gains the Python commands.
- [ ] Cross-lineage review of the whole diff (codex lane via pi dispatch) with the explicit question "are these the right criteria, and is any of this unnecessary?"; findings folded back before merge.

## Out of scope, named

Atomic mutation API (phase 2; the SQLite bookkeeping rows are maintained
now), coordination, libsql/postgres/surreal adapters in Python, fixtures and
artifact (phase 2 plan), PyPI publication (Verdaccio has no Python side;
decide the registry before phase 2).
