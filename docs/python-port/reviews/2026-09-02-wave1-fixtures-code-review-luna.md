# 2026-09-02 — phase 2 wave 1 (fixtures) code review, codex gpt-5.6-luna (xhigh), fresh context

Reviewed `d589e19`, which was amended to `df61c43` while the review ran (the
integrator had committed an executor's half-applied change; see the
`commit-under-live-executor` entry in the studio failure log). Findings 1 and
7 describe that intermediate state and do not exist at `df61c43`. The rest
were probed by the reviewer against the real tree and are dispositioned here;
the fixes landed in the follow-up commit with guards that went red first.

## Fixed

- **4 (high) — dropping `not`/`oneOf` aggregate errors let invalid documents
  validate clean.** Both adapters dropped every aggregate keyword error, so
  `{not:{const:"bad"}}` on `"bad"` and an overlapping `oneOf` produced no
  issues and `ok: true`. The Python test locked the hole. Rule changed in
  `conformance/README.md`: an aggregate error is dropped only when a
  non-aggregate failure exists at the same or a deeper path; otherwise it is
  kept at its own path. Corpus scenarios added.
- **3 (high) — Python's `json.loads` disagrees with `JSON.parse`** on
  `NaN`/`Infinity` (accepted vs rejected) and integers above 2^53 (exact vs
  float64). Fixed in the Python loader with unit tests. Not a corpus case:
  the parse failure's message is host text.
- **11 (medium) — Python `invalidPaths` comparator laxer than TypeScript**
  (`ok: false` with no diagnostics, non-boolean `ok`). Matched.
- **10 (medium) — TypeScript runner silently chose among conflicting
  non-store ports** where Python raises. Now throws.
- **12 (medium) — filesystem edge cases**: invalid UTF-8 leaked
  `UnicodeDecodeError` in Python (TypeScript substitutes U+FFFD); a broken
  symlink pointing outside the root was `source-path-escape` in Python and
  `source-read-failed` in TypeScript. Python aligned, both pinned.
- **16 (low) — Python normalizer returned `nan`** where TypeScript's yields
  `null`. Mirrored.
- **15 (low) — CLI human `list` output used default `.sort()`** (UTF-16 code
  unit order). Now `compareCodePoints`, with a regression case.
- **17 (low) — vacuous Python tests**: the materialization-cache test had no
  hook; the `purpose` test observed nothing; the `not` test locked finding 4.
  Rewritten or deleted.
- **2 (high as worded, docs in substance) — "zero runtime dependencies"**
  overclaimed: `mirk-fixtures` depends on `mirk-store` by design (plan, F1/F2).
  README now says no third-party dependencies and names the install pull. A
  clean-venv install must supply both wheels until a registry exists, which
  the evidence file's transcript shows.
- **13 (medium) — seeding is preflight-atomic, not write-atomic**; the README
  said the store is untouched on any failure. Narrowed to validation and load
  failures. A transactional sink is a later item, not a wording fix.
- **14 (low) — refreshing a store-backed loader needs two invalidate calls.**
  Documented.

## Closed on branch `python-port/fixtures-divergences`

All four divergences recorded by this review are fixed, each with a guard that
was red on the code before it.

- **5 — `contains`.** Ajv emitted per-item branch errors while evaluating
  `contains` alongside the array-level error; `jsonschema` emitted only the
  array-level one. `contains` now joins the aggregate set in both adapters:
  errors produced inside a `contains` evaluation are dropped (Ajv: the
  `schemaPath` passes through `/contains`; Python: they never appear) and the
  array-path error is kept under the same rule as the other aggregates.
  `minContains`/`maxContains` land on the array in both. Four corpus scenarios
  under `fixtures/validation/`; rule written into `conformance/README.md`.
- **6 — regex dialects.** `json_schema_validator_factory` now extends
  `Draft202012Validator` with `pattern` and `patternProperties` that compile
  through `mirk.fixtures.ecma_regex.translate`, an ECMAScript-to-Python
  translation covering `\w \W \d \D \b \B \s \S ^ $ .` and refusing, by
  name, what it cannot express. A twenty-pattern table taken from Node
  (`new RegExp(p, "u").test(s)`) is a unit test; three corpus scenarios pin
  `^\w+$` against `"é"`, `\d` against an Arabic-Indic digit, and `\bfoo\b`
  inside `"éfoo"`. `python/fixtures/README.md` records that a caller injecting
  its own engine owns dialect parity.
- **8 — duplicate source ids.** Both loaders now refuse the layer stack at
  construction with `duplicate-source` and the message
  `Duplicate fixture source id "<id>".`. Corpus scenario
  `fixtures/layering/duplicate-source-id-rejected`, plus a test in each
  language; changeset updated, since it is observable.
- **9 — the parsed-document cache key omits the extension.** The matched
  extension is part of the key in both languages. Not a corpus case: it needs a
  second registered parser, which is code. The Python test that called it a
  quirk now asserts the custom parser's output, and has a TypeScript twin.

## Criteria the reviewer would change

- Both replay suites and `conformance:current` green before evidence is
  written: agreed and already the rule; the miss was committing under a live
  executor, now a standing rule.
- An installed-wheel check that installs `mirk-fixtures` alone and inspects
  `METADATA`: agreed for the publication step; the evidence file records the
  local two-wheel install.
- Pin JSON numeric semantics (non-finite, `-0`, 2^53+1) in the corpus: done
  for the store (`store/atomic`, `artifact/hashing`); for the fixtures loader
  the constants cannot be a corpus case because the failure message is host
  text, so they are unit tests in each language.
- Restrict JSON Schema to a tested portable subset: recorded above as the
  rule; a schema-linting step is not built.

## What the reviewer found fine

Layering, built-in merge strategies, map expansion, reference depth and
modes, existing-target symlink containment, store path checks, and every
validator probe except `contains`.
