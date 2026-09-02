# Mirk conformance corpus

The language-neutral contract for `@mirk/store`. The TypeScript suite and the
Python suite each replay every scenario here against every backend they
implement. **A behavior that is not in the corpus is not contractual.**

## Generated, not authored

These files are written by
`packages/store/scripts/gen-conformance.ts` and by nothing else. Scenario
*inputs* are declared in `packages/store/scripts/scenarios/`; every `expect`
value is whatever the TypeScript in-memory reference produces right now.

- **Do not hand-edit a scenario file.** Change the scenario input and
  regenerate: `pnpm conformance:gen`.
- **Regenerate after an intentional semantics change and REVIEW THE DIFF.** A
  surprising change in a scenario is a regression, not a refresh.
- `pnpm conformance:current` generates a fresh corpus into a temporary
  directory and diffs that tree against this one, failing with the list of
  added, removed and changed files. It never writes here. Regenerating in place
  and then looking for a difference would destroy the hand edit the gate exists
  to catch, because the generator clears the generated directories first. The
  clearing is right for a real regeneration — a scenario dropped from the
  generator must disappear rather than survive carrying a stale expectation that
  every runner would happily replay — and wrong for a check. The gate's verdict
  depends on working-tree state, so it must never be cached.

Two refusals keep a generated corpus from laundering a bug. Every scenario runs
against both the in-memory reference and the SQLite adapter, and generation
fails with the scenario id, the step and the diff if they disagree — a
divergence is a bug in one backend, not a corpus option. A step marked `throws`
that does not throw also fails generation, so a validation rule that stops
firing cannot quietly become an expectation.

## Writing a scenario while someone else is writing one

**Only the integrator runs the plain `pnpm conformance:gen`.** It rewrites the
whole shared corpus, so two authors running it at once overwrite each other.

While drafting a scenario, generate somewhere else and read the result:

```
pnpm --filter @mirk/store conformance:gen --out /tmp/my-corpus
```

That runs every check the real generation runs — both backends, both refusals —
and writes nothing here. Hand the scenario input to the integrator; the shared
corpus is regenerated once, from all the inputs together.

## Layout

```
conformance/
  README.md              this file
  scenario.schema.json   JSON Schema (draft 2020-12) for a scenario file
  store/*.json           KV and collection scenarios
  store/atomic/*.json    versioned reads and atomic mutation scenarios
  vector/*.json          vector scenarios
  search/*.json          full-text search scenarios
  graph/*.json           graph traversal scenarios
  artifact/hashing/canonical-json/*.json   canonical text and its digest
  artifact/hashing/bytes/*.json            content digests over raw bytes
  fixtures/**/*.json     authored-data loader scenarios
```

A scenario's `id` is its path under `conformance/` without the `.json`
extension. An id has two or more `/`-separated segments, each kebab-case; the
FIRST segment is the corpus directory the generator clears and counts, and any
segment between it and the name is an ordinary nested directory. So
`artifact/hashing/bytes/utf8-hello` is counted under `artifact`, and dropping
every `artifact/` scenario from the generator removes the whole tree.

## Scenario format

One file, one scenario, one sequence of operations against fresh stores.
Runners execute the sequence once per backend. Every step's `expect` is checked
before the next step runs.

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

- `op` is a port method name as spelled in the TypeScript port. Runners map it
  to their language's spelling. `args` are positional JSON values.
- `expect` forms: `{"value": <json>}` exact deep equality;
  `{"values": [...]}` for a list of records compared position by position;
  `{"ids": [...]}` for ordered result ids only, used where the contract fixes
  ranking and nothing else; `{"throws": "<exact message>"}` when the operation
  must raise with that message; `{"invalidPaths": [...]}` for a validation
  result, described under "The `fixtures` port" below. There is no unordered
  form: the contract fixes order everywhere. A step without `expect` is setup.
- A `values` expect takes two optional modifiers, and may carry both at once.
  `approxFields` with `tol` compares the named fields within that tolerance
  instead of exactly. `ignoreFields` removes the named fields from both sides
  before comparing, and the generator also strips them from the stored
  expectation, so the corpus never carries a number nobody may rely on. Search
  scores are the motivating case: bm25 floats are not cross-backend contract
  while ids, order and `meta` all are, and the `ids` form cannot check `meta`.
- **Setup is not silence.** A step with no `expect` still has to complete
  without throwing, on every backend, at generation time and at replay time.
- **`throws` is the exact exception message string**, not a code or a class. A
  step marked `throws` that returns normally fails. A step not marked `throws`
  that raises fails. The rule is the same at generation and at replay, in both
  languages.
- Vectors are JSON arrays of numbers. Both languages round components to float32
  before storing; cosine accumulates in float64 with the two-sqrt denominator.
  Tolerance is `1e-6` and applies to vector scores only.
- Tie-break order everywhere (collection sort, vector results, search results,
  graph nodes and edges) is Unicode code point order of the id.
