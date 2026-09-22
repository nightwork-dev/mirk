# @mirk/store-indexeddb

A browser source adapter for [`@mirk/store`](../store). It implements `AsyncStore` and the optional
`AsyncAtomicMutationStore` capability on native IndexedDB, and keeps key/value rows, collection
records, version tokens, and idempotency receipts in one database.

ESM-only. It needs a browser (or another runtime with an `indexedDB` global).

## Install

```bash
npm install @mirk/store-indexeddb
```

`@mirk/store` is a regular dependency.

## Usage

```ts
import { openIndexedDbAdapter } from "@mirk/store-indexeddb";

const adapter = await openIndexedDbAdapter({ dbName: "my-app" });
const store = adapter.kv;
await store.set("settings", { sound: true });
await store.mutateAtomically({
  operations: [{ op: "put", collection: "items", item: { id: "one", value: 1 } }],
});
await adapter.close();
```

| Option | Type | Notes |
|---|---|---|
| `dbName` | `string?` | IndexedDB database name. Defaults to `mirk`. |
| `atomicLimits` | `Partial<AtomicMutationLimits>?` | Request bounds. Defaults to the in-process limits. |
| `versionIdentity` | `string?` | Prefix for version tokens, used only when a new database mints its first token. Defaults to a random identity; an existing database keeps the identity it was created with. |
| `indexedDB` | `IDBFactory?` | The factory to use. Defaults to `globalThis.indexedDB`. |

## Contract

The adapter follows the [base store contract](../store/README.md#base-store-contract) and the
[atomic mutation contract](../store/README.md#optional-atomic-mutation). A browser test suite
replays the shared conformance corpus (`conformance/store/**`) against it. The optional
`listWhereIn` method is not implemented, so the scenarios that need it are not run.

- Every write (`set`, `put`, and each operation of an applied batch) issues a fresh version token.
  `delete` and `remove` clear the token. A version read before a write no longer satisfies a
  `version` condition.
- `limit` and `offset` follow the reference store: a negative `limit` returns nothing, a
  fractional one is truncated, and a negative `offset` counts as zero.
- Each call runs in one IndexedDB transaction. Each atomic request evaluates its conditions, the
  idempotency receipt, version allocation, all operations, and the receipt write in one read/write
  transaction. The promise resolves only after the transaction's `complete` event, so a caller that
  reopens the database after the await sees the committed rows.
- `readTransaction(reader)` runs a synchronous reader over keys, records, and versions read in one
  readonly transaction.

Opening a database created by an earlier release of this package upgrades it to schema version 2
and issues version tokens for keys that had none.

## Another tab changes the database

When another connection upgrades or deletes the database, the adapter closes its connection so that
the other connection is not blocked. Every later call on the adapter rejects with an
`IndexedDbConnectionError` whose code is `version-change` and whose `retryable` is `true`. Open a new
adapter to continue: after an upgrade to a newer schema that open fails with `version-too-new`; after
a delete it creates an empty database.

If another connection holds the database open and does not close it, `openIndexedDbAdapter` rejects
with code `blocked` instead of waiting. A connection that opens after the rejection is closed at
once.

## Errors

Every error class has a stable `code`.

| Class | Code | `retryable` | Meaning |
|---|---|---|---|
| `IndexedDbConnectionError` | `unavailable` | no | There is no `indexedDB` global and no factory was passed. |
| | `invalid-database-name` | no | `dbName` is empty. |
| | `blocked` | yes | Another connection holds the database open during an upgrade. |
| | `version-too-new` | no | The database has a newer schema version than this adapter. |
| | `open-failed` | yes | The open request failed for another reason. |
| | `version-change` | yes | Another connection upgraded or deleted the database. |
| | `connection-lost` | yes | The browser closed the connection (for example, site data was cleared). |
| | `closed` | no | `close()` was called. |
| `IndexedDbTransactionError` | `aborted` | yes | The transaction aborted. Nothing was written. |
| | `quota-exceeded` | no | The browser storage quota is full. Nothing was written. |
| | `unknown` | yes | Another failure. Retry an atomic request with the same idempotency key and read its receipt. |
| `IndexedDbBackupError` | `unsupported-schema`, `invalid-shape`, `invalid-row`, `duplicate-row`, `dangling-version`, `invalid-metadata`, `not-cloneable` | — | `importState` rejected the backup. The database is unchanged. |

A value that cannot be structured-cloned rejects with `AtomicMutationBackendError` code
`serialization-failure`. A non-scalar `where` value throws `StoreFilterError` from `@mirk/store`.
Invalid atomic requests throw `AtomicMutationRejectedError` before any transaction starts.
`IndexedDbTransactionError.kind` is a deprecated alias of `code`.

## Whole-store backup

`exportState()` returns every key, record, version token, and idempotency receipt, plus the version
and ordinal counters, as one object of plain rows. `importState(backup)` replaces the whole database with
such a backup in one transaction. It first validates row shapes, duplicate keys, version targets,
counters, and cloneability; a backup that fails validation throws `IndexedDbBackupError` and the
database is not changed. Keys or records in the backup without a version row are issued one.
`validateIndexedDbExport(value)` runs the same validation without writing.

The backup is a generic store format. An application that needs its own file format or profile
identity wraps it.

## Not supported

- `listWhereIn`.
- Vector and search facets.

## License

Apache-2.0
