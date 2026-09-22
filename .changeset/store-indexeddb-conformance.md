---
"@mirk/store-indexeddb": minor
---

The adapter now passes the shared store conformance corpus in a real browser.

Breaking: `openIndexedDbAdapter` is the only factory. The `createIndexedDbStore`, `createIndexedDBStore`, `createIndexedDbAdapter`, `openIndexedDBAdapter`, and `createIndexedDBAdapter` aliases, the `IndexedDBAdapter` class alias, `IndexedDbAdapter.open`, and the `export()`/`import()` method aliases are removed; use `openIndexedDbAdapter`, `exportState()`, and `importState()`. Open failures are now `IndexedDbConnectionError` (previously `AtomicMutationBackendError` or `Error`), and backup validation failures are `IndexedDbBackupError`.

Fixes:

- `set()` issues a fresh version token, so a version read before a plain write no longer satisfies a `version` condition, and `readTransaction().getVersioned` sees keys written with `set()`.
- `limit` and `offset` clamp like the reference store instead of throwing.
- The default version identity is random per database instead of a per-page counter. Opening a v1 database re-issues every key version under a random identity, so a token handed out by the earlier adapter can no longer satisfy a condition.
- When another connection upgrades or deletes the database, the adapter closes its connection and later calls reject with `IndexedDbConnectionError` code `version-change`. A blocked open rejects with code `blocked` and closes the connection if it opens later; a newer schema rejects with the non-retryable code `version-too-new`.
- Transaction errors report the failing request's error.
- `get` and `getById` return `null` for a stored `undefined`.
- `list` and `count` read through the `collection` index, and `getVersioned` uses a readonly transaction.
- Opening a database from an earlier release upgrades it to schema version 2 and issues version tokens for keys that had none; `importState` does the same for unversioned rows.

`IndexedDbTransactionError` has a `code`; `kind` remains as a deprecated alias. Error classes set `name` on the prototype.
