# Mirk implementation review

GLM 5.3 Flash reviewed the storage implementation and its existing asset-service integration. The coordinator checked the findings against the owning code and runtime results. No high-severity defect was established within the reviewed scope. This is a source-review conclusion, not a claim that every platform or input was tested.

The storage reviews inspected snapshot `7d41737`. The consumer review inspected its repository snapshot `31057a3`. Follow-up commits correct the confirmed issues below. The [original specification review](https://github.com/nightwork-dev/mirk/blob/d739d0f1a4cb0913543d60e5730d761a01691393/docs/reviews/2026-11-05-glm-mirk-storage-specs.md) remains in Git history.

## Confirmed corrections

- **Python vector limits.** Native search interpolated a fractional `topK` into SQLite instead of using the reference's truncation. It now uses the shared `top_k_of` helper. Portable fraction scenarios and direct non-finite checks cover memory, ordinary SQLite, and native SQLite.
- **Legacy dimension bounds.** Python accepted an unsafe integer dimension when no vector bytes exposed the mismatch. It now applies the same safe-integer bound as TypeScript. Rejection tests verify that schema, version, metadata, and application data remain unchanged.
- **Qdrant migration errors.** Malformed legacy JSON could escape as an untyped parser error. Both languages now raise `QdrantCollectionError`, preserve the source and incomplete destination marker, and permit repair followed by resume.
- **Blocked-decision validation.** Python checked the decision after command receipt lookup, producing a different error from TypeScript. Shape validation now precedes replay. Valid replay remains unchanged; malformed and empty decisions return `invalid-input`.
- **JavaScript result shape.** The coordinator's strict public-adapter comparison found that native search omitted the optional metadata property while the ordinary engine returned it as undefined. Native results now preserve the ordinary shape. Both drivers have a strict-result regression.
- **Consumer retry diagnostics.** Retryable failure details now stay in the existing job checkpoint and projection until success.
- **Consumer cancellation failures.** A rejected cancellation now restores the prior process-local cancellation flag, so an uncommitted request cannot affect a later attempt.

The actual consumer journey also exposed setup wrappers that dropped claim/context arguments and an image route missing from Nitro's explicit image-request routing. Those paths were corrected and exercised against packed Mirk artifacts. A corrupt test PNG was replaced with an encoded fixture; no product decoder workaround was added.

## Findings not adopted

The libSQL migration already runs inside its admitted opening transaction. `LibsqlAdapterCore.initialize` wraps the private facet initialization, which makes the sole migration call. The underlying driver uses local `BEGIN IMMEDIATE` or remote `transaction("write")`. Adding another transaction would duplicate ownership. See [the caller](../../packages/store-libsql/src/libsql-core.ts) and [the shared plan driver](../../packages/store-libsql/src/libsql-format.ts).

An ownership-read failure must not be treated as proof of ownership. The suggestion to assume a lease remains owned when SQLite is busy was rejected. Backend errors remain errors; generation checks still govern authoritative writes.

Migration does not use `INSERT OR IGNORE` to conceal a conflicting destination definition. Atomic rollback already makes retry safe. Ignoring that conflict could admit vectors under the wrong dimension definition.

The native README already distinguishes the added float64 scalar from upstream float32 functions and states zero-query behavior. The jobs README already states the shared-domain log precondition and that replay cannot restore an expired claim.

Consumer recovery was already called during initialization and polling. Its reconciliation route already returned 400 for invalid generations and 409 for a valid stale generation. Regression tests confirm those paths; no extra timer or duplicate validation path was added.

## Review and runtime scope

The reviews covered the native patch and packaging, SQLite migration policy, vector engines, Qdrant migration, coordination, shared memory transactions, jobs lifecycle and validation, and the consumer's claim, recovery, provider-submission, and image-serving paths. Individual reviewers did not read every adapter, test, or provider. They ran no services or runtime tests.

The coordinator and implementation lanes ran the actual backend and consumer checks summarized in the [implementation record](../proposals/mirk-storage-and-jobs-specifications.md#verification). Native platform proof is limited to macOS arm64. Environment-gated service tests remain separate from the executed local and Qdrant proofs.
