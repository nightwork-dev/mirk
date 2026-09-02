# Heritage digest — pin-derive cross-language conformance corpus

Repo: `<pin-derive>` (version 0.10.0). Four runtimes held in
conformance: TypeScript reference (`src/`), native Rust core (`rust/core`),
JS-via-wasm (`rust/js`), Python-via-wasm (`rust/python`). 151 fixture files in
`<pin-derive>/fixtures/`.

**The single most important structural fact: the corpus is GENERATED, not
authored.** `<pin-derive>/scripts/gen-fixtures.ts` (2088 lines)
is the only writer of `fixtures/*.json`. Every fixture's `expected` is whatever
the TypeScript reference engine produces right now. Nobody hand-writes an
expected value.

---

## 1. Fixture JSON format

One file per fixture, named `<name>.json`, `name` field equals the basename.
Written as `JSON.stringify(body, null, 2) + "\n"` (2-space indent, trailing
newline) — see `scripts/gen-fixtures.ts:1762` and the sibling write sites.

The full interface is declared once, in the TS runner
(`<pin-derive>/src/fixtures.test.ts:51-97`):

```ts
interface Fixture {
  name: string;
  kind?: "solve" | "preview" | "commit" | "explain" | "patch" | "cas" | "delta" | "fingerprint";
  spec: NetworkSpec;
  moves?: Move[];
  options?: CommitOptions;
  expected?: SpecSnapshot | CommitResult | PreviewResult | ExplainResult;
  patches?: SpecPatch[];
  nextSpec?: NetworkSpec;
  expectedDelta?: DecisionDelta;
  canonicalState?: string;
  expectedFingerprint?: string;
  equivalentSpec?: NetworkSpec;
  expectedError?: string;
  solveOptions?: Record<string, unknown>;
  explainOptions?: ExplainOptions;
  expectedBaseline?: ExplainResult;
  shrinks?: true;
  expectedRepairs?: RepairsResult;
  repairsOptions?: RepairsOptions;
  fillOptions?: FillOptions;
  expectedFill?: FillResult & { snapshot?: SpecSnapshot };
  lpInput?: LP;
  expectedLP?: { status: LPResult["status"]; x: number[]; value: number | null };
  expectedTrace?: TraceEvent[];
  expectedChooserTrace?: TraceEvent[];
  lpCommitCells?: string[];
  expectedLPCommit?: { status: LPResult["status"]; x: number[]; value: number | null };
}
```

Key design rules readable off that shape:

- **`kind` selects which engine operation the fixture drives.** Absent means
  `"solve"` (all pre-0.6 fixtures). Each kind gets its own branch in every
  replayer.
- **Exactly one of `expected` / `expectedError`** — asserted at replay time in
  all three languages, not merely documented. The `delta` and `fingerprint`
  kinds are the explicit exception: they carry their expectation under their own
  key and must NOT carry `expected`.
- **Errors are the exact message string**, not a code or a class. `expectedError`
  holds the literal message the reference implementation throws, e.g.
  `"explain: unknown cell ..."`. Pinned strings are contract.
- **Opt-in extension keys mean "not exercised here", never "expected empty."**
  Written down as spec Decision 9 and enforced: absence of `expectedRepairs` /
  `expectedFill` / `expectedLP` is silence, not an assertion of emptiness.
- **An expectation must ship with its input.** `expectedFill` requires
  `fillOptions`; `expectedLP` requires `lpInput`. A spec alone does not determine
  either call. The replayer asserts the pairing as a fixture-format error.
- **No metadata layer at all.** No `id`, no `title`, no `tags`, no spec
  reference, no description field. Naming is the whole taxonomy: files are
  kebab-case and prefix-clustered by family — `error-*` (23 files), `commit-*`,
  `core-minimal-*`, `compressible-*`, `curve-*`, `cas-*`, `delta-*`,
  `repairs-*`. Explanatory prose lives in the generator's TSDoc comments, not in
  the JSON.
- **Float tolerance is not in the fixture.** It is a constant in each replayer:
  `EPS = 1e-6` in TS, JS and Python; `NUM_EPS = 1e-6` in Rust. Note this is a
  different constant from the engine's internal `EPS = 1e-9`.

### One complete fixture, verbatim

`<pin-derive>/fixtures/within-containment.json`:

