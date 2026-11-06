# @mirk/jobs

Portable durable job storage over Mirk atomic KV and writer transactions. This package opens no connection and runs no workers. Provider calls, scheduling, wake notifications, retry policy, and reconciliation belong to the application.

```ts
import { JobsStore } from '@mirk/jobs';

const jobs = new JobsStore({
  store: db.asyncKv,
  transactions: {
    transaction: work => db.asyncTransaction(work),
    afterCommit: notify => db.afterCommit(notify),
  },
});
await jobs.enqueue({ id: 'render-17', queue: 'renders', payload: { assetId: '17' } }, { key: 'enqueue-17' });
const claim = await jobs.claimNext('renders', { key: 'dispatch-17', leaseMs: 30000 });
if (claim) {
  await jobs.checkpoint(claim, { providerRequestId: 'remote-17' }, { key: 'checkpoint-17' });
  await jobs.complete(claim, { artifactId: 'output-17' }, { key: 'complete-17' });
}
```

## Storage and authority

Supply `store: AsyncAtomicStore` and `transactions: AsyncStoreTransactions` for **the same storage domain**. Its transaction must acquire writer admission before invoking work. `NodeSqliteAdapter`/`SqliteAdapter` async methods and `createMemoryTransactions` with its bound stores provide that guarantee. Arbitrary Promise wrappers do not. An optional `log` must join this domain too. The caller owns correct domain wiring; structural interfaces cannot verify connection identity. Keep transactions short and provider calls outside them.

A jobs record is the lifecycle authority. Application statuses are projections. New records have `schemaVersion: 2`, nullable `activeKey`, `subject`, and `kind` strings, ID, queue, JSON payload, state, integer priority, enqueue/availability/update epoch milliseconds, attempt, generation, nullable owner token and expiry, JSON checkpoint/result/error, and nullable `cancellation: {requestedAt,generation}`. Job payloads reference large inputs and artifact bytes. Enqueue accepts only its declared fields; additional application metadata belongs in payload. Malformed persisted lifecycle records and command outcomes raise `invalid-input` before use.

States are `queued`, `leased`, `blocked`, `succeeded`, `failed`, `cancelled`. `get(id)` returns `{value,version}` or null. `list({queue?,subject?,kind?,state?,sortBy?,sortDir?,limit?})` delegates filtering, sorting and limiting to the backing store. It requires `ensureIndex`, declares indexes for selected filters and sort field, and defaults to `updatedAt` descending. `sortBy` also accepts `enqueuedAt` or `priority`; `sortDir` accepts `asc` or `desc`. Equal sort values retain collection insertion order. This replaces the former composite priority order for inspection; `claimNext` retains priority descending, enqueue time ascending, and code-point ID ordering. SQLite uses real JSON expression indexes; the memory implementation is the semantic reference.

A stable claim is `{jobId,ownerToken,generation}`. Renewal and checkpoints change the KV version without changing this claim. Each worker transition reads the latest version after writer admission and checks state, ownership, generation, and `expiresAt > now`. This protected clock decision defines validity. `now` and `token` are injectable; defaults use epoch milliseconds and UUIDs. Expiry and availability boundaries are inclusive.

## Keyed admission and logical schema

`start({key,id?,queue,payload,subject?,kind?,priority?,availableAt?}, {key: commandKey})` returns `{started,job}`, where `job` is versioned. The active key is scoped to `[collection,queue,key]` and is distinct from the collection-scoped command key. Within one writer transaction it returns the existing queued, leased, or blocked job with `started:false`, or creates a queued job with `started:true`. Different proposed IDs, payloads, or metadata do not replace existing active work. Cancellation-pending leased work and blocked provider uncertainty retain the key. All terminal transitions release the matching slot in the same atomic mutation as the job. Explicit requeue of a terminal record must reacquire its key and conflicts if another active job now owns it.

The slot is an ordinary KV entry named `mirk-jobs-active:` plus canonical JSON `[collection,queue,key]`, containing the job ID string. Admission never scans the collection. A pointer to a missing or terminal job is repaired in the transaction. A conflicting active pointer is rejected. Generated IDs use the injected token factory only on creation. Caller-proposed IDs must be absent; terminal IDs can be reused after explicit removal. Same-command retries return the historical start outcome even if it has since ended; call `get` for current authority. Start does not acquire a worker claim or submit a provider request.

Validated logical schema-1 records normalize to schema 2 with null metadata on reads without changing storage or version tokens. The next lifecycle mutation writes schema 2. Existing receipt snapshots normalize the same way on replay, without rewriting receipts or arbitrary collections. This logical upgrade is separate from the SQLite file format.

