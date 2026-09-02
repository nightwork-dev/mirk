# Python port phase 1 — both runners green on the full corpus

Date: 2026-09-02. Task I1 (wave 2) of
[`../../python-port/plan-phase1.md`](../../python-port/plan-phase1.md).

Everything below is pasted from a run at the tree recorded in this file. Commands
run from the repository root unless a `cd` is shown.

## 1 · The corpus both languages replay

```
$ pnpm conformance:current

graph: 29 scenarios
search: 39 scenarios
store: 64 scenarios
vector: 29 scenarios
total: 161 scenarios -> /var/folders/.../mirk-conformance-roLplv
conformance corpus is current.
```

161 scenarios. The gate regenerates into a temporary tree and diffs against
`conformance/`; it never writes there, so it cannot launder a hand edit by
overwriting it.

## 2 · Executed counts, side by side

Both runners execute every scenario against both of their backends. Neither has a
skip path: the TypeScript replay fails a scenario whose ports it cannot bind
rather than skipping it, and `ALLOWED_SKIPPED_PORTS` on the Python side is empty,
so any skip fails the suite.

| Port directory | Scenarios | TypeScript executed | Python executed |
| -------------- | --------- | ------------------- | --------------- |
| store          | 64        | 128                 | 128             |
| search         | 39        | 78                  | 78              |
| graph          | 29        | 58                  | 58              |
| vector         | 29        | 58                  | 58              |
| **total**      | **161**   | **322**             | **322**         |

**The two runners execute the same scenarios the same number of times, per port,
on both backends. The counts match exactly.**

Python prints its own summary:

```
$ cd python/store && uv run pytest -q

conformance executed: 322 runs by port [graph=58, search=78, store=128, vector=58]
conformance executed by backend: memory=161, sqlite=161
518 passed in 1.76s
```

TypeScript does not print a summary, so the per-directory counts come from the
replay itself rather than from the corpus tree. `src/conformance.test.ts` names
each replay `<backend> <scenario id>`, one test per (backend, scenario):

```
$ pnpm --filter @mirk/store exec vitest run src/conformance.test.ts --reporter=json

by backend+dir: {"memory graph":29,"memory search":39,"memory store":64,"memory vector":29,
                 "sqlite graph":29,"sqlite search":39,"sqlite store":64,"sqlite vector":29}
by port: {"graph":58,"search":78,"store":128,"vector":58} total: 322
```

Those numbers are counted from passing tests, not from `readdir`, so a scenario
that failed to bind would not be counted. The suite's `afterAll` guard
independently asserts that every corpus directory present executed at least once
on every backend, which is what keeps a presence-gated loop from asserting
nothing against an empty corpus.

## 3 · The rest of the gates

```
$ pnpm -r typecheck
packages/artifact-opendal typecheck: Done
packages/store-libsql typecheck: Done
packages/migrate typecheck: Done
packages/surreal typecheck: Done

$ pnpm test
packages/store test:            Tests  652 passed (652)
packages/artifact test:         Tests  38 passed (38)
packages/fixtures test:         Tests  45 passed (45)
packages/store-markdown test:   Tests  5 passed (5)
packages/store-postgres test:   Tests  8 skipped (8)      # needs a live PostgreSQL
packages/statements test:       Tests  10 passed (10)
packages/migrate test:          Tests  12 passed (12)
packages/artifact-opendal test: Tests  11 passed (11)
packages/surreal test:          Tests  35 passed (35)
packages/store-libsql test:     Tests  22 passed (22)
packages/surreal test:          Tests  1 passed (1)       # browser (chromium)

$ cd python/store && uv run pyright
0 errors, 0 warnings, 0 informations

$ cd python/store && uv run ruff check .
All checks passed!
```

## 4 · Falsification — the corpus can go red

Green is only evidence if red is reachable. Each break below was made, run, and
reverted exactly; `git diff --stat` after each revert showed no trace of it.

### 4a · Python

Two independent breaks, both in the memory path, both caught on both backends
where the code is shared:

1. `python/store/src/mirk/store/memory.py:62` — `sorted(self._kv.keys())` →
   `sorted(self._kv.keys(), reverse=True)`.
2. `python/store/src/mirk/store/vector.py:209` — the id tie-break
   `(-row["score"], row["id"])` → `(-row["score"], [-ord(c) for c in row["id"]])`,
   i.e. ties resolved in descending id order.

```
$ cd python/store && uv run pytest -q tests/test_conformance.py

FAILED tests/test_conformance.py::test_scenario[store/kv-keys-all-memory]
FAILED tests/test_conformance.py::test_scenario[store/kv-keys-astral-code-point-order-memory]
FAILED tests/test_conformance.py::test_scenario[store/kv-keys-code-point-order-memory]
FAILED tests/test_conformance.py::test_scenario[store/kv-keys-empty-prefix-memory]
FAILED tests/test_conformance.py::test_scenario[store/kv-keys-prefix-is-literal-memory]
FAILED tests/test_conformance.py::test_scenario[store/kv-keys-prefix-memory]
FAILED tests/test_conformance.py::test_scenario[store/kv-keys-unicode-prefix-memory]
FAILED tests/test_conformance.py::test_scenario[vector/tie-break-astral-id-memory]
FAILED tests/test_conformance.py::test_scenario[vector/tie-break-astral-id-sqlite]
FAILED tests/test_conformance.py::test_scenario[vector/tie-break-by-id-memory]
FAILED tests/test_conformance.py::test_scenario[vector/tie-break-by-id-sqlite]
FAILED tests/test_conformance.py::test_scenario[vector/zero-query-scores-zero-in-id-order-memory]
FAILED tests/test_conformance.py::test_scenario[vector/zero-query-scores-zero-in-id-order-sqlite]
13 failed, 317 passed in 0.21s
```

