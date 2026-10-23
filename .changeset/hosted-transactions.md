---
"@mirk/store": minor
"@mirk/store-postgres": minor
"@mirk/artifact": minor
"@mirk/artifact-vercel-blob": minor
---

Add the `AsyncStoreTransactions` contract: `transaction(work)` with nested savepoints, and `afterCommit(notify)` callbacks that run once, in order, after the outermost commit and never after a rollback. `@mirk/store/transaction` provides `AsyncTransactionCoordinator` for adapters that implement it.

`@mirk/store-postgres` now implements versioned reads, atomic mutations with durable idempotency receipts, and the transaction contract. Writes to one schema are serialized by a transaction-scoped advisory lock, so a compare-and-set from another host never succeeds against a replaced version. Opening an adapter adds version columns to existing tables.

The SQLite adapters gain `asyncKv`, `asyncTransaction`, and `afterCommit`. Awaitable work is serialized per file within a process; synchronous facets throw `async-operation-active` while it owns the file. `namespaceAsyncStore` binds an `AsyncStore` the way `namespaceStore` binds a `SyncStore`.

`@mirk/artifact` adds `ObjectWriteIndeterminateError`: when an object store cannot tell whose bytes landed, the coordinator keeps the object and fails the write with `cleanup: "preserved-indeterminate"`. The new `@mirk/artifact-vercel-blob` package stores artifact bytes as private Vercel Blob objects.