```json
{
  "name": "within-containment",
  "spec": {
    "cells": [
      { "id": "xLo", "init": { "lo": 0, "hi": 100 } },
      { "id": "xHi", "init": { "lo": 0, "hi": 100 } },
      { "id": "oLo", "init": { "lo": 10, "hi": 20 } },
      { "id": "oHi", "init": { "lo": 80, "hi": 90 } }
    ],
    "relations": [
      { "type": "within", "xLo": "xLo", "xHi": "xHi", "oLo": "oLo", "oHi": "oHi" }
    ],
    "pins": [ { "cell": "xLo", "value": { "lo": 0, "hi": 100 } } ]
  },
  "expected": {
    "converged": true,
    "cells": [
      { "id": "xLo", "label": "xLo", "value": { "lo": 10, "hi": 90 }, "provenance": "pinned",  "boundsStatus": "bounded" },
      { "id": "xHi", "label": "xHi", "value": { "lo": 10, "hi": 90 }, "provenance": "derived", "boundsStatus": "bounded" },
      { "id": "oLo", "label": "oLo", "value": { "lo": 10, "hi": 20 }, "provenance": "derived", "boundsStatus": "bounded" },
      { "id": "oHi", "label": "oHi", "value": { "lo": 80, "hi": 90 }, "provenance": "derived", "boundsStatus": "bounded" }
    ],
    "decisions": [
      { "id": "xLo", "label": "xLo", "space": { "lo": 10, "hi": 90 }, "status": "pinned" },
      { "id": "xHi", "label": "xHi", "space": { "lo": 10, "hi": 90 }, "status": "bounded" },
      { "id": "oLo", "label": "oLo", "space": { "lo": 10, "hi": 20 }, "status": "bounded" },
      { "id": "oHi", "label": "oHi", "space": { "lo": 80, "hi": 90 }, "status": "bounded" }
    ],
    "conflicts": [],
    "conflictOrigins": []
  },
  "expectedTrace": [
    { "step": 1, "kind": "relation", "relationId": "r1", "fromCells": ["xHi","oLo","oHi"], "toCell": "xLo", "before": { "lo": 0,  "hi": 100 }, "after": { "lo": 10, "hi": 100 } },
    { "step": 2, "kind": "relation", "relationId": "r1", "fromCells": ["xLo","oLo","oHi"], "toCell": "xHi", "before": { "lo": 0,  "hi": 100 }, "after": { "lo": 0,  "hi": 90  } },
    { "step": 3, "kind": "relation", "relationId": "r1", "fromCells": ["xHi","oLo","oHi"], "toCell": "xLo", "before": { "lo": 10, "hi": 100 }, "after": { "lo": 10, "hi": 90  } },
    { "step": 4, "kind": "relation", "relationId": "r1", "fromCells": ["xLo","oLo","oHi"], "toCell": "xHi", "before": { "lo": 0,  "hi": 90  }, "after": { "lo": 10, "hi": 90  } }
  ]
}
```

(Reformatted onto fewer lines for readability; the on-disk file is the same
content at 2-space indent.)

`expectedTrace` is the closest thing pin-derive has to Mirk's "sequence of
operations": an ordered list of engine steps with `before`/`after` state, which
locks not just the answer but the path to it.

---

## 2. How the TypeScript suite replays fixtures

`<pin-derive>/src/fixtures.test.ts` (1168 lines), a vitest
file.

- **Discovery** (`:38-39`): `readdirSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures"))` filtered to `.json`. Plain directory read, no manifest.
- **Load** (`:98`): `JSON.parse(readFileSync(...)) as Fixture`.
- **Partition** (`:100-110`): the file list is split into `solveFiles`,
  `errorFiles`, `previewFiles`, `commitFiles`, `explainFiles` by reading each
  fixture's `kind` and whether it carries `expectedError`. Each family gets its
  own `describe`/`it` block.
- **Per-fixture test** (`:189-194`): `for (const file of solveFiles) it(file, ...)`.
  **The test name IS the filename**, so a vitest failure line names the fixture
  directly.
- **Comparison** (`expectSnapshot`, `:117-138`): field-by-field, not a blob diff.
  Convergence, then cell id ORDER as an array equality, then per cell
  provenance / boundsStatus / meta / lo / hi. Every assertion carries a context
  string `${name}: cell ${e.id}`, and the float ones embed both values:
  `` `${ctx} lo ${a.value.lo} vs ${e.value.lo}` ``. Conflicts and
  conflictOrigins are compared with `toEqual`.
