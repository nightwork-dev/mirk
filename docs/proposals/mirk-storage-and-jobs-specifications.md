# Mirk storage and jobs implementation

The eight requested capabilities are implemented on `codex/mirk-storage-specs`. The TypeScript and Python package set is prepared as 0.15.0 and remains unpublished. Package READMEs now carry the current contracts. The [original proposal](https://github.com/nightwork-dev/mirk/blob/d739d0f1a4cb0913543d60e5730d761a01691393/docs/proposals/mirk-storage-and-jobs-specifications.md) remains in Git history.

## Implemented contracts

| Request | Result | Contract |
| --- | --- | --- |
| Named vector spaces | A document holds named vectors with independent dimensions and shared metadata. Space declarations are explicit. Replacement and deletion cover the full vector map. | [Vectors](../../packages/store/README.md#vectors) |
| Native nearest neighbors | The optional sqlite-vec engine computes exact float64 cosine, filtering, ranking, and limiting on the existing SQLite connection. It returns only final IDs, scores, and metadata to the host. | [Native companion](../../packages/sqlite-vec-native/README.md) |
| One versioned file format | Format 3 has atomic migration from recognized legacy layouts. TypeScript and Python exchange files while preserving atomic identities, tokens, receipts, log positions, and vector bytes. | [SQLite format](../../packages/store/README.md#shared-sqlite-file-format) |
| Delete a log stream | `deleteStream` removes complete history atomically. Rollback restores it. A subsequent append starts a new stream at sequence 1. | [Log](../../packages/store/README.md#append-only-log) |
| Try-acquire | One immediate attempt distinguishes acquired ownership, a held lease, and backend unavailability. Stale tokens cannot renew or release a successor. | [Coordination](../../packages/store/README.md#async-coordination) |
| Memory transactions and coordinator | Existing memory KV and log stores share rollback, savepoints, admission, and after-commit behavior. Independent coordinator handles can share explicit memory lease state. | [Memory transactions](../../packages/store/README.md#transactions-across-memory-stores) |
| Injected coordinator clock | The injected clock controls expiry, retry, renewal, and acquisition deadlines. Cancellation can wake a waiting operation without advancing time. | [Coordination](../../packages/store/README.md#async-coordination) |
| Jobs storage | `@mirk/jobs` and `mirk-jobs` provide transactional claims, stable worker tokens, command replay, checkpoints, cancellation, blocked recovery, and terminal cleanup. Applications retain execution policy. | [Jobs](../../packages/jobs/README.md) |

This minor release changes the pre-1.0 vector API. Replace `vector` with a named `vectors` map, declare spaces, and select a space when searching. SQLite coordination imports move to `@mirk/store/coordination/sqlite`; the coordination port remains native-free. Existing Qdrant unnamed collections use an explicit recoverable copy migration with one runner and quiesced writers.

## Verification

**Measured:** the generated corpus contains 500 scenarios. Its TypeScript replay covers memory, both local SQLite drivers where applicable, and the Markdown backend. Python replays the same contracts. Separate tests cover real process contention, killed workers, concurrent migration, rollback, read-only rejection, and file exchange.

**Measured:** the integrated real Qdrant 1.19.2 harness passed 53 TypeScript tests and 48 Python tests with no skips, plus bidirectional exchange. Local libSQL and embedded SurrealDB tests passed. Remote sqld, Turso, PostgreSQL, and selected external-service suites remain environment-gated; they are not counted as executed proofs.

The native companion preserves the existing numerical contract through a small patch to pinned sqlite-vec 0.1.6. The original float32 functions remain intact. The added scalar performs ordered float64 accumulation and returns similarity directly. No host-language population scan or silent fallback remains in the native engine.

**Measured:** a synthetic same-file fixture contained 1,000 records, each with a 768-component text vector and a 1,024-component image vector. Seven warm text searches with `topK: 10` had median times of 6.39 ms for the ordinary engine and 1.74 ms for the native engine. The complete JavaScript result objects matched exactly. These measurements describe that fixture, not production capacity.

Native npm installation and Python source-to-wheel installation were exercised on macOS arm64, including Python 3.12.15 and 3.13. Other native platform builds remain unverified. Compilation occurs during installation or build, never during a query.

The existing llm-service consumer was exercised against packed 0.15.0 artifacts through its service, HTTP API, setup decorators, and asset view. The journey covered restart, competing dispatchers, a killed owner, blocked recovery, stale completion, cancellation, provider uncertainty, and output cleanup. The browser displayed completed, blocked, and cancellation-pending states and decoded the completed output.

## Delivery boundary

Mirk contains storage mechanisms and portable contracts. The consumer integration lives on its separate `codex/mirk-jobs-adapter` branch. Its normal dependency ranges target 0.15.0; its lockfile awaits registry publication. No package publication, installed-service replacement, or deployment is included in this change.

The [checked GLM implementation review](../reviews/2026-11-05-glm-mirk-storage-specs.md) records the confirmed corrections and the review limits.
