---
"@mirk/store": minor
"@mirk/store-postgres": minor
"@mirk/store-libsql": minor
"@mirk/store-indexeddb": minor
---

Add optional idempotency-receipt expiry. Every atomic store (the in-memory reference, both SQLite adapters, PostgreSQL, libSQL, IndexedDB, and the Python memory and SQLite stores) takes `receiptRetentionMs` and a `now` clock. Without the option, receipts are kept forever, as before. With it, a receipt is live while its age is at most the window, and a request whose key matches only an expired receipt is evaluated and applied as new. A keyed atomic write prunes at most 100 expired receipts first, and `pruneExpiredReceipts()` deletes the rest in short batches. PostgreSQL and libSQL judge age by the database's clock unless `now` is injected. Receipt tables gain a `created_at` column and index when opened; receipts from an earlier release are stamped when a store with a window first prunes. IndexedDB moves to schema version 3. The window must exceed the longest time a caller may retry or reconcile a request.

`@mirk/store` also exports `SyncAtomicStore`, `AsyncAtomicStore`, `JsonCompatible`, and the `atomicSet`, `atomicPut` and `jsonValue` helpers, which accept a caller's own JSON-shaped interfaces in atomic requests without casts. The conformance corpus gains an optional `store` block and an `advanceClock(ms)` op.
