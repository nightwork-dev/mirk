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
  must raise with that message. There is no unordered form: the contract fixes
  order everywhere. A step without `expect` is setup.
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

- `ports` are the seven port names. Five bind a backend: `kv`, `collection`,
  `vector`, `search`, `graph`. `atomic` binds the same object as `kv` and
  `collection` and adds `getVersioned` and `mutateAtomically` to it. `hash`
  binds a pure target with no backend behind it — `canonicalJson`,
  `canonicalDigest`, `sha256Hex(text)` and `sha256Bytes(bytes)` — which is why
  a `hash` scenario produces the same result under every backend name and is
  still run under each of them. Every backend in both languages implements all
  seven, so an unsatisfiable port is a corpus error.
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
