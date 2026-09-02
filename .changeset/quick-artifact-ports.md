---
"@mirk/artifact": minor
---

Three changes in preparation for the Python port's deterministic corpus. The new options are additive; the ordering and error-precedence changes below are observable behavior changes for existing consumers, which is why this is a minor and not a patch.

`ArtifactMaintenance` accepts an `auditIdFactory` option; `audit()` no longer always mints its own random audit id, so a caller (or a corpus generator) can inject one and see it as `report.auditId` and, through it, in every repair action's fingerprinted id. `StoreArtifactRepository` accepts a `leaseIdFactory` option, matching `InMemoryArtifactRepository`'s existing `leaseIdFactory`, so a store-backed object lease's id is no longer necessarily `lease-<timestamp>-<random>`.

Every `localeCompare` call in `@mirk/artifact` (object listing in `InMemoryObjectStore` and `FileObjectStore`, and the id tie-break in artifact record paging) now sorts by Unicode code point instead of ICU collation, matching the rest of Mirk. This can reorder listings that contain keys or ids whose ICU order and code-point order disagree (case, underscores, and non-ASCII letters are the common cases).

`InMemoryArtifactRepository.addLineage` now checks that both endpoints exist before checking for a cycle, matching `StoreArtifactRepository`'s order. A lineage edge that is simultaneously a cycle (including a self-edge) and missing an endpoint now raises `lineage endpoints must exist` from both repositories, not `lineage cycle forbidden` from the in-memory one.

Also fixed in passing: `InMemoryArtifactRepository`'s constructor `now` option was documented as driving lease timing but `acquireObjectLease`/`renewObjectLease` silently used `Date.now()` instead. They now use the injected clock, matching `StoreArtifactRepository`.
