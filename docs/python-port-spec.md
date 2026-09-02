# Python port of Mirk — specification

Status: draft, 2026-09-01. Owner: mirk. Phase 1 covers `@mirk/store`. Phase 2
(fixtures, artifact) is sketched at the end and gets its own plan.

## What this is for

A Python process must be able to use Mirk storage with the same contract as a
TypeScript process, including opening the same SQLite files. The port is a
re-implementation, not a binding. The thing that makes two implementations one
Mirk is a shared, language-neutral conformance corpus that both run.

## Decisions

1. **Re-implementation in Python, no Rust core.** Mirk is contracts plus
   adapters; a wasm core could carry at most the pure-logic third and every
   adapter would still be host-language I/O. Reconsidered only if a hermetic
   piece becomes compute-bound.
2. **The corpus is the contract.** JSON scenario files under `conformance/`
   at the repo root. The TypeScript suite and the Python suite each replay
   every scenario against every backend they implement. A behavior that is
   not in the corpus is not contractual.
3. **Thinnest real path first.** Before the corpus exists, a Python process
   using stdlib `sqlite3` reads a value that the TypeScript SQLite adapter
   wrote, and the TypeScript adapter reads a value Python wrote. Dated record
   of that run goes in `docs/evidence/`. Only then is the corpus built.
4. **Sync by design carries over.** Python ports are synchronous; an
   `asyncio` wrapper is the `toAsync` equivalent. Embedded SQLite uses the
   stdlib `sqlite3` module. No native install for the base package.
5. **Zero runtime dependencies.** The core package depends only on the
   standard library. (An optional `sqlite-vec` extra was planned and removed
   under MR-22: the vec0 path never executed.)
6. **Fixtures carry a JSON Schema document (phase 2).** Standard Schema and
   Python validators do not interconvert; every existing consumer hand-rolls
   a validate-only object with no emitter. A fixture type will declare its
   shape as a JSON Schema document and each language validates it with its
   own tool. Audit on 2026-09-01 found no consumer using refinements,
   transforms, or coercions.

## Phase 1 scope

Ports: KV, collection (with `listWhereIn`), vector, search, graph traversal.
Backends: in-memory reference and SQLite. Both languages, both backends.

Out of scope for phase 1: atomic mutation, coordination (bounded writer waits
are process-local), namespaces beyond what the corpus needs, libSQL,
PostgreSQL, SurrealDB, OpenDAL, fixtures, artifact, statements, migrate.

## Layout

```
conformance/                    language-neutral corpus (repo root)
  README.md                     format, governance, how to add a scenario
  scenario.schema.json          JSON Schema (draft 2020-12) for scenario files
  store/kv/*.json
  store/collection/*.json
  store/vector/*.json
  store/search/*.json
  store/graph/*.json
python/store/                   the Python package (uv, src layout)
  pyproject.toml                name: mirk-store; requires-python >= 3.12
  src/mirk/store/               ports (Protocols), memory, sqlite, graph
  src/mirk/store/conformance/   corpus loader + runner used by tests
  tests/
packages/store/src/conformance.test.ts   TypeScript replay of the corpus
docs/evidence/python-port/      dated records of real cross-language runs
```

## Scenario format

One file, one scenario, one sequence of operations against fresh stores.
Runners execute the sequence once per backend. Every step's `expect` is
checked before the next step runs.

