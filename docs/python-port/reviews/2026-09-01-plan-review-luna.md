# 2026-09-01 — plan review, codex gpt-5.6-luna (xhigh), fresh context

Reviewed: docs/python-port-spec.md, docs/python-port/plan-phase1.md, handshake evidence, digests. Findings folded into spec and plan the same day; see the spec's 'Review outcomes' section.

## 1. Acceptance criteria

Mostly right, but insufficient for real compatibility.

- Acceptance 1 can pass while the public Python adapter is broken: the handshake predates the package and used raw-table Python inserts, which skipped atomic bookkeeping and made TypeScript versioned reads wrong ([handshake:3-16, 62-67](../../evidence/python-port/2026-09-01-handshake.md)).
- Acceptance 2 can pass with incomplete discovery or skips. P0 explicitly permits recorded skips ([plan:98-108](../plan-phase1.md)); equal executed counts do not prove equal corpus coverage. Heritage requires per-family lower bounds ([heritage:454-455](../digests/heritage-pin-derive.md)).
- Acceptance 3 is purely static and can pass a runtime-broken adapter ([spec:214](../../python-port-spec.md)).
- Acceptance 4 only falsifies Python memory ordering. It says nothing about opening TypeScript-written SQLite files or TypeScript reading Python-written files ([spec:215-216](../../python-port-spec.md)).

Add a mandatory public-API SQLite exchange against freshly built `dist`, plus per-family discovered/executed counts and zero-skip assertions.

The one-off manual falsification in I1 is expendable once a durable mutation/negative test exists; retain the named corpus scenario.

## 2. Contradictions and uncheckable claims

- **Freshness gate:** the spec says generation does `rm -rf` first ([spec:74-82](../../python-port-spec.md)), but T0 says `conformance:current` must detect a hand-edited file ([plan:84-87](../plan-phase1.md)). Regeneration can overwrite the edit before comparison. Generate into a temporary directory and diff, or compare before replacement.
- **Out-of-contract inputs:** T1 says one scenario per every `[P]`/`[D]` item ([plan:135-136](../plan-phase1.md)), but the digest includes `undefined`, `Date`, and non-finite numbers ([store-kv-collection:325-333](../digests/store-kv-collection.md)). The spec explicitly excludes those from the JSON corpus ([spec:151-154](../../python-port-spec.md)). T2’s NaN scenario has the same problem ([plan:160-162](../plan-phase1.md)).
- **Exact throws:** the format stores only a message ([spec:106-113](../../python-port-spec.md)). The runner must explicitly compare `str(exception)` and reject both wrong exception and no exception; the plan does not specify that cross-language rule.
- **`ids`:** `ids` checks only the ordered identifier list, not score, metadata, or returned record contents ([spec:106-110](../../python-port-spec.md)). That is valid only if search deliberately contracts ranking/set and nothing else ([plan:231-233](../plan-phase1.md)); meta-filter scenarios need separate exact assertions.
- **Float32:** a public get/replay scenario can verify rounded numbers, not byte-identical SQLite blobs. The byte requirement is in the spec ([spec:201-205](../../python-port-spec.md)); add a direct blob assertion or retain a real cross-language file test.
- **Ordering:** the digest still describes string sorting as byte/code-unit order ([store-kv-collection:181-183](../digests/store-kv-collection.md)), while the spec and T1 require Unicode code-point order ([spec:169-170](../../python-port-spec.md); [plan:127-132](../plan-phase1.md)). The newer ruling must win. Keep this distinct from `hashName`, which must remain UTF-16-code-unit based for SQLite table compatibility ([handshake:57-61](../../evidence/python-port/2026-09-01-handshake.md)).
- **Stable ties:** “insertion order” is stronger than SQLite `rowid` as a final key ([spec:140](../../python-port-spec.md)). Rowid is not a formal insertion sequence under deletion/reuse. The plan needs a durable sequence column or a proof that the existing lifecycle makes rowid monotonic.

## 3. Most likely spec ruling to bite a consumer

- The risky ruling is Python copying on read/write while TypeScript exposes live references ([spec:156-158](../../python-port-spec.md)).
- This is observable store behavior, not merely an implementation detail.
- A consumer mutating an object after `put` or mutating a listed object gets different results by language.
- The corpus cannot observe this, so it silently permits a real semantic divergence.
- Make both implementations copy, or explicitly document and scenario-pin the difference.

## 4. Missing first-hour guidance

- The “disjoint files” claim is false: P1, P2, and P3 all modify/register the shared Python runner ([plan:215, 233, 243](../plan-phase1.md)). Assign one owner or serialize those edits; also lock generator/build/test commands because generation deletes the corpus.
- P0 runs Node against `packages/store/dist` ([plan:103-111](../plan-phase1.md)), but no prerequisite rebuild or freshness check exists. Build `@mirk/store` immediately before the compatibility test and verify the tested commit/artifact.
- Pin corpus discovery to repository-root `conformance/` and report every loaded path/family ([spec:51-64](../../python-port-spec.md)). Fail on missing directories or zero scenarios.
- Make skips countable and fatal in the completed phase. P0 permits data-driven skips ([plan:101-102](../plan-phase1.md)); I1 says none remain ([plan:254-255](../plan-phase1.md)), but supplies no assertion. Add per-port/per-capability skip counts and lower bounds.

## 5. Delete

- Delete NaN from the JSON conformance corpus; it is invalid for the stated contract ([spec:151-154](../../python-port-spec.md)).
- Delete the T2 `whereNot` comment-only cleanup; it does not change the port contract ([plan:157-158](../plan-phase1.md)).
- Delete I1’s manual falsification only after replacing it with a durable mutation test; otherwise retain it as the sole proof that the guard can fail.
