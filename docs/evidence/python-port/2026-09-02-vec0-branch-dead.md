# The vec0 acceleration path has never run, in either language

Date: 2026-09-02. Found while deciding the `minScore` question in task I1.
**Nothing here is fixed.** Reviving the branch turns out to break the corpus's
exact-agreement contract, which is a scope decision rather than a bug fix.

Reproductions live in [`probes/`](probes/) and run with
`cd packages/store && npx tsx ../../docs/evidence/python-port/probes/<file>`.

## The finding

`SqliteVectorFacet.search` routes to `searchVec` when sqlite-vec loaded, the
query is usable, and there are no metadata filters. `searchVec` **throws on every
call**, and the caller's bare `catch {}` swallows it and falls through to the
exact JS path.

```
$ npx tsx .../probes/vec0-branch-is-dead.ts
meta.accelerated = true
searchVec THREW -> A LIMIT or 'k = ?' constraint is required on vec0 knn queries.
```

The Python port copied the shape faithfully, bug included
(`python/store/src/mirk/store/sqlite_vector.py`, `_search_vec`, `except
Exception: pass`):

```
accelerated = True
_search_vec THREW -> OperationalError A LIMIT or 'k = ?' constraint is required on vec0 knn queries.
```

So the two languages are consistent — consistently dead. `meta.accelerated`
reports `true` in both while no accelerated query has ever executed.

## Why it throws

The KNN bound is expressed as a `LIMIT`, and the query joins the vec0 virtual
table to the `vectors` base table. SQLite does not push a `LIMIT` through a join
into a virtual table's `xBestIndex`, so vec0 never sees the bound and refuses.
A bound parameter is not the problem; a literal fails identically:

```
$ npx tsx .../probes/vec0-knn-query-forms.ts
vec0 row count: 4 | vectors row count: 5
THROW join + LIMIT ?  (what the adapter ships) -> A LIMIT or 'k = ?' constraint is required...
THROW join + LIMIT 3 literal                   -> A LIMIT or 'k = ?' constraint is required...
OK    join + k = ? (3)                         -> a:0.0000  b:0.0061  c:0.0299
OK    join + k = ? (10, more than stored)      -> a:0.0000  b:0.0061  c:0.0299  d:2.0000
OK    bare vtab + LIMIT ?                      -> 2:0.0000  3:0.0061  4:0.0299
```

`k = ?` in the WHERE clause survives the join. Environment: sqlite-vec 0.1.9,
better-sqlite3 11.10.0, and it is installed — `meta.accelerated` is `true`, so
this is not a missing-peer story.

## Why the existing tests did not catch it

`packages/store/src/vector.test.ts` has three vec0 tests that compare an
accelerated adapter against a `forceJsCosine: true` one. They pass while the
branch is dead **because both sides are then the fallback**. A guard that cannot
fail in the way that matters is worse than none: these read as coverage of vec0
and are coverage of nothing.

The corpus has the same blind spot for the same reason. Every `vector/*` scenario
replays on "sqlite", and every one of those results came from `searchJs`.

## What happens when the branch is revived

Changing the bound to `AND vv.k = ?` makes it run. Two things then surface.

### 1 · Ties at the topK boundary come back wrong

vec0 returns an **arbitrary** k among rows tied at the k-th distance, and sorting
what it handed back cannot recover the ids it did not hand back. Three vectors
tied at score 1, `topK: 2`:

| Insertion order | vec0 with `k = topK` | contract |
| --------------- | -------------------- | -------- |
| c, b, a         | a, b                 | a, b     |
| a, b, c         | **b, c**             | a, b     |

The answer depends on insertion order, which is exactly what the id tie-break
exists to eliminate. Widening to `k = count(collection)` fixes it, at the cost of
returning the whole collection — acceptable only because a plain `vec0` table is
an exhaustive scan anyway.

**This case is now pinned by `conformance/vector/tie-break-at-topk-boundary.json`,
which covers both insertion orders.** It passes today (the dead branch means
sqlite uses the exact path) and goes red the moment someone revives vec0 without
the widening. Verified: with `k = topK`, `conformance:gen` refuses to write —
`vector/tie-break-at-topk-boundary step 6 (search) [sqlite] disagrees with the
memory reference: at $.ids[0]: expected "a", got "b"`.

### 2 · vec0 cannot meet the exact-agreement contract at all