**The corpus is generated, not authored** (pin-derive's load-bearing lesson).
Scenario inputs (steps without `expect`) are declared in
`packages/store/scripts/gen-conformance.ts`. The generator runs each scenario
against the TypeScript in-memory reference and the TypeScript SQLite adapter,
refuses to write a file when the two disagree, fills in `expect` from the
reference, and writes `conformance/**` with `rm -rf` first. A step declared
`throws` that does not throw fails generation. A freshness check
(`pnpm conformance:current`) regenerates into a temporary directory and
fails on any added, removed, or changed file against the committed
`conformance/`; regenerating in place would overwrite the very edit it is
meant to catch. It runs in CI and before receipts. Scenario authors verify
with `conformance:gen --out <tmp>`; only the integrator writes the real
corpus, so parallel authors never clobber it.
Regenerate after an intentional semantics change and review the diff: a
surprising change in a scenario is a regression, not a refresh.

```json
{
  "id": "collection/sort-missing-field-last",
  "title": "Items missing the sortBy field sort after present values",
  "ports": ["collection"],
  "capabilities": [],
  "steps": [
    { "op": "put", "args": ["c", { "id": "a", "n": 2 }] },
    { "op": "put", "args": ["c", { "id": "b" }] },
    { "op": "put", "args": ["c", { "id": "c", "n": 1 }] },
    { "op": "list", "args": ["c", { "sortBy": "n" }],
      "expect": { "value": [{ "id": "c", "n": 1 }, { "id": "a", "n": 2 }, { "id": "b" }] } }
  ]
}
```

Rules:

- `op` is a port method name as spelled in the TypeScript port. Runners map
  it to their language's spelling. `args` are positional JSON values.
- `expect` forms: `{"value": <json>}` exact deep equality;
  `{"values": [...], "approxFields": ["score"], "tol": 1e-6}` for a list of
  records where the named fields compare within tolerance and everything
  else exactly; `{"ids": [...]}` for ordered result ids only, used where the
  contract fixes ranking but not scores (full-text search);
  `{"throws": "<exact message>"}` when the operation must raise with that
  message. `values` may also carry `ignoreFields` (removed from both sides
  before comparison; used for search scores, which are not contractual while
  ids and meta are). There is no unordered form: the contract fixes order
  everywhere. A step without `expect` is setup.
- `throws` compares the exception's message string exactly. A step marked
  `throws` that returns normally fails; a step not marked `throws` that
  raises fails. Same rule at generation and at replay in both languages.
- Vectors are JSON arrays of numbers. Both languages round components to
  float32 before storing; cosine accumulates in float64 with the two-sqrt
  denominator. Tolerance is `1e-6` and applies to vector scores only.
- Tie-break order everywhere (collection sort, vector results, search
  results, graph nodes and edges) is Unicode code point order of the id. The
  TypeScript in-memory stores currently use `localeCompare`; that changes to
  a code point comparison as part of this work, and the SQLite adapter's
  `BINARY` collation already matches.
- Known TypeScript backend divergences fixed as part of this work, each
  pinned by a scenario: a search field weight of zero unmatched a document in
  memory but not in FTS5; the in-memory bm25 dropped terms whose idf was
  non-positive where FTS5 floors idf at 1e-6. Two suspected divergences were
  disproven by probing (see "Known divergence deliberately outside the
  corpus").

## Rulings on KV and collection divergences (2026-09-01)

Probing both TypeScript backends found these disagreements. The ruling is the
contract; the losing backend is fixed in TypeScript and the scenario pins it.

| Behavior | memory today | SQLite today | Ruling |
| --- | --- | --- | --- |
| `keys()` order | insertion | byte ascending | code point ascending |
| `count` with `limit`/`offset` | applies them | ignores them | `count` ignores `sortBy`, `limit`, `offset` |
| `limit` < 0 | returns all | returns none | returns none |
| `where` with object or array value | `[]` | throws | throws `Store filters only support JSON scalar values.` |
| `listWhereIn` with non-scalar value | `[]` | throws | throws (message already in SQLite) |
| `where {v: true}` vs stored `1` | distinguishes | conflates | distinguishes; SQLite gains a `json_type` check for booleans |
| sort ties | insertion (stable) | rowid (incidental) | insertion order; SQLite adds `rowid` as final `ORDER BY` key |
| mixed number/string in one sort field | JS coercion | SQLite type rank | unspecified; the corpus never pins it |

Contract statements the corpus pins that no test asserted before: `list()`
with no `sortBy` is insertion order; re-`put` of an existing id keeps its
position; remove then re-add moves to the end; `set(k, null)` stores a value
and `has` is the only existence test; `get` returns `null` for both missing
and stored null; `put` returns the object it was given; empty collection name
throws; `where` on a dotted name is one literal top-level key; `where {x:
null}` matches explicit null only; nulls and missing sort last in both
directions; `offset` then `limit` after sort; a `where` on the `listWhereIn`
field is ANDed with the IN. Values are JSON: no `undefined`, no `Date`, no
bigint; `NaN` and infinities are rejected by the Python encoder
(`allow_nan=False`) and become `null` in TypeScript, which the corpus never
exercises. Integers above 2^53 are out of contract.

JSON text written by Python matches JavaScript's `JSON.stringify` where a
SQLite reader can observe the difference: compact separators, non-ASCII
unescaped, and integral floats emitted as integers (`1.0` is written `1`) so
`json_type` reports `integer` on both sides. Insertion key order is preserved
by both languages and is not otherwise contractual. Dates are not a value
type; a consumer stores ISO strings.

The Python in-memory store copies on write and on read. The TypeScript
memory store hands out live references. The corpus cannot observe the
difference, so the contract states it instead: mutating an object after
`put` or mutating a returned record is undefined behavior; consumers that
need it get different results by language and by backend today.

Sort ties on SQLite use `rowid` as the final key. This equals insertion order
for the observable contract: SQLite reuses a rowid only when the maximum row
was deleted, and a re-added item then lands at the end either way.

## Known divergence deliberately outside the corpus

Search tokenization of documents differs by backend: FTS5 `unicode61`
strips diacritics (`café` indexes as `cafe`) while the in-memory tokenizer
keeps them, in both languages. No scenario crosses that line; generation
refuses any that does. Closing it means deciding whether the memory
tokenizer folds diacritics to match the persistent path. That is a
semantics ruling for a later item, not a phase 1 fix.

Lone surrogates (an unpaired UTF-16 code unit in a string) are contractual
as VALUES: canonical JSON escapes them as `\udXXX`, both storage encoders
write them escaped, and the corpus pins them in KV values, record fields,
atomic set/put values and idempotency outcomes. They are outside the corpus
as IDENTIFIERS and FILTER COMPARANDS: KV keys, record ids, collection names,
idempotency keys and `where`/`listWhereIn` values are bound as SQLite TEXT,
and better-sqlite3 replaces the unit with U+FFFD on the way in while the
memory backend keeps it, in TypeScript. Python's `sqlite3` refuses to encode
one at all. Generation refuses any scenario that crosses that line; closing
it means either rejecting such identifiers in every backend or escaping them
in the TEXT columns, a ruling for a later item (2026-09-02, found by the wave
0 guard scenarios).

Integers above 2^53 cannot be pinned in the corpus because TypeScript's
parser rounds the literal before the generator serializes it. The rule (every
number is a float64; a Python `int` beyond 2^53 is stored as its nearest
double) is guarded in `python/store/tests` instead.

Two digest claims were overturned by probing the real backends and are
superseded: FTS5 does not deduplicate query tokens, and the vec0 path's
`topK`-before-`minScore` ordering is unobservable because vec0's distance
order is monotone in the cosine score
(`docs/evidence/python-port/2026-09-01-fts5-bm25-probe.md`).

## Review outcomes (2026-09-01, codex Luna, fresh context)

Folded in: temp-directory freshness check; `ignoreFields`; explicit `throws`
rule; parallel authors never write the corpus; Python runner resolves port
targets by module convention so port authors never edit it; the Node
compatibility tests rebuild `dist` first; skips are counted per port and
fatal at integration; `undefined`, `Date`, and non-finite numbers do not
appear in scenarios because they are outside the JSON contract; Float32
byte identity is asserted by the cross-language test, not by a replay
scenario. Full text: `docs/python-port/reviews/2026-09-01-plan-review-luna.md`.

Code review of the phase 1 diff (same lane, fresh context,
`docs/python-port/reviews/2026-09-01-code-review-luna.md`) returned
do-not-ship on five findings. Fixed: a caller-supplied connection could not
write; the shared connection was thread-unsafe; the Python runner could
mistake a stored record carrying `ok: false` for a thrown outcome; a
scenario with no assertions generated and replayed green; TypeScript
`listWhereIn` on SQLite conflated booleans with numbers; TypeScript replay
ignored capability gating; approximate comparison was asymmetric; vec0 tests
skipped instead of failing when the extension did not load; CI ran neither
the freshness gate nor the Python suite. Deferred as a follow-up item, not a
phase 1 change: physical table names use a 32-bit FNV hash that is not
injective, so two collection names that sanitize identically and collide on
the hash alias one table. That is the TypeScript layout Python must share
for file compatibility; changing it is a layout migration with its own item.
Diacritics: see the known divergence above.

`namespaceStore` is a pure prefixing decorator (unit separator U+001F) and
ports once over the Protocol. `atomic.ts` is portable but phase 2;
`coordination.ts` is process machinery and out of scope.
- `ports` names the ports a scenario touches, from `kv`, `collection`,
  `vector`, `search`, `graph` (`kv` and `collection` are served by one store
  target); a runner skips a scenario whose ports it does not implement and
  reports the skip. `capabilities` gates on
  optional capabilities (`listWhereIn`) the same way.
- Records are JSON. `null` is a value. There is no `undefined`; a TypeScript
  runner strips `undefined` before comparison. Numbers compare as IEEE
  doubles; integers and floats with the same value are equal.
- Strings sort by Unicode code point. The corpus carries a scenario with an
  astral-plane character so a UTF-16 code-unit sort fails it.
- Backends are not selectable per scenario. A behavior that differs between
  memory and SQLite is a bug in one of them, not a corpus option.

## Governance

- Every behavior change to a port lands with a corpus scenario in the same
  commit. A TypeScript-only test for port behavior is a review finding.
- Scenario ids are stable; a scenario is never edited to pass, it is replaced
  under a new id and the old id is listed in `conformance/README.md` as
  retired with the reason.
- Receipts (`pnpm release:receipt`) record the executed scenario count per
  runner. A run that executes zero scenarios is not a receipt.

## Python package

- Distribution `mirk-store` (PyPI `mirk` is an unrelated project). Import
  name `mirk.store` as a PEP 420 namespace package, so later distributions
  `mirk-fixtures` and `mirk-artifact` mirror the npm scope one for one.
  `requires-python >= 3.12`, build backend `hatchling`, managed with `uv`.
  Zero runtime dependencies and no extras.
- The SQLite adapter's write path maintains the atomic bookkeeping rows the
  TypeScript adapter writes (`_mirk_atomic_versions`, `_mirk_atomic_sequence`,
  `_mirk_atomic_identity`) so a shared file stays consistent for the
  TypeScript versioned-read surface, even though the atomic API itself is
  phase 2. See `docs/evidence/python-port/2026-09-01-handshake.md`.
- Dev: `pytest`, `ruff`, `pyright` strict, `jsonschema` (corpus validation
  in tests only).
- Ports are `typing.Protocol` classes mirroring `SyncStore`,
  `SyncStoreInQuery`, `VectorStore`, `SearchStore`. Graph traversal is a
  module of functions over any store satisfying the collection Protocol.
- The SQLite adapter opens files the TypeScript adapter wrote, with identical
  tables, pragmas, and serialization. Byte-level compatibility of stored JSON
  is not required; semantic compatibility is. Vector buffers must be
  byte-identical (Float32 little-endian) so both languages read each other's
  vectors.

## Acceptance proof (phase 1)

1. `docs/evidence/python-port/<date>-handshake.md` records the real
   cross-process file exchange with commands and output.
2. `pnpm test` runs the corpus in TypeScript against memory and SQLite;
   `uv run pytest` in `python/` runs the same corpus against memory and
   SQLite. Both report the scenario count and it is the same number.
3. `pnpm -r typecheck` and `uv run pyright` clean.
4. A deliberately wrong sort tie-break in the Python memory store fails a
   named corpus scenario. Recorded once in evidence, then reverted.

## Cost class

Like porting pin-derive's fixture replay to a stateful domain, plus a
mechanical port of ~5.6k lines of TypeScript. Nothing here is unlike what
we have shipped.

## Phase 2 sketch

- `@mirk/fixtures`: fixture type declares `jsonSchema` (a document). The
  TypeScript loader keeps `schema` (Standard Schema) as optional for typed
  output; validation of authored files runs against the document in both
  languages. Consumers (sigil-chat, someone host) migrate their hand-rolled
  validators to documents plus residual checks.
- `@mirk/artifact`: pure identity, integrity, and lineage logic ports
  directly; hashing must be byte-identical across languages and gets its own
  corpus directory.

## Rulings for the follow-ups (2026-09-02)

### MR-22 · vec0 path: delete

The sqlite-vec branch of the better-sqlite3 vector facet has never executed
(`docs/evidence/python-port/2026-09-02-vec0-branch-dead.md`). Ruling: delete
it in both languages. `SqliteAdapter.vector` keeps the exact float64 cosine
path only, `meta.accelerated` reports `false`, the `forceJsCosine` option is
removed, `sqlite-vec` leaves `@mirk/store`'s peer dependencies and the Python
`vec` extra is removed. The `vectors` base table and `_vec_meta` are unchanged,
so existing files keep working; any `vectors_vec_*` shadow tables in existing
files are inert and left in place (dropping a vec0 virtual table needs the
module loaded, which nothing does any more; a sweep behind a catch would be
the same shape of dead code MR-22 removes). The `accelerated`
field stays in `VectorStoreMeta` because `@mirk/store-libsql` reports its own
native vector path through it; whether that path executes is a separate probe
(`MR-22b`, proposed). The three unit tests that compared the accelerated
adapter against the fallback are deleted, not rewritten: they certified
nothing.

### MR-21 · Collision-safe physical table naming: registry, not hash

Injectivity cannot come from a hash. Ruling: a registry table
`_mirk_tables(kind TEXT, name TEXT, table_name TEXT UNIQUE, PRIMARY KEY
(kind, name))` maps a logical name (`kind` in `collection`, `search`) to its
physical table. Resolution on first use of a logical name in a connection:

1. Registry hit: use the recorded `table_name`.
2. Miss, and the legacy table `<prefix>_<sanitized>_<fnv32>` exists and is not
   claimed by another name in the registry: adopt it, insert the registry row.
   Existing files keep working without a rewrite.
3. Miss otherwise: candidate is the legacy form; while the candidate is claimed
   in the registry by a different name, OR a physical table with that name
   exists unclaimed (a suffixed table is never adopted; only the exact legacy
   name is, in step 2), append `_2`, `_3`, ... Insert the row, create the
   table.

A file gains `_mirk_meta(key TEXT PRIMARY KEY, value TEXT)` with
`schema_version = "2"` when the registry is first created; a reader that finds
a newer version than it understands refuses to open with a clear message.
Search's per-collection docs and FTS tables register under `kind = "search"`
with one row per logical collection; the FTS table name derives from the docs
table name. Both languages implement the same procedure and the corpus gains
scenarios using the reviewed colliding pair (`"%$;**@"` and `"~,~$(*"`, both
`jqoxun`) for collections and for search. The cross-language compat test opens
a legacy file (no registry) from each language and confirms adoption.

### Phase 2 scope

`@mirk/fixtures` and `@mirk/artifact` ports, each with its own digest,
corpus directory, and plan section. Fixture types carry a JSON Schema
document (decision 6 above). Artifact hashing must be byte-identical across
languages and gets a hashing corpus before anything else.