- **Float tolerance** (`:113-115`): `sameBound(a, b)` is `Math.abs(a-b) < 1e-6`,
  with `null` equal only to `null`. Applied to interval bounds only; enums and
  ids are exact.

### The guard-the-guard pattern (worth stealing wholesale)

A recurring anxiety in this suite is *presence-gated assertions going vacuous*.
Branches that only run when a fixture carries an optional key would silently
assert nothing if those fixtures were deleted. So the suite asserts on the
corpus itself:

- `expect(files.length).toBeGreaterThan(0)` — "found the fixture directory" (`:142-144`).
- `expect(previewFiles.length).toBeGreaterThan(0)`, same for commit, explain,
  error, repairs, fill, lp, quantize (`:203, :224, :259, :432, :576, :665, :709, :542`).
- `expect(conflicted, "no conflicted solve fixture to check").toBeGreaterThan(0)`
  (`:171`) — explicitly commented "Guard the guard: a corpus with no conflicted
  origin at all would pass the loop above by never entering it."
- Corpus-shape assertions beyond counts, e.g. `expect(repairFiles.some((f) =>
  entriesOf(f).length === 0)).toBe(true)` — the corpus must contain at least one
  empty-repairs case.

There is **no total fixture-count check**. Counts are per-family lower bounds
only, which avoids the stale-magic-number problem.

### The live-engine cross-check

`:174-186` asserts the same claim twice: once against the committed fixture text
and once against the live engine, "so a fixture regenerated from a leaky
implementation cannot hide it." That is the antidote to a generated corpus
certifying itself.

---

## 3. How the Python package replays the same fixtures

`<pin-derive>/rust/python/tests/test_conformance.py` (928 lines), pytest.

- **Discovery** (`:151`): `FIXTURE_ROOT = Path(__file__).resolve().parents[3] / "fixtures"`.
  From `rust/python/tests/` that is three parents up to the repo root, then
  `fixtures/`. **The Python package reads the shared corpus out of the repo, not
  out of package data.** The wheel does not ship fixtures.
- **Case list** (`:144-148`):
  ```python
  def fixture_cases(fixtures_dir: Path) -> list[Any]:
      files = sorted(fixtures_dir.glob("*.json"))
      assert files, f"no fixtures found in {fixtures_dir}"
      return [pytest.param(path, id=path.stem) for path in files]
  ```
  `sorted()` for determinism; `id=path.stem` makes the pytest node id the fixture
  name, so a failure reads `test_replays_conformance_fixture[within-containment]`.
- **Replay** (`:395-397`): a single
  `@pytest.mark.parametrize("fixture_path", fixture_cases(FIXTURE_ROOT))` test,
  `case = json.loads(fixture_path.read_text())`, then branch on `kind`.
- **Comparison**: two layers.
  - `compare_snapshot(actual, expected, name)` (`:24+`) mirrors the TS
    `expectSnapshot` field for field, same order, same message shape
    (`f"{name}: {cell_id} provenance"`).
  - `deep_equal(actual, expected)` (`:125-141`) is a recursive tolerant compare
    for the envelope-shaped expectations: bools compared with `is` **before** the
    numeric branch (so `True != 1`), numbers within EPS, mappings compared over
    the UNION of key sets (so a missing key on either side fails), lists
    elementwise with length check.
- **Float tolerance** (`:15-21`): `EPS = 1e-6`, `same_bound` returns
  `actual is expected` when either is `None`, else `abs(a-b) < EPS`. Identical
  constant and identical semantics to TS, JS and Rust.
- **Skips / unsupported: there are none.** No `pytest.mark.skip`, no `xfail`, no
  capability table. Every fixture must replay in every runtime. The only
  conditional behavior is `kind` dispatch and opt-in extension keys, and both are
  contract, not capability.
- **Anti-vacuity tests, ported deliberately** (`:154-230`):
  `test_the_07_branches_are_actually_reached` and
  `test_the_09_families_are_actually_reached` re-read the corpus directly (not
  via `fixture_cases`, because those are `pytest.param` wrappers) and assert that
  at least one fixture carries `expectedTrace`, at least one carries
  `expectedRepairs`, at least one produces non-empty `conflictingFacts`, and that
  each of `explain`/`patch`/`cas`/`delta`/`fingerprint` has at least one fixture.
  It also asserts fine-grained option coverage, e.g. "no all-origins default-level
  case", "no compressible case", "no minimization case".
