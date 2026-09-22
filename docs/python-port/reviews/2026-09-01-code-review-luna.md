# 2026-09-01 — code review of phase 1 diff (e6f6343..52d2d2c), codex gpt-5.6-luna (xhigh), fresh context

Verdict was do-not-ship on P1-1, P1-2, P1-4, P1-6, P1-7. Disposition per finding is recorded in the spec's 'Review outcomes' section and in the fix commit that follows.

### P1 — Supplied default `sqlite3` connections cannot write

`SqliteStore` accepts a caller connection at `sqlite.py:155-168`, then performs identity DML without committing at `sqlite.py:204-209`. `_write()` unconditionally issues `BEGIN IMMEDIATE` at `sqlite.py:241-250`.

Repro: `c=sqlite3.connect(":memory:"); s=SqliteStore(":memory:", connection=c); s.set("k", 1)` → `OperationalError: cannot start a transaction within a transaction`.

### P1 — `check_same_thread=False` exposes an unserialized shared connection

The adapter explicitly disables SQLite’s thread guard at `sqlite.py:166-168`, but `_write()` has no mutex at `sqlite.py:241-250`. Concurrent writers fail with `cannot start a transaction within a transaction` and leave partial work.

Repro: run 16 threads doing 100 `put()` calls each; observed 15 transaction errors and only 110/160 rows.

### P1 — Physical collection names are not collision-safe

The sanitizer is safe from direct SQL injection, but the 32-bit FNV hash is not injective: `sqlite.py:49-61`, `sqlite.py:253-257`. The same flaw exists in the TypeScript table naming path `sql.ts:97-105`.

Repro: collections `"%$;**@"` and `"~,~$(*"` both hash to `jqoxun` and sanitize identically; writing the second makes `getById()` on the first return the second record.

### P1 — `listWhereIn` still conflates booleans and numbers in TypeScript SQLite

The Python implementation adds type guards at `sqlite.py:133-149`, while TypeScript’s `buildJsonInWhere()` still compares only `json_extract(...) IN (...)` at `adapters/sqlite.ts:130-155`. Python memory also distinguishes them at `memory.py:116-121`.

Repro: store `{f:true}` and `{f:1}`, then `listWhereIn("c","f",[true])`; Python returns only the boolean row, TypeScript SQLite returns both. The current corpus has no mixed bool/number case.

### P1 — Search backends disagree on ordinary accented text

Memory tokenization uses Python Unicode categories without diacritic folding at `search.py:99-120`, while SQLite uses default FTS5 `unicode61` at `sqlite_search.py:151-160`, which folds diacritics.

Repro: index `"café"` and search `"cafe"`: SQLite returns the document; memory returns `[]`. The implementation documents this divergence, but the specification says backend differences are bugs.

### P1 — Python conformance results confuse valid JSON with exceptions

`run_step()` returns successful values directly at `runner.py:116-124`, while `compare_expect()` treats any returned dictionary with `ok == False` as a thrown outcome at `compare.py:139-155`.

Repro: a stored record `{"id":"x","ok":false,"message":"oops"}` fails a normal value expectation and passes `{"throws":"oops"}`.

### P1 — The generator permits assertion-free scenarios

`defineScenario()` requires only a non-empty step list at `define.ts:86-107`. The generator accepts every step as setup when no marker exists at `gen-conformance.ts:117-127`.

Repro: a scenario containing only `set("k",1)` generates and replays green without checking any result.

### P2 — Capability gating is inconsistent

TypeScript replay checks unsupported ports but never checks `scenario.capabilities` at `conformance.test.ts:158-178`. Python skips unsupported capabilities at `test_conformance.py:58-85`. A `vec0` scenario therefore runs against TypeScript’s fallback path rather than proving vec0 support.

### P2 — Approximate comparison is asymmetric

Python drops an `approxField` when it is absent from the expected row at `compare.py:119-135`. TypeScript correctly reports an unexpected actual field at `compare.ts:107-135`.

Repro: actual `[{"id":"a","score":1}]`, expected `[{"id":"a"}]`, `approxFields:["score"]`; Python passes, TypeScript fails.

### P2 — vec0 write failures do not fall back, and tests skip the path

Search catches vec runtime failures at `sqlite_vector.py:317-332`, but upsert propagates failures from virtual-table creation/synchronization at `sqlite_vector.py:194-223` and `sqlite_vector.py:242-260`. The parity tests simply skip when vec0 cannot load at `test_vector.py:212-220`.

### P2 — Freshness and Python coverage are not wired into CI or receipts

The temporary-tree freshness implementation exists, but CI runs neither `conformance:current` nor Python tests at `ci.yml:46-56`. `release:receipt` also remains unchanged at `package.json:14-20`.

Verdict: **do-not-ship**  
Gating findings: P1-1, P1-2, P1-4, P1-6, P1-7  
Remaining findings: fix before claiming conformance coverage.
