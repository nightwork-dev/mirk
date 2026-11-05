# Mirk storage and jobs specifications

Draft specifications for David, 5 November 2026.

Mirk must let an application keep named embeddings, records, event history, and job claims behind portable storage contracts. These proposals extend the existing vector, log, transaction, and coordination modules. A new jobs module owns reusable job storage and conditional transitions. Existing services retain execution, scheduling, and provider behavior.

**Status:** proposed contracts, not implemented features. “Seen” identifies current source behavior. “Assumption” identifies an interpretation of the request. API sketches define the proposed shape.

| Request | Proposed home | Main result |
| --- | --- | --- |
| 1 | `@mirk/store/vector` | Several named vectors on one document, with dimensions per space |
| 2 | SQLite source adapters and an optional `sqlite-vec` integration | Native nearest-neighbor computation on the existing connection |
| 3 | SQLite format contract in both store READMEs | One versioned format and tested migrations |
| 4 | `@mirk/store/log` | Delete an entire stream atomically |
| 5 | `@mirk/store/coordination` | Attempt ownership without waiting |
| 6 | Existing transaction engine and memory backends | Atomic KV and log changes without a database adapter |
| 7 | Shared coordination implementation | Deterministic leases, renewal, and waiting |
| 8 | Proposed `@mirk/jobs` and `mirk-jobs` | Durable jobs with atomic claims and fenced transitions |

Each new portable contract includes TypeScript and Python. Native dependencies remain optional and confined to source integrations.

## 1 Named vector spaces

An application can store text and image embeddings under one document ID, then search either space independently.

