---
"@mirk/store": minor
---

Atomic mutation request limits are now per backend and overridable at construction.

The three request bounds were a single fixed set applied before any backend was chosen. They guard a wire contract, so the conservative values only make sense for a request that actually crosses a wire. `InMemoryKv` and `SqliteAdapter.kv` never leave the calling process and commit one local `BEGIN IMMEDIATE`, so both now carry `IN_PROCESS_ATOMIC_LIMITS` — 4096 operations, 1024 conditions, 16 MiB — instead of 128/128/1 MiB. Measured on a file database: a 4096-operation batch commits in 67 ms and grows the WAL by 1.35 MB, and a request at the 16 MiB byte cap commits in 293 ms. `DEFAULT_ATOMIC_LIMITS` keeps the old portable values for a remote or unknown transport.

Both stores accept `atomicLimits` at construction to override any field, `validateAtomicRequest` takes the limits as a second argument, and a rejection now names the limit and its value (`request has 11 operations; this store's maxOperations is 10`). `namespaceStore` and `toAsync` enforce and report the inner store's limits unchanged.

`MAX_ATOMIC_OUTCOME_BYTES` stays a hard 64 KiB cap in every backend and cannot be raised. An idempotency outcome is persisted under its key for the life of the receipt, and v1 receipts do not expire.

**Breaking for third-party implementers.** `SyncAtomicMutationStore` and `AsyncAtomicMutationStore` gain a required `readonly atomicLimits: AtomicMutationLimits` member, and `supportsAtomicMutation` / `supportsAsyncAtomicMutation` now require it to be present. An outside store that implements the capability without the member stops type-checking and is no longer detected by the guards. Adding `atomicLimits = DEFAULT_ATOMIC_LIMITS` restores the previous behavior exactly. This ships as a minor rather than a major because the capability is optional, no first-party consumer implements it, and every in-repo caller reads the member rather than assuming a constant.

`MAX_ATOMIC_OPERATIONS`, `MAX_ATOMIC_CONDITIONS`, and `MAX_ATOMIC_REQUEST_BYTES` remain exported with their old values and are marked deprecated; read `store.atomicLimits` instead.
