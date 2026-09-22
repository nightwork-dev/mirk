# mirk-store

The Python port of `@mirk/store`: substrate-agnostic key-value and collection
storage primitives: the KV, collection, vector, search, and graph ports over two
backends, an in-memory reference and SQLite.

The SQLite adapter opens files the TypeScript adapter wrote and writes files it
can read. Same tables, same pragmas, same JSON encoding, and the same atomic
bookkeeping rows on every write.

## Install

```bash
uv add mirk-store
```

The import package is `mirk.store`, inside the shared `mirk` namespace. The unrelated `mirk`
distribution on PyPI uses the same top-level name, so do not install it in the same environment.

Zero runtime dependencies. Every port, the vector one included, needs nothing
beyond the standard library.

## Namespace package

`mirk` is a PEP 420 namespace package. There is no `src/mirk/__init__.py`, so a
later `mirk-fixtures` distribution can install `mirk.fixtures` beside
`mirk.store` the way the npm `@mirk/*` scope works. Do not add one.

## Use

```python
from mirk.store import InMemoryStore, SqliteStore, namespace_store

store = SqliteStore("data.db")
store.set("greeting", {"hello": "world"})
store.put("things", {"id": "t1", "weight": 2})
store.list("things", {"sortBy": "weight", "sortDir": "desc"})
store.close()
```

Method names keep the TypeScript camelCase spelling (`getById`, `listWhereIn`)
so a corpus `op` string dispatches identically in both languages.

## Threads and transactions

One connection per thread; sync by design. `SqliteStore` is thread-affine, the
way `sqlite3` opens a connection by default and the way the TypeScript adapter's
single-threaded model works. A store used from a second thread raises
`sqlite3.ProgrammingError`. Build a second store for a second thread.

The store owns transaction semantics on whatever connection it is given. Every
write runs inside an explicit `BEGIN IMMEDIATE`, so a connection you supply is
switched to `isolation_level = None` (SQLite autocommit). That commits any
transaction you left pending on it.

```python
connection = sqlite3.connect("data.db")
store = SqliteStore("data.db", connection=connection)  # takes over autocommit
```

## File layout and schema version

A SQLite file carries a table registry, `_mirk_tables(kind, name, table_name)`,
that maps a logical name to its physical table. `kind` is `collection` or
`search`. The physical name is still derived from the logical one, sanitized and
hashed, but that derived name is only the first candidate: when a different
logical name already holds it, the next candidate appends `_2`, `_3`, and so on,
past every candidate another name holds or an unregistered table already sits on.
Two collections whose names sanitize and hash alike therefore get two tables
instead of silently sharing one, and a stray table is never absorbed by a
suffixed candidate. The FTS index for a search collection is named
after its docs table, so one registry row governs both.

A file written before the registry existed keeps working. The first open records
the table it already has under its logical name, in place, with no rewrite.

`_mirk_meta` holds `schema_version`, currently `2`. Opening a file whose version
is higher than this adapter understands raises rather than reading it by rules
that no longer apply. The TypeScript adapter uses the same registry, the same
candidate sequence, and the same version, so both languages resolve a shared file
to the same tables. When two connections race to register the same new logical
name, the loser's `_mirk_tables` insert raises a constraint violation; both
languages catch it and restart resolution, up to five attempts, so the loser
ends up reading the winner's row as a registry hit instead of surfacing the
error from an ordinary write.

## The contract

The corpus at `conformance/` in the repository root is the contract. Both the
TypeScript suite and this package replay every scenario against every backend
they implement. A behavior that is not in the corpus is not contractual, and a
behavior that differs between backends is a bug in one of them.

## Known differences from TypeScript

These are outcomes a user of both languages can actually hit. Where the
contract picked a side, the TypeScript side listed here is the one that
changed to match; where it says "not pinned," both languages may keep
differing.

