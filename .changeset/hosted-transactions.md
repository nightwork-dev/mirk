---
"@mirk/store": minor
"@mirk/store-postgres": minor
"@mirk/artifact": minor
"@mirk/artifact-vercel-blob": minor
---

Add the `AsyncStoreTransactions` contract: `transaction(work)` with nested savepoints, and `afterCommit(notify)` callbacks that run once, in order, after the outermost commit and never after a rollback. `@mirk/store/transaction` provides `AsyncTransactionCoordinator` for adapters that implement it.

`@mirk/store-postgres` now implements versioned reads, atomic mutations with durable idempotency receipts, and the transaction contract. Writes to one schema are serialized by a transaction-scoped advisory lock, so a compare-and-set from another host never succeeds against a replaced version, and an idle-in-transaction timeout (`transactionIdleTimeoutMs`, default 60 s) frees the lock held by a stalled host. Version tokens are never reissued after a rollback, here and in the SQLite adapters. Opening an adapter adds version columns to existing tables.

The SQLite adapters gain `asyncKv`, `asyncTransaction`, and `afterCommit`. Awaitable work is serialized per file within a process; synchronous facets throw `async-operation-active` while it owns the file. `namespaceAsyncStore` binds an `AsyncStore` the way `namespaceStore` binds a `SyncStore`.

`@mirk/artifact` adds `ObjectWriteIndeterminateError`: when an object store cannot tell whose bytes landed, the coordinator keeps the object and fails the write with `cleanup: "preserved-indeterminate"`. A later write that finds identical left-over bytes at its object key adopts them; different bytes fail with `object-key-occupied`. The new `@mirk/artifact-vercel-blob` package stores artifact bytes as private Vercel Blob objects and lists them for maintenance.
