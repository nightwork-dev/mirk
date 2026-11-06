# Mirk implementation review

GLM 5.3 Flash reviewed the second-round format, log, jobs, and memory-coordination changes.
The coordinator checked the findings against complete owning helpers and runtime probes.
The reviews used the integrated snapshot `315b6ae`; the first jobs review instead read its
implementation branch at `5185557`, which contains the same jobs implementation. The separate
coordination review covered the scope that first reviewer missed.

The [first-round review](https://github.com/nightwork-dev/mirk/blob/ddeeac88663eda7b54e9bfb7c38ccbb3251ab81f/docs/reviews/2026-11-05-glm-mirk-storage-specs.md)
remains in Git history. This document records the current review outcome rather than a raw transcript.

## Confirmed corrections

- **Python runner cancellation during cleanup.** Cancelling the caller while it awaited the renewal monitor could be swallowed by that monitor, allowing the helper to return success. The monitor now propagates task cancellation. A deterministic injected-clock regression covers memory and SQLite. Ordinary external-signal cancellation still aborts the work signal and rejects the helper.
- **Duplicate or non-text format markers.** Python formerly accepted the first marker row and coerced its value to text. Admission now requires exactly one text value, matching TypeScript. Rejection leaves the file unchanged.
- **Views in canonical table positions.** Python formerly accepted a view where the current format requires a table. Canonical admission now checks actual tables. Generic collision detection still recognizes views, so this correction does not hide application objects from table-name allocation. The malformed-file regression opens the same fixtures through both Python and TypeScript.

Integration also corrected old tests that still expected format 3, built an unversioned fixture
with format-4 generation tables, or supplied a numeric log cursor. These were stale callers,
not changes to the new contract. A separate integration check caught `tryAcquire` waiting behind
memory transaction admission; the immediate-unavailable path and clock/cancellation tests cover
that correction.

## Findings checked and not adopted

- **Relative backup paths.** The claimed failure did not reproduce. SQLite's `PRAGMA database_list` returned an absolute source filename for a relative open, and explicit migration with a relative backup destination succeeded. No speculative path rewrite was added.
- **Default abort reasons.** Native `AbortController.abort()` supplies an `AbortError`. Python's `CoordinationAbortSignal.abort(None)` supplies `CoordinationAbortedError`. The claim that either normal call throws an undefined reason was false.
- **Already-aborted Python signals.** `CoordinationAbortSignal.add` immediately invokes a listener when the signal is already aborted. The proposed extra post-registration check would duplicate that behavior.
- **Renewal command replay.** A distinct command prefix per logical runner invocation is an explicit contract. Reusing it replays receipts and cannot restore expired ownership. No second renewal path or implicit invocation policy was added.
- **Ownership between checks.** The authoritative renewal operation rechecks owner token, fencing generation, state, and expiry inside its transaction. A preceding helper check does not grant write authority.
- **After-commit callback errors.** The contract makes notifications best effort and isolates failures so they do not fail a completed commit or stop later callbacks. Swallowing those errors is deliberate in both implementations.
- **Facet admission.** Python facets can receive a raw connection and call the shared admission function. The call is not a second migration algorithm. An adapter opened with `explicit` or `refuse` rejects an old file before any facet is constructed.
- **A completed backup after a failed migration.** Retaining that backup is required. A retry must select a new destination or deliberately manage the existing backup; migration never overwrites it.

## Review and runtime scope

The external reviews read the migration planner, local backup drivers, log generations,
keyed job admission, lookup and renewal, and the memory lease transaction machinery. They did
not read every adapter, the full format document, or the changed native loader. They ran no
runtime tests. Their initial reports included unsupported claims; the corrections above reflect
checked findings rather than accepting review text as authority.

The coordinator inspected native fallback classification and ran the combined backend gates,
independent golden readers, and [100k-vector benchmark](../benchmarks/vector-scale.md).
The packed application consumer exercised migration policies, backups, job preservation,
priority ordering, and its existing claim lifecycle. The libSQL implementation was split along
its existing responsibilities after the review snapshot; its complete local suite and typecheck
passed after the split.

The [implementation record](../proposals/mirk-storage-and-jobs-specifications.md#verification-and-platform-scope)
links the current contracts and explains platform and delivery limits. Native execution was
measured on macOS arm64. Environment-gated service suites and other operating systems are not
counted as executed proof.
