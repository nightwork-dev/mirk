# 2026-09-02 — fixtures in Python: corpus green and the wheel path

Phase 2 wave 1, F1 + F2. `@mirk/fixtures` gained `jsonSchema` with an injected
validator and code point ordering; `mirk-fixtures` is its Python port; both
replay the new `conformance/fixtures/` directory. Two proofs, in the order they
ran.

## 1. The corpus, both languages, both backends

Generated once by the integrator (`pnpm conformance:gen`):

```
artifact: 44 scenarios
fixtures: 88 scenarios
graph: 29 scenarios
search: 40 scenarios
store: 108 scenarios
vector: 29 scenarios
total: 338 scenarios -> <repo>/conformance
```

`pnpm conformance:current`: `conformance corpus is current.` Only
`conformance/fixtures/` is new; no existing scenario changed.

TypeScript replay (inside `pnpm test`, `@mirk/store` suite): `Tests 1030 passed`.

Python replay, from `python/store`, `uv run pytest -q`:

```
conformance executed: 676 runs by port [fixtures=176, graph=58, hash=88, search=80, store=216, vector=58]
conformance executed by backend: memory=338, sqlite=338
1046 passed in 2.33s
```

`python/fixtures`, `uv run pytest -q`: `179 passed`. pyright, ruff check and
ruff format clean in both members. Zero skips anywhere.

Groups: validation 15, store 14, layering 11, map 10, references 10, matching 9,
merge 7, resolve 6, ref-grammar 3, registry 3.

## 2. The external user's path

The port has no internal consumer (David, 2026-09-02), so the real transaction
is a wheel installed somewhere that cannot see this checkout.

```
cd python && uv build --all-packages --out-dir <scratch>/dist
  Successfully built mirk_store-0.1.0-py3-none-any.whl
  Successfully built mirk_fixtures-0.1.0-py3-none-any.whl
uv venv <scratch>/extvenv
uv pip install <both wheels> jsonschema
cd / && <scratch>/extvenv/bin/python readme-example.py
```

`readme-example.py` is the first code block of `python/fixtures/README.md`
verbatim, plus prints and one invalid fixture:

```
load: {'name': 'Dark'}
list: ['theme:dark']
validate: {'ok': True, 'diagnostics': []}
invalid: {'ok': False, 'diagnostics': [{'severity': 'error', 'code': 'schema-invalid',
  'message': "'name' is a required property", 'fixture': 'theme:broken', 'source': 'bad',
  'path': 'themes/broken.json', 'fieldPath': ''}]}
from: <scratch>/extvenv/lib/python3.12/site-packages/mirk/fixtures/__init__.py
      <scratch>/extvenv/lib/python3.12/site-packages/mirk/store/__init__.py
```

Both distributions resolve from `site-packages`, not the checkout, and the
PEP 420 `mirk` namespace holds both without shadowing.

## Falsifications recorded by the executors

- Store-source ordering: reverting `packages/fixtures/src/sources/store.ts` to
  `localeCompare` and regenerating flips
  `fixtures/store/entry-order-is-code-point-not-collation` to a different
  error message. The comparator copy in `packages/fixtures/src/order.ts`
  replaced with UTF-16 code unit order fails
  `AssertionError: "a😀b" vs "a�b": expected -1 to be 1`.
- `jsonschema` was run, not read: a `required` failure reports at the
  containing object's path, a root failure at the empty path, an `if`/`then`
  failure as the branch, matching the two engine-agreement rules in
  `conformance/README.md`.
- Node was run for `Object.entries` ordering of integer-like keys; Python
  carries `js_entries` so a map document keyed `{"10":…,"2":…}` expands in the
  same order.

## Findings that changed the corpus

- One generated scenario pinned V8's `JSON.parse` wording. Ruling: host parser
  text is never contract. The scenario became
  `fixtures/layering/parse-error-degrades-in-validate` over a new
  `validateDiagnostics` op with `ignoreFields: ["message"]`; the `list()`
  half moved to language-local tests. The message itself did not change, so
  the CLI still shows the parser's explanation.
- Digest items 70, 72 (order half) and 79 need a second parser or a
  mid-scenario mutation and are language-local; the document cache key
  omitting the extension was found by running, carried over on purpose, and
  pinned in Python.

## Not proven here

No registry upload happened; the wheel path used a local `dist/`. The
filesystem source, the CLI and the package-resource source are outside the
corpus by ruling (filesystem is pinned per language; the other two are not
ported).