- `ports` names the ports a scenario touches. `capabilities` names the optional
  capabilities it needs. Both are HARD gates in both languages, never skips —
  see "Ports and capabilities are hard gates" below.
- **A scenario asserts something.** At least one step carries an `expect`. A file
  made only of setup steps replays green forever while checking nothing, so both
  the generator and every runner refuse it by id: `scenario <id> asserts
  nothing`.
- Records are JSON. `null` is a value. There is no `undefined`; a TypeScript
  runner strips `undefined` before comparison. Numbers compare as IEEE doubles;
  integers and floats with the same value are equal.
- Strings sort by Unicode code point.
- **Wrapped scalars for the `hash` port.** JSON cannot express negative zero, a
  non-finite number, an integer above 2^53, a lone surrogate, or raw bytes, and
  every one of those is a case the hashing contract turns on. In the args of a
  `hash` scenario ONLY, an object with exactly one key from `$num`,
  `$codepoints`, `$b64`, `$utf8` is a wrapper and is replaced before dispatch:
  `$num` parses its decimal text as a float64 (`"-0"`, `"NaN"`, `"Infinity"`,
  `"9007199254740993"`), `$codepoints` builds a string from code points with
  lone surrogates allowed, `$b64` and `$utf8` produce bytes. Expansion recurses
  through arrays and plain objects. An object with any other shape is ordinary
  data and means itself. Results are text and hex, so the `expect` side needs no
  wrapper.
- Version tokens are compared by exact value. Both conformance stores are built
  with the version identity `conformance`, so a token reads `conformance-v<n>`
  and the corpus pins allocation itself: the sequence starts at 1 per store,
  every `set`/`put` consumes one value, `delete`/`remove` consume none, and a
  conflict or a rejected request consumes none.
- Backends are not selectable per scenario. A behavior that differs between
  memory and SQLite is a bug in one of them, not a corpus option.

## Ports and capabilities are hard gates

A runner that cannot satisfy a scenario's `ports` or `capabilities` **fails that
scenario and names what is missing**. It never skips and never silently passes.
A skip lets a typo in `ports`, or a capability that quietly stopped loading,
retire a scenario from every backend at once — which is the exact failure the
corpus exists to prevent.

- `ports` are the eight port names. Five bind a backend: `kv`, `collection`,
  `vector`, `search`, `graph`. `atomic` binds the same object as `kv` and
  `collection` and adds `getVersioned` and `mutateAtomically` to it. `hash`
  binds a pure target with no backend behind it — `canonicalJson`,
  `canonicalDigest`, `sha256Hex(text)` and `sha256Bytes(bytes)` — which is why
  a `hash` scenario produces the same result under every backend name and is
  still run under each of them. `fixtures` binds an authored-data loader over
  the backend store, described below. Every backend in both languages
  implements all eight, so an unsatisfiable port is a corpus error.
- `capabilities` are the optional ones. The only known name today is
  `listWhereIn`; anything else is a typo and fails the same way. Each runner
  declares, per backend, which capabilities that backend has **right now**,
  detected for real rather than assumed:
  - `listWhereIn` — the method both store backends implement, in both languages.
  - There is no `vec0` capability. The sqlite-vec path was removed under
    roadmap MR-22 after it was shown never to have executed; the SQLite vector
    facet is the exact float64 cosine path in both languages.
- A scenario declaring a capability a backend lacks is a failure naming the
  backend and the capability: `<id>: <backend> lacks capability(ies) <names>`.
  The one exception is the empty case: if no scenario in the corpus declares a
  capability at all, there is nothing to gate. A `vec0` scenario replayed on a
  backend without vec0 would prove the fallback path, not the capability, which
  is worse than no scenario.
- Generation applies the same rule, so a scenario that no backend can honestly
  run never reaches the corpus.

Each runner reports the capability set it found per backend, so a silently
degraded environment (sqlite-vec missing from CI, say) is visible in the log
rather than inferred from a suspiciously fast green.

## The `fixtures` port

`@mirk/fixtures` loads authored documents through layered sources, so its
scenarios need a target that is configured before it is used. Every `fixtures`
scenario's FIRST step is `configure(spec)`, a setup step carrying the whole
declaration as data.

```json
{ "op": "configure", "args": [{
  "types": [{ "type": "theme", "directory": "themes",
              "jsonSchema": { "type": "object", "required": ["name"] },
              "mergeStrategy": "deep" }],
  "sources": [{ "kind": "memory", "name": "base", "priority": 0,
                "files": { "themes/dark.json": "{\"name\":\"Dark\"}" } }],
  "referenceMode": "explicit-only"
}] }
```

- **A type is data.** `type` and `directory` are required; `extensions`,
  `document` (`{"kind":"map","idField":…}`), `purpose`, `referenceMode` and
  `mergeStrategy` (a builtin NAME — `replace`, `deep`, `array-replace`) are
  optional. `jsonSchema` is a JSON Schema 2020-12 document and defaults to
  `true`, the schema that accepts every value; `null` declares no contract at
  all, which the registry rejects. A function `mergeStrategy` and the
  `validateReferences`, `extractReferences` and `materialize` hooks are code,
  cannot cross a language boundary, and are pinned by each language's own tests
  instead.