The vector breaks fail on **sqlite** as well as memory, because the SQLite vector
facet sorts through the same comparator. After reverting both files:
`518 passed`.

### 4b · TypeScript

`packages/store/src/order.ts` — `compareCodePoints` inverted in both return
statements, so code point order runs backwards.

```
$ pnpm --filter @mirk/store test
Test Files  6 failed | 5 passed (11)
      Tests  75 failed | 575 passed (650)
```

56 of those failures are corpus replays, spread across every port and both
backends:

```
memory/sqlite graph/astral-node-id-sort
memory/sqlite graph/frontier-batched-edge-filter
memory/sqlite graph/frontier-batched-same-as-traverse-both
memory/sqlite graph/frontier-batched-same-as-traverse-edge-types
memory/sqlite graph/frontier-batched-same-as-traverse-in
memory/sqlite graph/frontier-batched-same-as-traverse-self-loop
memory/sqlite graph/frontier-batched-structural-field-wins
memory/sqlite graph/traverse-chain-both-directions
memory/sqlite graph/traverse-cycle-closes
memory/sqlite graph/traverse-cycle-terminates
memory/sqlite graph/traverse-depth-one
memory/sqlite graph/traverse-depth-two
memory/sqlite graph/traverse-direction-in
memory/sqlite graph/traverse-edge-filter
memory/sqlite graph/traverse-edge-types
memory/sqlite graph/traverse-self-loop
memory/sqlite vector/tie-break-astral-id
memory/sqlite vector/tie-break-by-id
memory/sqlite vector/zero-query-scores-zero-in-id-order
memory        search/default-limit-is-ten
memory        search/filter-sort-and-offset-are-ignored
memory        search/limit-caps-results
memory        search/meta-filter-applies-before-limit
memory        search/meta-filter-narrows-results
memory        search/meta-round-trips
memory        search/text-and-fields-text-coexist
memory        search/tie-break-astral-id
memory        search/tie-break-by-id
memory        store/collection-sort-by-astral-id
memory        store/kv-keys-all
memory        store/kv-keys-astral-code-point-order
memory        store/kv-keys-code-point-order
memory        store/kv-keys-empty-prefix
memory        store/kv-keys-prefix-is-literal
memory        store/kv-keys-prefix
memory        store/kv-keys-unicode-prefix
memory        store/sort-strings-are-case-sensitive
```

The `store/*` and `search/*` failures are memory-only because SQLite gets that
order from `ORDER BY` under BINARY collation rather than from the comparator —
which is the agreement the comparator exists to produce. After reverting
`order.ts`: `650 passed`.

### 4c · The receipt gate

The freshness gate is wired into `release:receipt`. Tampering with one committed
scenario's expectation makes the receipt refuse:

```
$ node scripts/verify-package-release.mjs --package @mirk/store --no-receipt
release:verify: @mirk/store: conformance corpus is not current; refusing receipt.
Command failed: pnpm run conformance:current
conformance corpus drifts from the TypeScript reference:
  changed  conformance/store/kv-keys-all.json
run `pnpm conformance:gen` and review the diff.

$ echo $?
1
```

The scenario file was restored and `pnpm conformance:current` returned to
`conformance corpus is current.`

## 5 · What the receipt now records

`pnpm release:receipt` runs `pnpm conformance:current` before the package hooks
and fails the receipt when the corpus is stale, when the gate errors, or when the
corpus holds zero scenarios. The counts land in the receipt JSON:

```json
"conformance": {
  "total": 161,
  "byDirectory": { "graph": 29, "search": 39, "store": 64, "vector": 29 }
}
```

and as a check entry alongside the existing hooks:

```
conformance-current -> passed | 161 scenarios current (graph=29, search=39, store=64, vector=29)
test                -> passed | 652 executed (652 passed, 0 failed), 0 skipped, 0 todo of 652 total
```

The gate runs once per invocation and is shared across packages under `--all`:
corpus freshness is a property of the tree the receipt attests to, not of one
package. `--skip-conformance` exists for the same reason the other `--skip-*`
flags do, and records a `skipped` check rather than a silent omission.

## 6 · What this evidence does not cover

Green here proves the two implementations agree **on the corpus**. It does not
prove they agree everywhere, and it cannot detect a misreading both share. Three
specific gaps are known and named:

- **The vec0 acceleration path is dead in both languages.** See
  [`2026-09-02-vec0-branch-dead.md`](2026-09-02-vec0-branch-dead.md). Every
  SQLite vector result in this run came from the exact JS/Python cosine path, so
  no number above is evidence about vec0.
- Values outside JSON — `undefined`, `Date`, `NaN`, infinities, integers above
  2^53 — are out of contract by decision and live in language-local unit tests.
- bm25 scores are not contract. Search scenarios assert ids and `meta`, never
  scores.