**Seen:** `VectorDocument` contains one `vector`. `VectorStoreMeta.dimensions` applies to the whole store. SQLite persists that dimension in `_vec_meta`. [Vector contract](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/packages/store/src/vector/types.ts#L14), [SQLite implementation](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/packages/store/src/adapters/sqlite-core.ts#L1375).

**Proposed API**

```ts
db.vector.ensureSpace("text", { dimensions: 768 });
db.vector.ensureSpace("image", { dimensions: 1024 });

db.vector.upsert("assets", {
  id: "asset-17",
  vectors: { text: textEmbedding, image: imageEmbedding },
  metadata: { kind: "illustration" },
});

db.vector.search(
  "assets",
  { space: "image", vector: imageQuery },
  { topK: 20, where: { kind: "illustration" } },
);
```

The dimensions above are examples supplied by the application.

**Contract**

- A space has a nonempty name, positive integer dimensions, float32 encoding, and cosine distance. Names are scoped to the vector store's logical namespace. Collections within that namespace share space definitions.
- `ensureSpace` is idempotent for an identical definition. A conflicting definition raises `space-definition-conflict`. Dimensions do not change in place. A new embedding model with different dimensions uses a new space.
- A vector document owns one ID, shared metadata, and a nonempty map of named vectors. It can omit spaces. A search only considers documents that contain its selected space.
- `upsert` replaces the document's complete vector map and metadata. Omitted vectors are removed. Partial changes use a transaction around read and replacement. Concurrent replacements do not silently merge.
- `upsertMany` validates every document and space before applying any changes. A bad dimension, unknown space, or failed write leaves the whole batch unchanged.
- `get` returns all named vectors. `count` counts documents, not embeddings. `remove` removes the document and every embedding. `listSpaces` returns definitions in code-point name order.
- Search retains prefiltering, inclusive `minScore`, descending cosine score, and code-point ID tie ordering. An unknown space is an error. A known space with no matching documents returns an empty result.
- Existing zero-vector and non-finite-vector behavior remains governed by the corpus. Search never compares vectors from different spaces. Cross-space ranking or score fusion belongs above this port.

A vector document and a KV record can use the same collection and ID. They remain separate facets. An application transaction makes changes to both atomic.

**Migration and scope**

Replace the single-vector API in a coordinated pre-1.0 release. Convert persisted embeddings to the explicit space `default`. Update owned callers to use `vectors: { default: embedding }` and an explicit search space. Replace the global dimension field with space definitions. Do not retain a second storage representation or an overloaded legacy write path.

Update both memory references, both local SQLite adapters, Python SQLite, and the existing libSQL, Qdrant, and SurrealDB vector implementations. Each adapter must report its supported contract accurately.

**Acceptance**

Store text and image vectors with different dimensions on one document. Search each, replace one complete document, remove it, and reopen the database in the other language. Verify atomic rejection of a mixed-validity batch, namespace isolation, missing spaces, and unchanged search boundaries.

## 2 Native nearest neighbor search

An application selects sqlite-vec acceleration on the same SQLite connection that owns its records and vectors. Search must not fetch and score every embedding in JavaScript or Python.

**Seen:** local SQLite search selects the collection's vectors and computes cosine in JavaScript. The Python contract also specifies an unaccelerated path. The old sqlite-vec path was removed under MR-22. [Current search](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/packages/store/src/adapters/sqlite-core.ts#L1538), [roadmap](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/docs/roadmap.md#L30).

**Proposed API**

```ts
import { NodeSqliteAdapter } from "@mirk/store/node-sqlite";
import { sqliteVecEngine } from "@mirk/store/sqlite-vec";

const db = new NodeSqliteAdapter({
  path: "assets.db",
  vectorEngine: sqliteVecEngine(),
});
```

The engine plugs into the existing vector facet. It does not open another connection or own another copy of application data. The same integration serves better-sqlite3 and Python through their extension-loading facilities.

**Execution contract**

- Load a supported, pinned sqlite-vec build when acceleration is selected. If the extension cannot load or execute, return a typed backend error. Never catch an engine error and fall back to a host-language scan.
- Use the canonical float32 BLOBs from the shared file format. The initial implementation uses native SQL distance computation, filtering, ordering, and limiting. It does not require a persistent `vec0` shadow index.
- Apply the selected space, collection, metadata filters, and score floor before the final limit. Preserve the corpus's exact JSON filter rules. In particular, `whereNot` excludes a full conjunction, not each partial match.
- Return only final result IDs, scores, and metadata to the host. Searching must not deserialize the full vector population in JavaScript or Python.
- Report the active engine and `accelerated: true` only after successful initialization. Define acceleration as native computation. Do not describe it as approximate search, sublinear search, or proof of a speedup.
- Writes, deletions, and search within a transaction see one connection's state. The file remains readable by the ordinary engine without installing sqlite-vec.

sqlite-vec documents native scalar cosine queries over ordinary tables as well as `vec0` nearest-neighbor queries. The scalar approach is the proposed starting point because it keeps one portable representation and permits the existing filters. [Official KNN guide](https://alexgarcia.xyz/sqlite-vec/features/knn.html).

**Numerical requirement**

Preserve the existing search contract, including result membership at `topK` and `minScore` boundaries. A score tolerance does not permit returning the wrong document. Preserve zero-query behavior, extreme finite magnitudes, and deterministic ties.

**Open engineering check:** the selected sqlite-vec build must be tested against the existing float64 cutoff and magnitude scenarios before the engine is considered implementable as specified. The current corpus explicitly distinguishes two vectors whose scores can collapse at float32 precision. Native scalar computation is a candidate implementation, not a demonstrated solution to that requirement. [Cutoff and magnitude scenarios](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/packages/store/scripts/scenarios/vector.ts#L619).

If the native result differs, the implementation must establish a correct native scoring or refinement strategy before landing. Fixed oversampling and sorting only a truncated candidate set do not establish correctness. Do not weaken the corpus or restore a full host scan to make the feature appear complete.

**Acceptance**

Run the shared vector corpus through the loaded extension in both languages and both Node SQLite drivers. Instrument the boundary to prove that all-vector host scoring is absent. Break extension loading and execution deliberately and verify visible errors. Compare latency and host memory against the ordinary engine on a recorded consumer dataset, with its dimensions and filters. Report measured gains and regressions without inventing a capacity limit.

## 3 One versioned SQLite format

A TypeScript process can create and update a database, then a Python process can continue using the same file. The reverse path has the same guarantee.

**Seen:** this already exists for the current format. Both implementations use schema version 2, a shared table registry, and cross-language tests. The work formalizes evolution and extends the format for named vectors. [Python file contract](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/python/store/README.md#L134), [TypeScript schema version](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/packages/store/src/sql.ts#L327).

**Contract**

- Keep `_mirk_meta.schema_version` as the authoritative format version. Package versions and database format versions are separate. Named-vector storage introduces format version 3.
- Both store READMEs must describe the same table layouts, keys, constraints, JSON representation, vector byte order, and migration behavior. The format covers KV, collections, table registry, declared indexes, search schema, vectors, log, atomic versions and receipts, and coordination tables when present.
- A file with an unsupported newer version must fail before schema or user-data mutation. A missing version is accepted only when the known legacy layout is recognized. Malformed or inconsistent version metadata is an error.
- Migrate a recognized older file atomically under the database write lock. Recheck its version after obtaining that lock. Concurrent openers converge on one migration.
- Update the version only after the new tables, copied data, and constraints are valid. Failure leaves the prior format usable. Do not reset store identity, version tokens, receipts, insertion ordering, or log positions.
- A read-only open never migrates. If migration is required, return `migration-required`. Opening a newer file with an older release never downgrades it.
- Preserve application-owned tables. Migration removes obsolete Mirk tables only when it has successfully moved their owned data.
- A portable single-file handoff uses the existing consistent backup operation or a completed SQLite checkpoint with writers closed. Copying only the main file during active WAL writes does not establish a complete copy.

**Named-vector layout**

| Table | Required logical contents |
| --- | --- |
| `_mirk_vector_spaces` | Namespace, space name, dimensions, metric, encoding |
| `_mirk_vector_documents` | Namespace, collection, ID, nullable metadata JSON |
| `_mirk_vector_values` | Namespace, collection, ID, space, little-endian float32 BLOB |

Space identity and document identity form primary keys. Each vector references an existing document and space. Deleting a vector document removes its values. The migration maps the old implicit namespace to the default namespace and the old dimension setting to space `default`.

Preserve raw vector bytes and absent metadata distinctly from an empty object. An empty legacy file with no inferred dimensions creates no space until one is declared. Validate legacy BLOB lengths before migration.

Native search operates on these ordinary tables. It does not introduce a second language-specific file format. Job records use ordinary Mirk collections with a jobs record version. Separately opened coordination files must also have documented, versioned lease tables that both languages understand.

**Acceptance**

Create in TypeScript, mutate in Python, and reopen in TypeScript. Repeat in reverse. Exercise every stored facet, atomic token, receipt, declared index, and named vector. Test version-2 migration from files written by each language, concurrent openers, migration failure, unknown future versions, and read-only opens. Compare logical contents and schema, rather than requiring identical SQLite page bytes.

## 4 Delete an entire log stream

An application that deletes a record can remove its event history in the same transaction.

**Seen:** `LogStore` exposes append, get, list, and lastSequence. Its current contract forbids deletion. Memory rollback currently restores append lengths, which is insufficient once deletion exists. [Log types](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/packages/store/src/log/types.ts#L23), [memory rollback](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/packages/store/src/log/memory.ts#L57).

**Proposed API**

```ts
const removed = db.log.deleteStream("asset/asset-17");
```

Add `deleteStream(stream): boolean` to the sync port and its Promise-returning twin. Python uses the same method spelling.

**Contract**

- Delete every entry and any per-stream bookkeeping atomically. Return true if the stream existed, otherwise false.
- After deletion, `get` returns null, `list` returns an empty array, and `lastSequence` returns zero.
- A later append creates a new stream and receives sequence 1. Old cursors do not identify this new stream. Applications that reuse record IDs must use a new stream incarnation in their stream name.
- Deletion joins the caller's transaction. Rollback restores the entire stream, including its records and sequence state.
- Concurrent append and deletion have a serial order. An append committed after deletion creates the new stream. Deletion does not permanently prevent future writers.
- Deletion of a KV record or vector document does not infer a stream name. The application explicitly deletes its record, indexes, and stream within one transaction.
- An application that requires permanent removal must invalidate the writer's record version or job generation in that same transaction. A stale writer cannot recreate history through the application's accepted write path.
- Individual entries remain immutable. This change adds whole-stream lifecycle deletion, not trimming, acknowledgement, or event delivery.

SQLite can reuse freed pages. Immediate operating-system file shrinkage is not part of `deleteStream`.

**Acceptance**

Delete an existing and an absent stream. Recreate it and verify sequence 1. Roll back deletion alone and deletion plus a new append. Exercise a competing append on another SQLite connection. Run the record-and-history deletion journey on SQLite and the shared memory transaction implementation.

## 5 Immediate lease acquisition

Recovery can attempt ownership and distinguish an active lease from a backend that cannot answer.

**Assumption:** the unfinished request means “recovery needs to understand whether another process still owns the work.” A live lease demonstrates cooperative ownership, not operating-system process liveness.

**Seen:** SQLite has a private `#tryAcquire`, but the public API only exposes `runExclusive`. The wait option must be positive, so it is not an immediate acquisition API. [Coordinator](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/packages/store/src/coordination.ts#L43).

**Proposed API**

```ts
const result = await coordinator.tryAcquire("recovery/asset-17", {
  leaseMs: 5000,
  signal,
});

if (result.status === "acquired") {
  try {
    await recover(result.lease);
  } finally {
    await result.lease.release();
  }
}
```

The result is one of:

- `{ status: "acquired", lease }`
- `{ status: "held", expiresAt }`
- `{ status: "unavailable", retryable: true }`

A lease extends the existing guard with `expiresAt`, `renew(leaseMs): Promise<boolean>`, and `release(): Promise<boolean>`. A false result means the caller no longer holds a renewable or releasable lease.

**Contract**

- Perform one atomic attempt. Do not wait in a local queue, sleep, or retry lease contention. SQLite uses a non-waiting lock attempt for this operation.
- Return `held` only after observing an unexpired lease. SQLite lock contention returns `unavailable`, because it does not prove a lease exists. Invalid input, cancellation, corruption, and other backend failures remain errors.
- An expired lease is claimable when `expiresAt <= now`. Acquisition assigns a fresh owner token and a strictly greater fencing generation. Generation history survives release and reacquisition.
- Explicit leases do not start automatic renewal. The caller renews or releases them. `runExclusive` uses the same acquisition and lease operations, with managed renewal and release in a finally block.
- Renewal succeeds only for the current, unexpired token and generation. It cannot revive an expired lease. Release is idempotent and cannot remove another owner's lease.
- `assertOwned` checks current ownership and expiry. Ownership loss aborts the guard signal. An aborted acquisition never enters caller work.
- Recovery performs its authoritative write with a current generation or version condition. Checking ownership and later writing unconditionally is insufficient fencing.

The same result contract applies to memory and SQLite. Move the native SQLite implementation into an explicitly imported source subpath. The coordination port and memory implementation must not load better-sqlite3.

**Acceptance**

Race two processes for one key. Exactly one acquires it. A second attempt returns held while the lease is live and acquires a higher generation after expiry. Verify database-busy differs from held, cancellation runs no work, and a stale renew or release cannot affect the successor.

## 6 Transactions across memory stores

Application code can atomically update KV state and append or delete log history without constructing a database adapter.

**Seen:** `AsyncStoreTransactions` is already an independent interface. `AsyncTransactionCoordinator` owns nesting, async context, and after-commit behavior. The missing part is a shared memory transaction implementation for existing participants. [Transaction engine](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/packages/store/src/transaction.ts#L1).

**Proposed API**

```ts
const kv = new InMemoryKv();
const log = new InMemoryLogStore();
const transactions = createMemoryTransactions({ kv, log });

await transactions.transaction(() => {
  kv.put("jobs", { id: "job-17", state: "queued" });
  log.append("job/job-17", { type: "queued" });
});
```

The returned object implements `AsyncStoreTransactions`. It binds the actual stores supplied by the caller. It does not copy data into replacement stores or ask an application to implement a backend adapter.

**Transaction contract**

- Extend the existing memory implementations with internal transaction participation. Reuse `AsyncTransactionCoordinator` for async ownership, nested savepoints, ended scopes, and after-commit notifications.
- Checkpoint KV values, collection contents and ordering, atomic versions, receipt state, and log contents. Follow existing token-allocation semantics. A rollback restores every observable participant state.
- Every participating operation sees the transaction's own changes. Both an exception and a rejected callback roll back all participants.
- Nested transactions use savepoints. Inner rollback restores only inner changes. Outer rollback also removes successful inner changes and discards their notifications.
- The transaction owns one memory domain across awaits. Unrelated async calls queue until it ends. Direct synchronous calls from another context fail with an active-transaction error instead of reading uncommitted state or having their writes rolled back.
- Async access extends the existing `toAsync` and `toAsyncLog` admission path. An ordinary Promise wrapper alone does not provide isolation.
- A participant belongs to at most one active transaction domain. Reject conflicting registration before work begins. Stores outside the domain are not covered.
- Existing standalone log transactions use the same checkpoint mechanism. Delete the old append-length-only rollback path once shared checkpoints replace it.
- Python provides matching memory participants and context-managed transaction ownership. Its async context must isolate tasks, with equivalent nested rollback and after-commit behavior.

The TypeScript async factory can live beside the existing Node async-context engine. Plain sync ports and memory stores retain their runtime-neutral imports.

**Memory lease coordinator**

Provide `createMemoryCoordinator` with the same public coordination contract as SQLite. A shared, explicitly supplied memory state lets independent coordinator handles contend in one process. Distinct states are isolated. Fencing generations persist for the lifetime of that state.

Lease coordination serializes cooperative work. It does not roll back application data. Memory transactions provide rollback. Keep those responsibilities separate while sharing the clock contract.

**Acceptance**

Run one application function against memory and SQLite. It updates a record and its log, then succeeds or fails after each write. Verify atomic visibility, restored receipts and versions, nested rollback, stream deletion rollback, and notification order. Hold a transaction across an await and prove another task cannot leak writes into it. Exercise two memory coordinator handles against one state.

## 7 A clock that controls coordinator timing

A test can advance time to trigger acquisition timeout, renewal, and lease expiry without waiting for wall time.

**Seen:** lease comparisons use injected `now`, while the local wait timer, retry sleep, and renewal interval use real timers. A frozen injected clock can leave acquisition polling indefinitely, while another wait path times out by wall time. [Timing implementation](https://github.com/nightwork-dev/mirk/blob/e746b39269b85e905611377391f94601d20a0e9c/packages/store/src/coordination.ts#L204).

**Proposed clock contract**

```ts
interface CoordinationClock {
  now(): number;
  sleep(ms: number, signal?: CoordinationAbortSignal): Promise<void>;
}
```

The production clock uses epoch milliseconds and real timers. A manual test clock controls both values and pending sleeps. Replace the partial `now` option with one `clock` option. Update owned callers in the same release.

**Contract**

- Compute lease timestamps and acquisition deadlines from this clock. Use its sleep operation for contention polling, local waiting, renewal, and ownership-loss checks.
- Every wake reevaluates the deadline and lease against `clock.now()`. A timer firing does not itself prove that a deadline passed.
- A frozen manual clock leaves timed waits pending. Advancing the clock and draining due tasks makes them progress. Freezing time is not a timeout.
- Renew only before expiry. If time advances beyond expiry before renewal runs, renewal fails and the guard loses ownership. It must not renew retroactively.
- Cancellation wakes waiting operations without requiring clock advancement. Cleanup removes pending sleeps and abort listeners when an operation ends.
- Waiting on the same coordinator instance must not hide expired ownership behind an unresolved prior callback. An expired owner is fenced and signaled, and a contender can acquire a higher generation.
- At the deadline, a positive-duration wait times out before another acquisition attempt. A zero wait performs one immediate attempt. `tryAcquire` never schedules a sleep.
- Coordinators sharing durable lease state use comparable epoch clocks. Tests give all handles the same manual clock. SQLite's native lock timeout remains a separate bounded backend wait, not a lease clock.

Run the same lease state machine for memory and SQLite. Backend code supplies atomic lease operations. It does not duplicate retry, renewal, and expiry policy.

**Acceptance**

Hold a lease, advance just before expiry, then exactly to expiry. Verify ownership changes at the boundary. Test renewal before expiry, a jump past expiry, frozen time, timeout in each wait path, cancellation, and stale release. A separate real-process test verifies SQLite arbitration with the production clock.

## 8 Durable jobs storage

Provide a small `@mirk/jobs` package, with a matching Python package, for portable queued records, atomic claims, lease renewal, and fenced completion. Applications retain their workers, provider calls, retry decisions, and user interfaces.

**Seen:** the earlier evaluation recommended Mirk implementations behind existing consumer interfaces. It found reusable storage mechanisms and cautioned against a second execution framework. The current request adds an explicit Mirk jobs module. This proposal narrows that module to shared storage and transitions. Prior evaluation: `studio-docs/proposals/mirk-job-queue-adapter.md` (private source), prior evaluation chat (private source).

**Storage model and operations**

A job stores its ID, queue, payload or input reference, state, priority, enqueue time, availability time, attempt number, owner token, generation, expiry, checkpoint, and terminal result or error. Every record carries a jobs schema version. Payload, checkpoint, and result are JSON data. Artifact bytes remain in the artifact store.

States are `queued`, `leased`, `blocked`, `succeeded`, `failed`, and `cancelled`. Blocked work requires application reconciliation before it can be claimed again.

| Operation | Required behavior |
| --- | --- |
| `enqueue` | Create once under a scoped idempotency key. Different input under the same key conflicts. |
| `get`, `list` | Inspect durable state without acquiring ownership. |
| `claim(id)` | Atomically claim a known eligible job. |
| `claimNext(queue)` | Select and claim the next eligible job. |
| `renew(claim)` | Extend only the current unexpired attempt. |
| `checkpoint(claim, value)` | Save progress or provider reconciliation state under the current claim. |
| `complete(claim, result)` | Commit success only for the current valid attempt. |
| `fail(claim, error)` | Commit terminal failure for the current valid attempt. |
| `retry(claim, availableAt)` | Return an owned job to queued state at an application-selected time. |
| `block(claim, checkpoint)` | Retain uncertain work for reconciliation instead of redispatching it. |
| `requestCancel(id)` | Cancel queued or blocked work, or record cancellation against the active attempt. |
| `acknowledgeCancel(claim)` | End the current cancelled attempt. |
| `recoverExpired(id, expectedGeneration)` | Fence an expired attempt and move it to blocked state. |
| `resolveBlocked(id, expectedVersion, decision)` | Apply an application's reconciliation decision atomically. |
| `removeTerminal(id, expectedVersion)` | Delete terminal state and explicitly configured history in one transaction. |

**Claim and transition contract**

- Require atomic conditional mutations. Never emulate a claim using an unconditional read followed by write.
- Eligibility requires queued state, no cancellation, and `availableAt <= now`. Order eligible jobs by priority descending, enqueue time ascending, then ID in code-point order.
- Apply eligibility and complete ordering before limiting candidates. Current collection APIs sort one field at a time. The first implementation can sort the eligible set correctly before selection. Do not truncate it first or invent a queue-size limit.
- A successful claim assigns an owner token, increments the generation and attempt number, and commits expiry with the state change. A losing claimant selects again or returns contention. Backend unavailability is distinct from an empty queue.
- Renewal and checkpoint updates do not invalidate the stable claim token. Each mutation conditionally writes against the current record version. The winning atomic operation checks token, generation, state, and expiry.
- Stale workers cannot complete, fail, retry, checkpoint, or release a successor's work. Expired attempts cannot publish completion.
- Cancellation committed before completion prevents success. A later cancellation of a terminal job returns its terminal state. Cancellation is cooperative and does not prove a remote provider stopped.
- Expiry does not prove a remote submission failed. Recovery moves the attempt to blocked state, preserving provider identifiers and checkpoints. The application decides whether to resume, query the provider, complete, fail, cancel, or requeue.
- Mutation receipts make retried storage transitions idempotent. They do not make provider calls execute exactly once. A replayed claim receipt cannot confer authority after that lease expires.
- Receipt retention covers the consumer's reconciliation window. Removal must not discard retained idempotency protection prematurely. Keep the existing indefinite default until a consumer supplies a retention policy.

Use an injected clock for availability and lease checks. Job storage runs short atomic operations. Worker code runs outside database transactions.

**Composition and ownership**

The jobs package consumes existing store ports and atomic mutations. It opens no database and starts no worker loop. Consumers inject an `AsyncStore` with atomic capability. Memory and SQLite are the first complete implementations.

When a consumer needs job state, application records, and log history committed together, it supplies transaction and log capabilities from the same storage domain. A missing log capability is explicit. PostgreSQL and libSQL adoption cannot silently pretend to include the local log facet.

Reuse and extract Gonk's existing persistence logic where it supplies the chosen behavior. During adoption, replace the corresponding Gonk persistence implementation with this module. Keep Gonk's execution policy and application checkpoints in their current owners.

The first integration is llm-service's existing `IAssetMetadataBackend`. Preserve its API, priority, progress, and cancellation behavior. Map its claims to Mirk claims, and adapt recovery to retain live or uncertain attempts. Do not maintain an independent queue record that can disagree with the asset's authoritative lifecycle state. The integration must establish one owner for each persisted state transition. Fabric's `RelayMailboxStore` remains a different delivery contract. Asset backend interface: `ai/llm-service/packages/server/asset/asset/src/types/index.ts:208` (private source), consumer evaluation: `studio-docs/research/mirk-job-queues-2026-11-04/README.md:35` (private source).

**Acceptance**

Enqueue through the existing asset gateway and observe the existing UI using a fixture provider. Restart before dispatch and verify discovery. Race two dispatcher processes. Kill one after a claim, recover it, and prove its stale completion cannot publish. Exercise retries, cancellation, progress, checkpoints, and a provider request whose response is lost.

Repeat the storage transition scenarios in Python and TypeScript, including mixed-language claims against one SQLite file. Verify completed work remains discoverable after a missed wake notification. Measure claim latency and database contention during that journey. GPU admission, worker wake-up, delivery acknowledgement, cron scheduling, and provider execution remain outside this module.

## Delivery and verification

Implement in groups that share a contract:

1. Specify format version 3 alongside named-vector storage. Implement and test both languages together.
2. Add whole-stream deletion and memory transaction participants. These provide atomic lifecycle cleanup.
3. Extract the coordination port and shared state machine. Add immediate acquisition, memory state, and the injected clock in one coherent change.
4. Resolve native numerical compatibility, then implement and measure sqlite-vec search.
5. Build the jobs storage module and adopt it through one existing consumer before expanding adoption.

For each portable behavior, add a scenario under `packages/store/scripts/scenarios/` and generate the corpus. Never hand-edit generated JSON. Run process races and migration-failure tests separately where a sequential corpus cannot prove the behavior.

Implementation completion requires `pnpm test`, `pnpm -r typecheck`, and `pnpm docs:check`. Each touched Python member also runs `uv run pytest -q`, `uv run pyright`, and `uv run ruff check .`. Use the real-backend harnesses for affected remote adapters. Update package READMEs with the final contracts and the roadmap with implementation status.

**Specification basis:** source inspection at Mirk commit `c481505`, the existing conformance inputs, current package contracts, and the prior queue evaluation. No implementation or performance acceptance is claimed by these drafts. Linked Mirk files are identical at the reviewed snapshot and public base `e746b39`.