## Commands

Every mutation requires a final `{key: string}` argument. `claim` and `claimNext` instead take `{key,leaseMs}`. Keys are scoped to the configured collection (default `mirk-jobs`), across all operations. Use one key per logical caller intent. Reusing it with different arguments raises `idempotency-conflict`. Durable command outcomes commit with transitions and remain indefinitely, including after terminal removal. Replays resolve before allocating clocks/tokens. Historical replay results are snapshots; use `get` to inspect current state. Claim replay checks current ownership and expiry and never restores authority. A previously empty claim command stays empty on replay; discovery attempts need new keys.

- `enqueue({id,queue,payload,priority?,availableAt?}, command)` creates once; priority defaults to zero and availability to enqueue time.
- `claim(id, options)` and `claimNext(queue, options)` return a claim or null for absent/ineligible work. Backend failures propagate distinctly from null.
- `renew(claim, leaseMs, command)`, `checkpoint(claim, value, command)` preserve claim identity.
- `complete(claim, result, command)`, `fail(claim, error, command)`, `retry(claim, availableAt, command)`, `block(claim, checkpoint, command)` perform fenced transitions and return versioned jobs.
- `requestCancel(id, command)` cancels queued/blocked jobs immediately or records an active attempt's request. Terminal jobs remain terminal. Active cancellation prevents complete/fail/retry; renew/checkpoint/block remain available for orderly shutdown and reconciliation.
- `acknowledgeCancel(claim, command)` commits cancelled state for a valid attempt with a cancellation request.
- `recoverExpired(id, expectedGeneration, command)` fences the expired attempt, increments generation, and blocks it while retaining checkpoint and cancellation. Expiry never proves a remote provider stopped.
- `resolveBlocked(id, expectedVersion, decision, command)` accepts `{state:'queued',availableAt}`, `{state:'succeeded',result}`, `{state:'failed',error}`, or `{state:'cancelled'}`. Pending cancellation permits only cancellation.
- `removeTerminal(id, expectedVersion, command)` removes terminal records. Optional `deleteHistoryOnRemove: true` deletes the configured log stream in the same transaction; command receipts and per-ID generation markers remain. Generation markers fence old claims when an ID and an injected token are reused. The stream name is canonical JSON `[collection,id,incarnation]`. The initial incarnation is zero; after removal it is the retained generation plus one, so old history cursors do not address the new incarnation.

Worker mutations return versioned jobs; administration uses their versions. Rejected transitions throw `JobsError` with a stable `code`. Backend errors propagate. No operation promises exactly-once provider effects. Poll durable queued state after missed notifications. Applications must reconcile blocked attempts before dispatching them again.

Python's `mirk-jobs` uses the same record fields, method names, argument dictionaries, receipt keys, and command intent encoding. Both languages can continue the same SQLite jobs records and command outcomes.

Administrative consumer operations: `updateQueued(id, expectedVersion, {priority?,availableAt?}, command)` changes eligible queue metadata, and `requeueTerminal(id, expectedVersion, {availableAt?}, command)` explicitly retries a terminal job. Requeue advances generation, clears cancellation, checkpoint, result, and error, and preserves attempt count until the next claim. Both use durable command replay and conditional versions; neither permits payload mutation.

## One-claim renewal helper

TypeScript `runClaim(jobs, claim, {leaseMs,renewEveryMs,commandKey,clock?,signal?}, async signal => value)` and Python `await run_claim(jobs, claim, lease_ms=..., renew_every_ms=..., command_key=..., clock=..., signal=..., work=...)` operate on one already acquired claim. They renew immediately and periodically, pass a cooperative abort signal to work, detect pending cancellation or ownership loss, and remove pending sleeps and external abort listeners on every exit. Work that ignores abort must still settle; the helper cannot force it to stop. An aborted or lost claim cannot produce a successful helper return, even if work resolves successfully. The caller completes, fails, or reconciles the job after the helper returns; the helper changes no terminal state and does not submit providers. Do not finalize the claim inside the callback.

Use a distinct command-key prefix for each logical helper invocation. Renewal keys include this prefix, stable claim identity, and a sequence number; a retried invocation reuses its receipts and must still hold a currently valid claim. This provides storage replay, not exactly-once callbacks or provider effects. Supply the same epoch clock used by JobsStore. `renewEveryMs` must be positive and less than `leaseMs`; cancellation polling occurs at this interval. The default clock is the native-free shared coordination clock. Python uses `CoordinationAbortSignal` and `SystemClock` from `mirk.store.coordination`; TypeScript uses native `AbortSignal`.
