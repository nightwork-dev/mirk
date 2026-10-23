---
"@mirk/store-libsql": minor
---

Add atomic writes and transactions. `adapter.kv` now implements `AsyncAtomicMutationStore` (`getVersioned`, `mutateAtomically`, durable idempotency receipts), and the adapter implements `AsyncStoreTransactions` (`transaction(work)` with nested savepoints, and best-effort `afterCommit(notify)`), from both `@mirk/store-libsql` and `@mirk/store-libsql/remote`.

Every write, and every transaction, starts with `BEGIN IMMEDIATE`, so writers on all hosts take turns on the database's one write lock: on a server each transaction runs on its own interactive stream, and on a local file adapters in one process take turns and retry while another process holds the lock (`busyTimeoutMs`, default 30 s). Every `set` and `put` now issues a version token, using the same tables as `@mirk/store/sqlite`; a token issued inside rolled-back work is never issued again. A transaction the database fails under rolls back and rejects with a typed `LibsqlAdapterError` (`busy`, `transaction-expired`, `connection-lost`, or `commit-indeterminate`).

New options: `tablePrefix` lets several stores share one database, and `atomicLimits` and `versionIdentity` match the other atomic adapters. Opening an adapter now initializes its tables in one transaction.