- **Mutation after `put`/`get` is undefined.** The Python in-memory store
  copies records on write and on read; the TypeScript in-memory store hands
  out live references. A consumer that mutates an object after `put`, or
  mutates a value returned from `get`/`list`, gets different results by
  language today. Do not rely on it either way.
- **Integers above 2^53** are out of the shared contract: a Python `int`
  beyond that range is stored as its nearest float64, matching how numbers
  round-trip through the TypeScript adapter's JSON. Not pinned in the corpus.
- **`NaN` and infinite floats are rejected**, not converted. Python's encoder
  raises rather than silently writing `null` (which is what TypeScript's
  `JSON.stringify` does with those values).
- **Lone surrogates** (an unpaired UTF-16 code unit) are contractual as
  stored VALUES on both languages, escaped the same way in JSON. They are not
  contractual as identifiers: a key, record id, collection name, or filter
  value containing one is bound as SQLite TEXT. Python's `sqlite3` refuses to
  encode it; TypeScript's better-sqlite3 silently replaces it with U+FFFD.
- **`keys()` ordering, `count` with `limit`/`offset`, negative `limit`,
  `where`/`listWhereIn` on non-scalar values, and boolean vs. `1`
  distinguishing** all had a TypeScript backend disagree with itself
  (memory vs. SQLite) before this port; the corpus now pins one answer for
  both languages and both backends: `keys()` sorts by code point; `count`
  ignores `sortBy`/`limit`/`offset`; a negative `limit` returns nothing;
  `where`/`listWhereIn` on an object or array value throws `Store filters
  only support JSON scalar values.`; and `where {v: true}` never matches a
  stored `1`.
- **Sort ties** land in insertion order on both backends; SQLite achieves
  this with `rowid` as the final `ORDER BY` key, which is equivalent to
  insertion order for every observable case.
- **Mixed number/string values in one sort field** are unspecified — not
  pinned in the corpus, and JavaScript's coercion and SQLite's type ranking
  can disagree. Don't sort a field holding both types and expect a
  particular order.
- **Search tokenization diverges deliberately and is not fixed.** The SQLite
  FTS5 tokenizer strips diacritics (`café` indexes as `cafe`); the in-memory
  tokenizer keeps them, in both languages. No document mixing the two is in
  the corpus. Don't compare indexed diacritics across backends.
- **The vector facet has no accelerated path.** `SqliteAdapter.vector` always
  computes exact float64 cosine similarity; there is no `sqlite-vec`
  extension to install and no `vec` extra. `meta.accelerated` is always
  `false`.
- **Physical table naming can collide only in principle, not in practice.**
  Two collection or search names that sanitize and hash to the same physical
  name still get two distinct tables: the registry described above appends
  `_2`, `_3`, and so on for a name that would otherwise collide.

## Adding a port

The conformance runner resolves a scenario's port to a target by convention, so
a port author never edits `src/mirk/store/conformance/runner.py`. The names
`store`, `kv` and `collection` mean the backend store itself. Any other port
name `p` is resolved by importing `mirk.store.<p>` and calling its module-level
factory:

```python
def conformance_target(backend: str, connection: object) -> object: ...
```

`backend` is `"memory"` or `"sqlite"`. `connection` is that backend's open store
handle, so a SQLite facet shares the connection the runner already opened
instead of opening a second one against the same file. A missing module or a
missing factory makes the scenario a recorded skip, counted per port in the test
summary. `ALLOWED_SKIPPED_PORTS` in `tests/test_conformance.py` lists the ports
that may still be missing; any other skip is a failure.

`tests/test_sqlite_compat.py` exports `run_node_script` for cross-language
tests: hand it ESM source and argv, get back the JSON its last stdout line
printed.

## Tests

```bash
uv sync --group dev
uv run pytest -q
uv run pyright
uv run ruff check .
```

The cross-language tests need `node` and a built `packages/store/dist`. Build it
with `pnpm --filter @mirk/store build` from the repository root.
