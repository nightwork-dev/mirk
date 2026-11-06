# Mirk storage and jobs implementation

Both rounds of storage requests are implemented on `codex/mirk-storage-specs`. The TypeScript and Python package set is prepared as **0.16.0** and remains unpublished. Package READMEs define runtime contracts; [the format specification](../format.md) defines the physical SQLite layout. The [original proposal](https://github.com/nightwork-dev/mirk/blob/d739d0f1a4cb0913543d60e5730d761a01691393/docs/proposals/mirk-storage-and-jobs-specifications.md) remains in Git history.

## Implemented contracts

| Capability | Behavior | Contract |
| --- | --- | --- |
| Named vector spaces | Each document holds vectors with independent dimensions and shared metadata. Legacy migration can name the original space. | [Vectors](../../packages/store/README.md#vectors) |
| Exact native search | The optional sqlite-vec companion performs exact cosine, filtering, ranking, and limiting inside SQLite. Missing companions use the ordinary exact engine with `accelerated: false`. Corrupt initialization and query failures remain errors. | [Native companion](../../packages/sqlite-vec-native/README.md) |
| Controlled file upgrades | Format 4 opens with `auto`, `explicit`, or `refuse`. A separate migration operation reports the result and can create a consistent, non-overwriting backup. | [Migration policy](../../packages/store/README.md#migration-policy) |
| Independent readers | The normative document records tables, columns, encodings, version admission, and evolution rules. Immutable legacy, early/late v2, v3, and v4 files accompany independent Node, Python, and Rust readers. | [Format specification](../format.md) |
| Stream lifecycle | Deletion removes history and the live stream registration. Recreation allocates a new generation. A cursor carries generation and sequence; stale cursors fail. | [Log](../../packages/store/README.md#append-only-log) |
| Coordination | `tryAcquire` makes one immediate attempt. Injected clocks control waits and expiry. The historical SQLite coordinator import remains as a deprecated re-export. | [Coordination](../../packages/store/README.md#async-coordination) |
| Memory transactions | KV, log, and explicitly attached lease state share rollback and savepoints. Rolled-back handles cannot regain authority; fencing generations never rewind. | [Memory transactions](../../packages/store/README.md#transactions-across-memory-stores) |
| Durable jobs | Transactional claims, replay, checkpoints, cancellation, blocked recovery, and terminal cleanup remain storage operations. | [Jobs](../../packages/jobs/README.md) |
| Active job per key | `start` returns the active job for a collection, queue, and key or creates one atomically. Terminal transitions release that slot. | [Keyed admission](../../packages/jobs/README.md#keyed-admission-and-logical-schema) |
| Job discovery and renewal | Indexed lookup filters subject, kind, state, queue, and recency with a limit. An optional runner renews one claim and signals cancellation or lost ownership. | [Jobs](../../packages/jobs/README.md) |

## Upgrade implications

Use a named `vectors` map, declare its spaces, and select a space when searching. Log readers must pass a cursor object rather than a bare sequence number. Job listing defaults to `updatedAt` descending; applications that schedule by priority must request and preserve their intended order.

The native-free coordination contract lives at `@mirk/store/coordination/core`. Import SQLite directly from `@mirk/store/coordination/sqlite`. The deprecated historical `@mirk/store/coordination` entry loads the optional SQLite peer. Memory coordination stays native-free.

Quiesce existing clients before a file upgrade and reopen them afterward. An injected SQLite coordinator uses its own connection and does not join KV/log transactions. Memory lease participation is explicit. External effects, clocks, and cancellation sources do not roll back.

Jobs schema 1 records normalize to schema 2 on read without changing their stored version. A later authoritative write persists the new shape. Command receipts return their historical result; they do not rerun application work. The runner does not choose completion, failure, retry, or provider policies.

## Verification and platform scope

The generated corpus contains **505 scenarios** shared by TypeScript and Python. Separate regression tests exercise migration refusal, backups with WAL data, competing starts, process contention, generation cursors, memory lease rollback, and cooperative renewal. Independent golden checks do not open files through Mirk adapters. Their Rust example pins format 2 and refuses formats 3 and 4.

The [scale benchmark](../benchmarks/vector-scale.md) compares the ordinary and native engines through the public API. Both are exact scans; native execution does not imply an approximate index or sublinear search.

Native installation requires the documented compiler toolchain. macOS arm64 builds were exercised; other platform builds remain unverified. Compilation occurs during installation or build, never during a query. Missing companions retain exact search and report `accelerated: false`.

## Delivery boundary

Mirk owns storage mechanisms and portable contracts. The existing llm-service integration lives on its separate `codex/mirk-jobs-adapter` branch and consumes normal published dependency versions. Its dependency lock awaits publication. Package publication, installed-service replacement, and deployment are outside this change.

The [checked GLM review](../reviews/2026-11-05-glm-mirk-storage-specs.md) records the review scope, confirmed corrections, and remaining limits.
