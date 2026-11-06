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

A jobs record is the lifecycle authority. Application statuses are projections. Every record has `schemaVersion: 1`, ID, queue, JSON payload, state, integer priority, enqueue/availability/update epoch milliseconds, attempt, generation, nullable owner token and expiry, JSON checkpoint/result/error, and nullable `cancellation: {requestedAt,generation}`. Job payloads reference large inputs and artifact bytes.

States are `queued`, `leased`, `blocked`, `succeeded`, `failed`, `cancelled`. `get(id)` returns `{value,version}` or null. `list({queue?,state?,limit?})` returns versioned records ordered by priority descending, enqueue time ascending, and Unicode code-point ID ascending. Filtering and ordering precede the limit. No candidate cap is imposed.

A stable claim is `{jobId,ownerToken,generation}`. Renewal and checkpoints change the KV version without changing this claim. Each worker transition reads the latest version after writer admission and checks state, ownership, generation, and `expiresAt > now`. This protected clock decision defines validity. `now` and `token` are injectable; defaults use epoch milliseconds and UUIDs. Expiry and availability boundaries are inclusive.

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
- `removeTerminal(id, expectedVersion, command)` removes terminal records. Optional `deleteHistoryOnRemove: true` deletes the configured log stream in the same transaction; command receipts remain. The stream name is canonical JSON `[collection,id]`; reuse requires the application to account for history incarnation.

Worker mutations return versioned jobs; administration uses their versions. Rejected transitions throw `JobsError` with a stable `code`. Backend errors propagate. No operation promises exactly-once provider effects. Poll durable queued state after missed notifications. Applications must reconcile blocked attempts before dispatching them again.

Python's `mirk-jobs` uses the same record fields, method names, argument dictionaries, receipt keys, and command intent encoding. Both languages can continue the same SQLite jobs records and command outcomes.

Administrative consumer operations: `updateQueued(id, expectedVersion, {priority?,availableAt?}, command)` changes eligible queue metadata, and `requeueTerminal(id, expectedVersion, {availableAt?}, command)` explicitly retries a terminal job. Requeue advances generation, clears cancellation, checkpoint, result, and error, and preserves attempt count until the next claim. Both use durable command replay and conditional versions; neither permits payload mutation.
