# 2026-09-01 — Python ↔ TypeScript SQLite handshake

The thinnest real path for the Python port, run before any corpus or package
existed. Commit under test: `e6f6343` (`packages/store/dist` built from it).

## What ran

1. TypeScript `SqliteAdapter` (better-sqlite3, sqlite-vec 0.1.9) opened a fresh
   file with `dimensions: 3` and wrote: one KV value with nested object, null,
   integer and float; two collection items in `things`; one vector in `vecs`;
   one text document in `docs`.
2. Python 3.12.13 (`uv run --python 3.12 --no-project`, stdlib `sqlite3`,
   SQLite 3.50.4) opened the same file, dumped every table's DDL and rows,
   ran an FTS5 `MATCH` against the TypeScript-written index, then inserted a
   KV row and a `things` row through the raw tables.
3. TypeScript reopened the file and read Python's rows through the public port.

## Output (abridged, verbatim values)

TypeScript write step:

```json
{"get":{"hello":"from typescript","n":1,"f":1.5,"nil":null,"nested":{"z":[1,"two"]}},
 "list":[{"id":"t2","kind":"gear","weight":1},{"id":"t1","kind":"gear","weight":2}],
 "vec":[{"id":"v1","score":1}],
 "search":[{"id":"s1","score":0.000001,"meta":{}}]}
```

Python read step:

```
sqlite 3.50.4 python 3.12.13
_kv: ['greeting', '{"hello":"from typescript","n":1,"f":1.5,"nil":null,"nested":{"z":[1,"two"]}}', ...]
c_things_17yznec: ['t1', '{"id":"t1","kind":"gear","weight":2}', ...], ['t2', ...]
vectors: ['vecs', 'v1', <12 bytes: 0000803f0000000000000000>, None]
_vec_meta: ['dimensions', '3']
search_docs_docs_bcq576: ['s1', 'the quick brown fox', None]
FTS5: True | JSON1 builtin: (1,)
fts query on TS-written index: [('s1',)]
python wrote from-python + things/t3
```

TypeScript read-back step:

```json
{"fromPython":{"hello":"from python","n":2},
 "things":[{"id":"t3","kind":"gear","weight":0.5},{"id":"t2","kind":"gear","weight":1},{"id":"t1","kind":"gear","weight":2}],
 "count":3}
```

`sqlite-vec` 0.1.9 from PyPI loads into the uv Python via
`enable_load_extension`; `vec_version()` returns `v0.1.9`, the same version the
TypeScript side wrote with.

## Findings the port must carry

- **Table names carry an FNV-1a hash suffix.** `hashName` in
  `packages/store/src/sql.ts` is 32-bit FNV-1a over UTF-16 code units,
  rendered base36. Reimplemented in Python it reproduces `17yznec`, `1t7xgde`,
  `bcq576` for `things`, `vecs`, `docs`. Iterate UTF-16 code units, not code
  points, or astral-plane collection names diverge.
- **Every TypeScript write maintains atomic bookkeeping rows** in
  `_mirk_atomic_versions`, `_mirk_atomic_sequence`, `_mirk_atomic_identity`.
  The raw Python insert skipped them; TypeScript reads still succeeded, but
  the versioned-read surface for `things/t3` is now wrong. The Python adapter's
  write path must maintain these rows even though the atomic mutation API is
  out of phase 1 scope.
- **Vectors are stored twice**: a `vectors` base table with a Float32
  little-endian blob (`0000803f` = 1.0f) plus a sqlite-vec `vec0` virtual
  table per collection. Python must keep both in step on write.
- **Search** is an FTS5 external-content table with `unicode61` tokenizer kept
  in sync by triggers; a per-collection field list lives in
  `_mirk_search_schema`. Stdlib Python can query it as-is.
- Python's stdlib `sqlite3` had FTS5 and JSON1 compiled in on this machine
  via uv's CPython build. The corpus runner must assert this at start rather
  than assume it.

## Scripts

`write.mjs`, `read.py`, `readback.mjs` lived in the session scratchpad; they
are reproduced in spirit by the handshake test the phase 1 plan adds.