- **Errors**: `refuses(call, want, what)` helper — `pytest.raises(PinDeriveError)`
  then `assert str(info.value) == want`, exact string.

The Rust replayer (`rust/core/tests/conformance.rs`, 1716 lines) and the JS one
(`rust/js/smoke.mjs`) are structurally the same: directory glob, per-fixture
compare, `1e-6`, exact error strings. Rust's `json_eq(a, b, path)` threads a JSON
path string through recursion so a failure reads
`at .cells[2].value.lo: numbers differ (...)`. JS's `deepEqual` treats absent and
`null` as the same "because the wire contract drops absent optionals".

---

## 4. How the corpus is versioned and governed

**There is no `fixtures/README.md` and no fixture schema document.** The schema
lives in three places: the `Fixture` interface in `src/fixtures.test.ts:51-97`,
the header comment of `scripts/gen-fixtures.ts:1-11`, and the header comment of
`src/fixtures.test.ts:1-6`. That is a real gap for a corpus that four runtimes
depend on.

Governance is entirely mechanical, via the build graph.

**The freshness gate** — `<pin-derive>/moon.yml:41-48`, task
`pin-derive:fixtures-current`:

```yaml
fixtures-current:
  script: 'rm -rf fixtures/ && pnpm gen:fixtures && if [ -n "$(git status --porcelain -- fixtures/)" ]; then echo "fixtures drift from the TS reference engine:"; git status --short -- fixtures/; git --no-pager diff -- fixtures/; exit 1; fi'
  options:
    runInCI: true
    cache: false
```

Its comment is the best single artifact in this repo and explains every choice:

- `rm -rf` first, so the regen is the COMPLETE picture. Without it a fixture
  removed from the generator survives on disk carrying a stale `expected`, and
  the ports happily replay that ghost — a false green where a runtime matches a
  stale snapshot while disagreeing with the current reference.
- `git status --porcelain` rather than `git diff`, because it catches all three
  directions: added (`??`), modified (`M`), deleted (`D`). `git diff` ignores
  untracked, and the `git add -N` trick erases the deletion signal.
- `cache: false`, because the verdict depends on git working-tree state, not
  input hashes.

**The dependency chain.** Every port's `conformance` task lists
`pin-derive:fixtures-current` as a dep, so no runtime can replay a stale corpus.
`rust/python/moon.yml` also deps on `rust-wasm:build`, `rust-wasm:size-gate`, and
`port-python:typecheck`, with the comment "A gate nobody runs is a gate that does
not exist" — the type gate is inside the chain specifically because it once went
quietly red when a lane ran mypy against two named files instead of the
configured set.

**CI**: `.github/workflows/ci.yml:52-57` runs
`pnpm exec moon run :conformance pin-derive:test pin-derive:typecheck`. The `:`
prefix fans out to every project defining a `conformance` task, so adding a
language port is a drop-in — give it a `moon.yml` with that task and the gate
picks it up. npm publish sits behind the same gate
(`.github/workflows/release.yml`), so publish is structurally unreachable unless
all four runtimes agree.

**The stated rule for adding a fixture** (`CONTRIBUTING.md:14-18, 32-49`,
`docs/EXTENDING.md:84-104`): the TS engine is the reference implementation; if
you change its behavior, regenerate and confirm the ports still agree before
opening a PR. Adding a relation requires a fixture that exercises it. And from
`scripts/gen-fixtures.ts:10-11`: **"Regenerate after an intentional semantics
change and REVIEW THE DIFF — a surprising change in a fixture is a regression,
not a refresh."**

**Self-certification guards inside the generator.** Because the generator writes
its own expectations, it has to refuse to launder a bug:

- `throwsOf(name, run)` runs the call and, if it does NOT throw, raises
  `` `fixture ${name}: declared throws, but the call succeeded` ``. A validation
  rule that silently stops firing fails generation instead of quietly becoming an
  `expected` snapshot.
- Fingerprint fixtures assert `solveFingerprint(equivalentSpec) === expectedFingerprint`
  at generation time.
