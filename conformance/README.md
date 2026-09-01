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
  vector/*.json          vector scenarios
  search/*.json          full-text search scenarios
  graph/*.json           graph traversal scenarios
```

A scenario's `id` is its path under `conformance/` without the `.json`
extension.

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
- `ports` names the ports a scenario touches; a runner skips a scenario whose
  ports it does not implement and reports the skip. `capabilities` gates on
  optional capabilities (`listWhereIn`, `vec0`) the same way.
- Records are JSON. `null` is a value. There is no `undefined`; a TypeScript
  runner strips `undefined` before comparison. Numbers compare as IEEE doubles;
  integers and floats with the same value are equal.
- Strings sort by Unicode code point.
- Backends are not selectable per scenario. A behavior that differs between
  memory and SQLite is a bug in one of them, not a corpus option.

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