- **A source is a layer.** `{"kind":"memory", name, priority, files}` maps
  relative paths to document TEXT. `{"kind":"store", name, priority, collection,
  pathPrefix?, extension?, items}` writes each item through the scenario's
  backend store first and then reads it back through the store source, so a
  store scenario exercises the real backend on both memory and SQLite. An item
  is `{id, content, extension?, relativePath?}`; `extension` falls back to the
  source's, then to `.json`.
- **Ops after `configure`:** `load(ref)`, `list(type?)`, `types()`,
  `validate(ref?)`, `explain(ref)` (the provenance object), `referenceGraph()`,
  `resolveRef(value, expectedType?)`, `invalidate(ref?)`, `seedStore(options)`
  and `readSeeded(collection, id)`.
- **Results are plain JSON with the TypeScript key spelling.** A field whose
  value is `undefined` is ABSENT, not null — both languages omit the same keys.
  `referenceGraph()` is serialized as `{nodes, edges, diagnostics}` with `nodes`
  sorted by `ref` and `edges` sorted by `from`, `to`, then the dot-joined
  `fieldPath`, all by code point.
- **Errors this package raises itself** (`patch-without-base`,
  `map-id-mismatch`, `unsafe-relative-path`, …) use the exact-message `throws`
  form, like every other port.

### Validation is compared by paths, never by message

`{"invalidPaths": [...]}` is the only expect form for a `validate` result that
reports schema failures. Ajv and Python's `jsonschema` word every message
differently and count errors differently, so a message is not contract. What is
contract is which part of which fixture failed:

- the sorted (code point), de-duplicated list of `"<ref>#<instancePath>"`, where
  `instancePath` is the dot-joined leaf path (`swatches.1.hex`, or the empty
  string for the document itself);
- `ok` must be `false` when the list is non-empty and `true` when it is empty;
- a diagnostic with any code other than `schema-invalid` FAILS the step — use
  the `value` form for those, which pins the message as usual.

Two rules make the engines agree and both languages implement them:

- **an aggregate keyword is dropped only when something underneath it already
  failed.** An `anyOf`, `oneOf`, `if` or `not` error reports "some combination
  failed" at a path both engines spell differently, so it is dropped when a
  NON-aggregate failure is already reported at the same instance path or a
  deeper one — Ajv emits those alongside, Python flattens them out of
  `context`. An aggregate with no such failure is KEPT at its own path.
  `{"not": {"const": "bad"}}` against `"bad"`, and a `oneOf` matched by two
  branches, are failures with nothing underneath them; dropping those would
  report an empty path list and call an invalid document valid.
- **a `required` failure keeps the containing object's path** and does not
  append the missing property. Ajv puts that name in `params`, Python only in
  the message text; appending it in one language and not the other would
  diverge.

The corpus never asserts `throws` for a `schema-invalid` failure.

### One more message the corpus does not own: `parse-failed`

`parse-failed` wraps the host parser's own words verbatim
(`Parse error: <whatever it said>`). V8 says `Expected property name or '}' in
JSON at position 2`; CPython says `Expecting property name enclosed in double
quotes: line 1 column 3 (char 2)`. No implementation choice reconciles them,
because the parser is the language's, so this message is not contract either.

It stays in the message rather than moving to `hint`, because the CLI's
human-readable output prints `message` and not `hint`: hiding the parser's
explanation of a broken file would cost a real reader more than it buys the
corpus. Instead the corpus compares such a diagnostic with the message removed.
`validateDiagnostics(ref?)` returns a validation report's `diagnostics` array so
the `values` form applies, and `ignoreFields: ["message"]` drops the field from
both sides AND from the stored expectation, so no host text reaches the corpus:

```json
{ "op": "validateDiagnostics", "args": [],
  "expect": { "values": [{ "severity": "error", "code": "parse-failed",
                           "fixture": "theme", "source": "pack",
                           "path": "themes/bad.json" }],
              "ignoreFields": ["message"] } }
```

That `list()` aborts on a parse error where `validate()` degrades is pinned by
each language's own tests for the same reason. Every OTHER `list()`-throws
scenario raises a message Mirk itself writes, so those stay exact-message
`throws` steps.

## Governance

- Every behavior change to a port lands with a corpus scenario in the same
  commit. A TypeScript-only test for port behavior is a review finding.
- Scenario ids are stable. A scenario is never edited to pass. It is replaced
  under a new id, and the old id is listed below as retired with the reason.
- Receipts (`pnpm release:receipt`) record the executed scenario count per
  runner. A run that executes zero scenarios is not a receipt.

### Retired scenario ids

None yet.

## Scope of the evidence

**Green conformance proves agreement on the corpus, not on every input
boundary.** Malformed and out-of-contract inputs only become contractual when
someone deliberately adds them as `throws` scenarios. Two implementations can
also agree while both misreading the specification; conformance cannot detect a
shared misreading.