- Fingerprint fixtures also record `canonicalState`, the canonical INPUT text
  alongside the digest, "so a Rust lane whose hex disagrees can see WHICH byte
  diverged instead of only that one did."
- The generator header notes every scenario mirrors a behavior independently
  locked by the unit suites, "so the generated expectations are cross-checked,
  not self-certifying."

**No spec cross-reference convention in the files.** Specs live in
`docs/specs/YYYY-MM-DD-*.md` and reference fixtures by family in prose
(e.g. `2026-08-18-reconciliation-primitives-cross-language.md` describes "one
fixture-format extension"), but no fixture points back at a spec. Decisions are
numbered in the specs ("spec Decision 9") and quoted in code comments instead.

---

## 5. Python packaging (`rust/python/pyproject.toml`)

```toml
[build-system]
requires = ["hatchling>=1.25"]
build-backend = "hatchling.build"

[project]
name = "pin-derive"
version = "0.10.0"
requires-python = ">=3.11"
license = "Apache-2.0"
dependencies = ["wasmtime>=27"]

[project.optional-dependencies]
dev = ["build>=1.2", "mypy>=1.13", "pytest>=8", "twine>=5"]

[tool.mypy]
strict = true
files = ["src/pin_derive", "tests"]

[tool.hatch.build.targets.wheel]
packages = ["src/pin_derive"]
include = ["src/pin_derive/_pin_derive_wasm.wasm", "src/pin_derive/py.typed"]

[tool.hatch.build.targets.sdist]
include = ["LICENSE", "README.md", "pyproject.toml", "src/pin_derive", "tests"]
```

Notes:

- **src-layout**, `src/pin_derive/`, with `py.typed` shipped. Classifiers declare
  3.11 / 3.12 / 3.13.
- **The wasm blob is package data**: `src/pin_derive/_pin_derive_wasm.wasm`,
  listed in the wheel `include`. The moon `conformance` task copies the freshly
  built artifact over it before running pytest:
  `cp ../target/wasm32-unknown-unknown/release/pin_derive_wasm.wasm src/pin_derive/_pin_derive_wasm.wasm && uv run --with pytest pytest`.
- **Test command**: `uv run --with pytest pytest` for conformance,
  `uv run --extra dev mypy` for the type gate. `uv` throughout; `uv.lock` is
  committed.
- **Fixtures are NOT package data.** Tests reach up to the repo root. The sdist
  ships `tests/` but not `fixtures/`, so an sdist-only checkout cannot run the
  conformance suite. Fine here because the corpus lives in the same repo.

### What transfers to a pure-Python re-implementation

Transfers unchanged: hatchling + src-layout + `py.typed`, `uv` with a committed
lock, `mypy strict` over `src` AND `tests` as a task in the conformance dep
chain, `requires-python = ">=3.11"`, the dev extras set, `sorted(glob)` +
`pytest.param(id=stem)` discovery, `EPS = 1e-6`, exact-message error assertions.

Does not transfer: everything wasm. No `wasmtime` dependency, no `.wasm` package
data, no `cp` step before pytest, no `--wasm-path` escape hatch. Mirk's Python
package has real source to typecheck and real dependencies of its own, so the
type gate gets MORE valuable, not less — it is checking a second implementation
rather than a binding's annotations.

One thing to change deliberately: with a re-implementation there is no shared
binary guaranteeing identical float arithmetic. pin-derive's `1e-6` tolerance
papers over last-bit differences between one Rust build and one TS build. A
Python re-implementation of, say, cosine similarity will diverge more than that.
Decide the tolerance per assertion class, and make ordering/tie-breaks exact
rather than tolerant.

---

## 6. Recorded lessons about keeping implementations in conformance

`<pin-derive>/docs/reviews/2026-08-19-repository-quality-assessment.md`
is the one review that grades the system. It calls the reference-and-replay model
"the highest-quality part of the repository" and "one of the repository's
greatest strengths." It also names the failures:

**Finding 4 — cross-runtime testing is excellent but asymmetric at invalid
boundaries.** The corpus covers a large VALID-input surface. It does not cover
malformed numeric inputs, because TypeScript accepts malformed values before they
can become fixture inputs, while Rust rejects them at a different layer. Verified
probes: `clamp(lo: 10, hi: 0)` returned a clean derived point rather than an
error; a quantize relation with a NaN origin returned a clean result; non-finite
lookup coordinates entered the TS relation path. The review's stated conclusion:
**"The fixture system can only prove a negative-input contract if malformed cases
are represented as expected-error fixtures and replayed through every public
surface."** Remediation is Priority 2, "make malformed-input fixtures
cross-runtime."

The corpus has since grown 23 `error-*` fixtures answering exactly this
(`error-clamp-bounds-unordered.json`, `error-quantize-origin-not-finite.json`,
`error-lookup-coordinate-not-finite.json`, ...). The gap was closed by adding
negative fixtures, which is the lesson.

**The evidence-scope caveat, stated plainly** (`:45-48`): *"Green conformance
therefore proves agreement on the fixture corpus, not complete agreement on every
public input boundary."* Worth quoting into Mirk's own corpus README verbatim.

**Finding 3 — a tolerance constant silently redefined a contract.** The docs say
an interval is empty when `lo > hi`; the implementation uses `lo > hi + EPS` with
`EPS = 1e-9`. So `{lo: 1, hi: 0.9999999995}` is reversed but reports as a point.
Both TS and Rust mirror the rule, so conformance was green — the divergence was
between the normative document and both implementations at once. **Conformance
between implementations cannot detect a shared misreading of the spec.** The
fixture `degenerate-point-sub-eps-tolerated.json` now pins whichever answer was
ruled correct (`docs/specs/2026-08-19-numeric-contract-ruling.md`).

**Finding, documentation drift** (Priority 5): counts and claims in prose went
stale. The review table itself is already stale — it records "82 of 82 shared
fixtures" against a corpus that is now 151 files, which is why per-family
`toBeGreaterThan(0)` lower bounds beat a hardcoded total.

**The mypy near-miss**, recorded in `rust/python/moon.yml`: during the 0.10.0
explain split, a lane ran mypy against two named files instead of the configured
set, reported clean, and shipped eight errors in the test module. The fix was
making typecheck a task inside the conformance dependency chain rather than a
habit. "A gate nobody runs is a gate that does not exist."

---

## 7. Recommendation for Mirk's corpus

1. **Generate, don't author.** One TS reference engine writes every expectation.
   Hand-written expected values in a stateful store corpus will be wrong and
   unmaintainable.
2. **Copy `fixtures-current` verbatim**, `rm -rf` and `git status --porcelain`
   and `cache: false` and all. It is the load-bearing piece and its rationale
   comment survives review.
3. **Copy the anti-vacuity guards**: per-family `> 0` lower bounds, never a total
   count. Add "at least one fixture reaches operation X on backend Y."
4. **Copy the exact-error-string convention** and the generator's `throwsOf`
   refusal, so a validation rule that stops firing fails generation.
5. **Copy `EPS = 1e-6` for vector distances only.** Make ordering, tie-breaks,
   ids, cursors and counts exact — Mirk's whole backend-parity contract is
   ordering, and a tolerant compare would hide the bug you most care about.
6. **Add the schema doc pin-derive lacks**: `fixtures/README.md` with the fixture
   interface and the "regenerate and REVIEW THE DIFF" rule. Four runtimes reading
   an interface buried in a test file is the one thing not to inherit.
7. **Change the fixture body from `{spec, expected}` to `{setup, ops[], expected}`.**
   Mirk is a sequence against a store, so the fixture needs an ordered op list
   with a per-op expectation, and a final-state assertion. pin-derive's
   `expectedTrace` is the nearest ancestor: ordered steps with before/after.
8. **Add a `backends` field pin-derive has no need for.** A fixture must declare
   which backends it applies to, since not every backend has vectors or FTS.
   But make the DEFAULT "all backends" and make an exclusion require a reason
   string, or the corpus quietly becomes per-backend and proves nothing.
9. **Resist per-language skip marks.** pin-derive has zero skips and that is why
   its gate means something. A Python re-implementation will tempt you to skip;
   make the fixture declare unsupported-ness as data, so it is visible and
   countable rather than a decorator.
10. **Write down the scope caveat now.** "Green conformance proves agreement on
    the corpus, not on every input boundary." pin-derive learned that malformed
    input never becomes a fixture unless someone deliberately adds negative
    cases, and that two implementations can agree while both misreading the spec.
