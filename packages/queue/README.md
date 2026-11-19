# @mirk/queue

> **A durable work queue stored in your Mirk database.** Enqueue items, let one worker at a time
> claim each, and record how it ended, with safe retries and no item run twice by two holders.

## Why

Background work (renders, exports, calls to a slow service) needs somewhere to wait, and someone
has to take each piece and report back. A list in memory is lost on restart. A queue server is one
more thing to run. And the hard parts are always the same: two workers must not take the same item,
a worker that dies must not hold its item forever, and a request sent twice must not enqueue or
finish twice.

`@mirk/queue` keeps the queue as ordinary records in a [`@mirk/store`](../store) database that you
already open, such as a SQLite file or memory in tests. Each change is one atomic write:

- **Claims with leases.** `claimNext` gives one worker an item for a fixed time. The worker renews
  the lease while it works. A claim that expires or is replaced can no longer change the item.
- **Safe retries.** Every change takes a command key. Sending the same command again returns the
  first answer instead of acting twice.
- **One active item per key.** `start` admits at most one unfinished item for a key, such as "the
  thumbnail for asset 17", and returns the existing one if it is still running.
- **A clear end state.** Items finish as `succeeded`, `failed` or `cancelled`, with your result or
  error stored on the item.

It is storage, not a worker system. It opens no connection, runs no loops and has no retry or
scheduling policy. Your code decides when to poll, how many workers to run, and what to do after
a failure.

## Install

```bash
npm install @mirk/queue @mirk/store
```

ESM only. Node 22.23.4+, 24.22.1+ or 26.12.1+. The SQLite example below uses `node:sqlite`, which
needs Node 24 or later.

## A first look

```ts
import { NodeSqliteAdapter } from "@mirk/store/node-sqlite";
import { QueueStore } from "@mirk/queue";

const db = new NodeSqliteAdapter({ path: "app.db" });
const queue = new QueueStore({
  store: db.asyncKv,
  transactions: {
    transaction: (work) => db.asyncTransaction(work),
    afterCommit: (notify) => db.afterCommit(notify),
  },
});

// A producer adds an item. The command key makes a repeated call harmless.
await queue.enqueue(
  { id: "render-17", queue: "renders", payload: { assetId: "17" } },
  { key: "enqueue-render-17" },
);

// A worker claims the next item for 30 seconds, does the work, and records the result.
const claim = await queue.claimNext("renders", { key: "worker-a:claim-1", leaseMs: 30_000 });
if (claim) {
  await queue.complete(claim, { url: "/renders/17.png" }, { key: "complete-render-17" });
}

(await queue.get("render-17"))?.value.state; // "succeeded"
db.close();
```

In tests, use the in-memory store with `createMemoryTransactions` from `@mirk/store/transaction`:

```ts
import { InMemoryKv, toAsync } from "@mirk/store/kv";
import { InMemoryLogStore } from "@mirk/store/log";
import { createMemoryTransactions } from "@mirk/store/transaction";

const kv = new InMemoryKv();
const log = new InMemoryLogStore();
const queue = new QueueStore({
  store: toAsync(kv),
  transactions: createMemoryTransactions({ kv, log }),
});
```

## Items and states

An item is a record in the queue's collection (default `mirk-queue`). It holds your `id`, `queue`
name and JSON `payload`, an integer `priority` (default 0), an `availableAt` time (default now),
optional `subject` and `kind` labels, the lease fields, `claimCount`, and the `checkpoint`,
`result` and `error` you store. Put large inputs and output files elsewhere, for example in
[`@mirk/artifact`](../artifact), and keep references in the payload.

| State | Meaning |
| --- | --- |
| `queued` | waiting; `claimNext` takes it once `availableAt` has passed |
| `leased` | a worker holds a claim until `expiresAt` |
| `blocked` | the outcome is unknown and needs a decision (for example, its lease expired) |
| `succeeded`, `failed`, `cancelled` | finished |

`claimNext(queue, options)` takes the highest `priority` first, then the oldest, then the lowest id.
`get(id)` returns `{ value, version }` or `null`. `list({ queue?, subject?, kind?, state?, sortBy?,
sortDir?, limit? })` filters and sorts in the database; `sortBy` is `updatedAt` (the default),
`enqueuedAt` or `priority`, and `sortDir` is `desc` (the default) or `asc`. Listing needs a store
with `ensureIndex`, which every SQL adapter and the in-memory store have.

All times are milliseconds since the epoch. Pass `now` and `token` to the constructor to control
the clock and the generated ids in tests.

## Claims

A claim is `{ itemId, ownerToken, generation }`. Every worker change checks, inside the write, that
the item is still `leased` to that owner and generation and that the lease has not expired. A stale
claim throws `QueueError` with code `stale-claim` and changes nothing. Renewing or checkpointing
keeps the same claim.

