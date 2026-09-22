# 2026-09-02 — atomic mutation exchange, TypeScript ⇄ Python (phase 2, wave 0 / S0)

The atomic mutation API (`getVersioned`, `mutateAtomically`, receipts, canonical request
digests) runs in Python over memory and SQLite, and a SQLite file written by one language is
mutated and replayed by the other. This is the prerequisite the artifact port stands on.

## What ran

Four executors in one checkout, disjoint files, integrator regenerated the corpus once.
Gates at the integration commit:

```
pnpm conformance:gen          246 scenarios (store 106, artifact 42, search 40, graph 29, vector 29)
pnpm conformance:current      corpus is current
pnpm -r typecheck             pass
pnpm test                     pass (store 846, artifact 54, statements 10, ...; store-postgres skipped: no server)
uv run pytest -q              851 passed; conformance executed: 492 runs [graph=58, hash=84, search=80, store=212, vector=58]; memory=246, sqlite=246; zero skips
uv run pyright / ruff check / ruff format --check   clean
```

## The exchange (`python/store/tests/test_sqlite_compat.py`)

`test_atomic_mutation_round_trips_between_the_two_languages`, real file on disk, real
`packages/store/dist` under Node:

1. TypeScript opens the file with `versionIdentity: "ts"`, does a plain `set`, then
   `mutateAtomically` with a `missing` condition and a `version` condition, operations
   set/put/delete/remove, idempotency key `k1` with an outcome.
2. Python opens the same file: `getVersioned` reads `ts-v4` and `ts-v5`; replaying `k1`
   returns `replayed` with a result identical to TypeScript's applied result; a different
   request under `k1` returns `idempotency-conflict` whose `expectedRequestDigest` equals
   TypeScript's digest: `274228f8fb2bd886e25e9e40f4c5286a0f21e5b56b279a196080e1ded6c70928`.
3. Python applies its own mutation under `k2`; the tokens continue the file's `ts-v…`
   sequence (file identity wins over the constructor's).
4. TypeScript reopens, reads the same tokens, replays `k2` to `replayed` with Python's
   versions and outcome, and conflicts on a different `k2` request against Python's digest.

`test_request_digests_match_the_real_typescript`: seven requests digested by
`validateAtomicRequest` from `dist/atomic.js` and by `mirk.store.atomic`, equal strings in
every case (nested `-0`, integral float vs int, condition order, idempotency key excluded,
a key whose UTF-16 and code point orders differ).

`test_plain_writes_carry_version_tokens_across_languages`: plain `set`/`put` in either
language mints tokens the other reads.

## Hashing corpus

`conformance/artifact/hashing/{canonical-json,bytes}`: every probed digest in
`docs/python-port/digests/artifact.md` §2 and §13 appears verbatim in the generated corpus
and is reproduced by `mirk.store.canonical` (`python/store/tests/test_canonical.py`, 60
tests). No divergence was found in either language on the first run.

## Findings along the way

- `InMemoryArtifactRepository.acquireObjectLease`/`renewObjectLease` ignored the injected
  `now` and called `Date.now()`; the digest's §10 table had it as injectable. Fixed with a
  regression test (`packages/artifact/test/injectable.test.ts`).
- Root `pnpm test` raced: three store tests rebuild `dist` (`rm -rf dist && tsup`) and pnpm's
  recursive run let dependents collect against a half-built `dist`. The root script now runs
  `pnpm -r --workspace-concurrency=1 test`.
- `compareCodePoints` was only reachable outside the package as the deprecated
  `compareCodePoint` alias on the atomic subpath; it is now exported from the root and
  `@mirk/artifact` imports it there.