vec0 computes distances in **float32**; the contract says cosine accumulates in
**float64** with a two-sqrt denominator. On near-ties the two disagree about
*order*, and the corpus's `1e-6` tolerance covers scores only, never order.

```
$ npx tsx .../probes/vec0-vs-exact-scores.ts     # with the k = ? fix applied
vec0  : e=1.0000000000000002  c=0.81649658083915710  f=0.73029679059982300
        a=0.57735025882720947  b=0.57735025882720947  d=0.57735025882720947
exact : e=1.0000000000000002  c=0.81649658092772592  f=0.73029675059506782
        b=0.57735026918962584  d=0.57735026918962584  a=0.57735026918962573
```

float32 collapses `a`, `b` and `d` into an exact tie, so vec0 plus the id
tie-break returns `a, b, d`. float64 puts `a` one ULP below the other two, so the
exact path returns `b, d, a`. Both are defensible; they are not the same. This
made `vector.test.ts`'s ranking test fail as soon as the branch was revived.

Note the probe prints two identical rows when run against the tree as it stands,
because the dead branch means both adapters are the exact path. The output above
was captured with the `k = ?` fix applied locally.

## The decision this needs

The corpus rule is "a behavior that differs between memory and SQLite is a bug in
one of them, not a corpus option." Under that rule and the float64 cosine
contract, a float32 vec0 cannot be a conforming backend. Once `k` is widened to
the whole collection to satisfy the tie-break, vec0 is also doing a full scan and
returning every row, so it contributes only a C-speed cosine. Three coherent
exits, none of which an executor should pick alone:

1. **Delete the vec0 path** and the `accelerated` flag. The adapter becomes
   honest about what it does, and `sqlite-vec` stops being a peer dependency.
2. **Keep vec0 for candidate retrieval only** and rescore in float64 from the
   stored vectors. Exact parity by construction; vec0 pays for itself only if a
   real ANN index is added later.
3. **Loosen the contract** so ranking may differ between backends within a score
   tolerance. This weakens every vector scenario in the corpus and should be the
   last resort.

Until one is chosen, the shipped code is unchanged: the branch stays dead, the
fallback is correct, and results are right. What is wrong today is only that
`meta.accelerated` claims something untrue and that three unit tests claim
coverage they do not have.

## The `minScore` question this started as

The widening `sqlLimit = minScore === undefined ? topK : this.count(collection)`
(and its Python twin) was added for a divergence that **does not exist**:

- `score = 1 - distance` is strictly monotone, so a score floor is exactly a
  distance ceiling. Taking the k nearest and then applying the floor gives the
  same rows as applying the floor and then taking the k nearest.
- Nothing else can drop a row out of the k-window and let a lower-ranked row take
  its place: `syncVec` keeps directionless vectors out of the vec0 table entirely
  (4 vec0 rows vs 5 base rows in the probe above), and every vec0 row has a
  `vectors` row to join to.

Confirmed empirically with the branch revived, `minScore` cases A–D agreeing with
the exact path both with the widening and without it. The one case that did
diverge (E) was the tie at the topK boundary, which is not a `minScore` effect at
all — it reproduces with no `minScore` set.

**Verdict: the `minScore` gate on the widening is wrong twice over** — it guards
a non-bug, and it misses the real one, which is unconditional and unrelated to
`minScore`.

**Resolved 2026-09-02:** the strategist ruled the widening out, on the same
monotonicity argument. It is reverted in both languages —
`packages/store/src/adapters/sqlite.ts` (`searchVec`) and
`python/store/src/mirk/store/sqlite_vector.py` (`_search_vec`) now bound the KNN
by `topK` alone, and the Python `COUNT` query is gone. The tie-break hunks stay.
`conformance/vector/search-min-score-before-topk.json` stays too, as the pinned
property.

Two corrections to the record that this closes:

- **The digest's A.7 claim was wrong**, not merely unproven. It is struck through
  in `../../python-port/digests/store-vector-search.md` with the reason. A
  comment asserting a dependency's behavior is a claim, and this one was never
  probed before code was written against it.
- **"All 160 scenarios still pass with the widening reverted" is not evidence
  here**, and neither is the same statement with the widening in place. Every
  `vector/*` scenario passes on "sqlite" through the exact fallback, because the
  vec0 branch does not run. The revert is right on the monotonicity argument
  alone; the green corpus neither supports nor contradicts it. This is the same
  blind spot that let three unit tests claim vec0 coverage they never had.
