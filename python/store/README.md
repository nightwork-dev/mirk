# mirk-store

The Python port of `@mirk/store`: substrate-agnostic key-value and collection
storage primitives. Phase 1 covers the KV and collection port over two backends,
an in-memory reference and SQLite.

The SQLite adapter opens files the TypeScript adapter wrote and writes files it
can read. Same tables, same pragmas, same JSON encoding, and the same atomic
bookkeeping rows on every write.

## Install

```bash
uv add mirk-store
```

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
to the same tables.

## The contract

The corpus at `conformance/` in the repository root is the contract. Both the
TypeScript suite and this package replay every scenario against every backend
they implement. A behavior that is not in the corpus is not contractual, and a
behavior that differs between backends is a bug in one of them.

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
that may still be missing; the integrator empties it and every skip becomes a
failure.

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
