# 2026-09-02 — phase 2 wave 0 code review, codex gpt-5.6-luna (xhigh), fresh context

Reviewed commit `d7b3170`. Findings and their disposition, folded into the
follow-up commit the same day. Guards landed first (corpus scenarios generated
to scratch and replayed in Python to red), then the fixes.

## Findings

1. **High — Python persistence kept exact integers above 2^53.** `filter.py`
   `normalize_json_numbers` preserved a Python `int` where TypeScript stores
   the nearest double. Real: `set("n", 9007199254740993)` read back
   `…993` in Python, `…992` in TypeScript from the same file. **Fixed:** ints
   beyond 2^53 clamp through `float`. Cannot be a corpus case (TypeScript's
   parser rounds the literal before generation), so guarded in
   `test_memory_store.py` and `test_sqlite_store.py`; the spec records why.
2. **High — lone surrogates failed in atomic storage.** `target_key` counted
   UTF-16 units by strict-encoding the string (raises on a lone surrogate),
   and `dumps_json` emitted the surrogate raw so SQLite refused the row where
   TypeScript writes `\udc00`. **Fixed:** units counted without encoding;
   `dumps_json` shares `escape_lone_surrogates` with the canonical encoder.
   Guarded by `store/lone-surrogate-values-are-storable` and
   `store/atomic/lone-surrogate-values`. Writing those guards found a
   TypeScript divergence the review did not: a lone surrogate in an
   IDENTIFIER or a filter comparand is bound as SQLite TEXT and better-sqlite3
   replaces it with U+FFFD while the memory backend keeps it. Ruled outside
   the corpus for identifiers and comparands (spec, "Known divergence").
3. **High — `$codepoints` wrapper did not join surrogate pairs; `sha256Hex`
   raised on a lone surrogate.** **Fixed:** the wrapper builds the string
   through UTF-16 so a high+low pair is one astral character as in
   JavaScript; `sha256_hex` encodes the way `TextEncoder` does (lone surrogate
   → U+FFFD). Guarded by `artifact/hashing/canonical-json/surrogate-pair-from-code-units`
   and `artifact/hashing/bytes/sha256-hex-lone-surrogate`.
4. **Medium — the "a conflict consumes no sequence value" ruling was false
   for lazy migration** of token-less legacy rows. Both languages behave the
   same. **Fixed the ruling text** in `plan-phase2.md`; no code change.
5. **Medium — the SQLite rollback test was vacuous** (the condition failed
   before any operation ran). **Fixed:** a trigger aborts the 101st write, so
   a hundred operations are undone; keys, version rows and the sequence are
   all asserted restored.
6. **Low — `resolve_atomic_limits` messages for non-JSON inputs differ**
   (`{}` vs `[object Object]`). Outside the JSON request contract; not
   changed. Recorded here so nobody re-finds it.

## Criteria the reviewer would change

- Corpus cases for `2^53+1`, `1e21`, lone surrogates, surrogate-pair wrappers,
  `sha256Hex` over a lone surrogate: done, except `2^53+1` (see finding 1).
- State whether TextEncoder replacement applies to raw hash text and make
  storage share the surrogate policy: done (ruled and implemented).
- Lazy-version ruling: reworded.
- Rollback test: replaced.
- `artifact-opendal`'s `localeCompare`: stays deferred with the OpenDAL
  adapter (ruling 7); noted.
- Changeset "backward compatible" wording: corrected to name the observable
  ordering and error-precedence changes.

## What the reviewer found fine

Number formatter edge cases, astral target prefixes, corpus currency, the
two-direction exchange, and the artifact changes as described.