| Method | What it does |
| --- | --- |
| `claim(id, { key, leaseMs })`, `claimNext(queue, { key, leaseMs })` | Take one item, or return `null` when none is ready. |
| `renew(claim, leaseMs, command)` | Extend the lease. |
| `checkpoint(claim, value, command)` | Save progress on the item. |
| `complete(claim, result, command)` | Finish as `succeeded`. |
| `fail(claim, error, command)` | Finish as `failed`. |
| `retry(claim, availableAt, command)` | Put the item back in the queue for later. |
| `block(claim, checkpoint, command)` | Stop with an unknown outcome, for a person or a later check to decide. |

A worker that holds a claim over a long call can use `runClaim` to keep the lease renewed:

```ts
import { runClaim } from "@mirk/queue";

const output = await runClaim(
  queue,
  claim,
  { leaseMs: 30_000, renewEveryMs: 10_000, commandKey: "render-17:run-1" },
  async (signal) => renderAsset("17", { signal }),
);
await queue.complete(claim, output, { key: "complete-render-17" });
```

`runClaim` renews at once and then every `renewEveryMs` (which must be less than `leaseMs`), passes
an `AbortSignal` that fires when the claim is lost or cancellation is requested, and never returns
a result for a claim it lost. It changes no final state: complete, fail or block the item yourself
after it returns. It does not pick items or loop over a queue. Give each run its own `commandKey`.

## Command keys

Every change takes a final `{ key }` argument (claims take `{ key, leaseMs }`). Keys are scoped to
the queue's collection. The first call with a key stores its outcome in the same atomic write as
the change. A later call with the same key and the same arguments returns that stored outcome,
even if the item has changed since; call `get` for the current state. The same key with different
arguments throws `idempotency-conflict`. A claim replay never gives back a lease that has since
expired, and an empty claim stays empty, so each new attempt to find work needs a new key. Stored
outcomes are kept, even after the item is removed.

## One active item per key

```ts
const { started, item } = await queue.start(
  { key: "thumbnail:asset-17", queue: "thumbnails", payload: { assetId: "17" } },
  { key: "request-8812" },
);
```

`start` creates a queued item and returns `started: true`, or returns the existing unfinished item
for that key in that queue with `started: false`. A different payload or id does not replace the
running item. When the item finishes, the key is free again in the same write. `start` does not
claim the item.

## Cancellation, expiry and blocked items

- `requestCancel(id, command)` cancels a queued or blocked item at once. For a leased item it
  records the request: the worker can still renew, checkpoint or block, but not complete, fail or
  retry, and it confirms with `acknowledgeCancel(claim, command)`.
- `recoverExpired(id, expectedGeneration, command)` takes an item whose lease has expired, ends the
  old claim and moves the item to `blocked`, keeping its checkpoint. An expired lease does not prove
  the outside work stopped, which is why the item is blocked and not queued again.
- `resolveBlocked(id, expectedVersion, decision, command)` decides a blocked item: `{ state:
  "queued", availableAt }`, `{ state: "succeeded", result }`, `{ state: "failed", error }` or
  `{ state: "cancelled" }`. A pending cancellation allows only `cancelled`.

## Managing items

These take the version from `get` or `list` and throw `conflict` if the item changed since:

- `updateQueued(id, version, { priority?, availableAt? }, command)` changes a waiting item.
- `requeueTerminal(id, version, { availableAt? }, command)` runs a finished item again. Its
  checkpoint, result, error and cancellation are cleared; `start` keys are taken again.
- `removeTerminal(id, version, command)` deletes a finished item. With a `log` and
  `deleteHistoryOnRemove: true`, its history stream is deleted in the same transaction.

## History

Pass `log` (an async log from the same database, such as `db.asyncLog`) and each change appends
`{ event, item }` to a stream for that item. The stream name is the canonical JSON of
`[collection, id, incarnation]`, so an id reused after `removeTerminal` starts a new stream.

## Storage requirements

`store` must be an `AsyncAtomicStore`, and `transactions` an `AsyncStoreTransactions` over **the
same database**, whose transaction takes the write lock before the work starts. The SQLite adapters'
`asyncKv` with `asyncTransaction`, and `createMemoryTransactions` with the stores it was given, meet
this. A plain Promise wrapper does not, and the queue cannot check it for you. An optional `log`
must use the same database. Keep transactions short and make outside calls between them.

Mirk does not promise that outside effects happen exactly once. Poll for queued items in case a
wake-up notification was missed, and decide every blocked item before running it again. Rejected
changes throw `QueueError` with a `code`: `invalid-input`, `not-found`, `conflict`,
`idempotency-conflict`, `stale-claim`, `cancel-requested`, `not-blocked` or `not-terminal`. Storage
errors pass through.

The Python package `mirk-queue` uses the same records, method names and command keys, so both
languages can work on the same SQLite queue.

Records from the first item format (schema 1) are read as schema 2 and rewritten on their next
change.

## License

Apache-2.0.
