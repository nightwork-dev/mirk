# @mirk/statements

> **A SQLite log of claims that change over time.** Each claim keeps every revision, a receipt for
> every decision made about it, and answers to "what was true on this date, as we knew it then?"

## Why

Some data is not a value. It is a claim: "the harbor is ruled by Queen Maren." Claims get corrected.
Two sources disagree. A model suggests one that nobody has approved yet. Overwriting a row loses
all of that, and a plain history table cannot tell you why a claim changed or who allowed it.

A host that tracks claims like these needs three things a key-value store does not give it:

- **Every revision kept.** A correction adds revision 2. Revision 1 stays.
- **Two clocks.** _Bitemporal_ means each claim carries two times: when it was **true** in the world
  (its valid time), and when it was **recorded** in the store (its recorded time). You can then ask
  "what did we believe on 1 October about the year 1910?"
- **A receipt for every decision.** An _admission receipt_ is the stored answer to "did this write
  go in, and why or why not?" It records the outcome, the rule that decided it, and an idempotency
  key, so a retried request gets the same answer instead of a second write.

`@mirk/statements` stores all three in one SQLite file. The host decides **what is allowed in** by
passing an admission authority, a function you write. Mirk owns the storage: persistence,
serialization, indexes, replay, and crash consistency.

**Who needs it:** a host that tracks claims that change over time, such as a world-building tool, a
knowledge base with sources, or an agent memory that must keep what it was told and what it
inferred apart.

**Who does not:** anyone storing plain records, settings, or documents. Use
[`@mirk/store`](../store) for those. This package is specialized for one schema,
`statements-storage/v1`, which is versioned separately from the rest of Mirk. It does not widen the
general `SyncStore` or `AsyncStore` interfaces, and it does not replace them.

## A first look

```ts
import { createSqliteStatementStore } from "@mirk/statements/sqlite";
import type { StatementAdmissionAuthority } from "@mirk/statements";

// The host's rule for what may enter the store. This one accepts everything.
const authority: StatementAdmissionAuthority = {
  authorityId: "my-app",
  authorityRevision: "1",
  decide: () => ({
    outcome: { kind: "admit", status: "accepted", reason: "trusted caller" },
    decidedAt: Date.now(),
  }),
};

const statements = createSqliteStatementStore({ path: "statements.sqlite", authority });

const auth = { principalId: "user:ana", authorityScope: "world:harbor", callerPolicy: "editor" };
const ref = { worldId: "harbor", branchId: "main", statementId: "ruler-of-harbor" };

// Record a claim: "harbor-city is ruled by queen-maren", true from 1900 to 1930.
await statements.admit({
  auth,
  idempotencyKey: "import-1",
  ...ref,
  recordedAt: "2026-10-23T09:00:00.000Z",
  proposition: {
    subject: { entityId: "harbor-city" },
    predicate: { predicateId: "ruled-by" },
    object: { entityId: "queen-maren" },
  },
  context: { kind: "world-version", worldId: "harbor", branchId: "main" },
  modality: "fact",
  polarity: "positive",
  status: "accepted",
  validTime: {
    from: { kind: "instant", at: "1900-01-01T00:00:00.000Z" },
    to: { kind: "instant", at: "1930-01-01T00:00:00.000Z" },
  },
  provenance: {
    sources: [{ sourceId: "chronicle-vol-2" }],
    origin: { source: "authored", modelInvolved: false },
  },
});

// A correction: the reign ended in 1925. This adds revision 2 and keeps revision 1.
await statements.revise({
  auth,
  idempotencyKey: "fix-1",
  ...ref,
  recordedAt: "2026-10-24T09:00:00.000Z",
  expectedRevision: 1,
  patch: {
    validTime: {
      from: { kind: "instant", at: "1900-01-01T00:00:00.000Z" },
      to: { kind: "instant", at: "1925-01-01T00:00:00.000Z" },
    },
  },
});

statements.listHistory(ref).map((r) => r.revision); // [1, 2]
statements.query({ worldId: "harbor", branchId: "main", validAt: "1927-01-01T00:00:00.000Z" }); // []
statements.query({ worldId: "harbor", branchId: "main", validAt: "1910-01-01T00:00:00.000Z" }); // one claim

statements.close();
```

Every call to `admit`, `revise`, and `retract` returns a result with a receipt, whether the write
went in or not. Send the same request again with the same `idempotencyKey` and you get the original
result back with `replay: true`.

## Install

```bash
npm install @mirk/statements better-sqlite3
```

`better-sqlite3` is an optional peer dependency, needed only by the SQLite adapter. The adapter
accepts versions 11, 12, or 13. Development tests use version 13, whose Node-API bindings support
current Node runtimes. ESM only. Use Node 22.23.4+, 24.22.1+, or 26.12.1+.

## What you can do

| Call                                  | What it does                                                              |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `admit(envelope)`                     | Record a new claim as revision 1.                                         |
| `revise(envelope)`                    | Add a revision. `expectedRevision` must match the current one.            |
| `retract(envelope)`                   | Add a final `retracted` revision. The claim and its history stay.         |
| `getHead(ref)`                        | The latest revision of a claim, or `null`.                                |
| `getRevision(ref, n)`                 | One specific revision, or `null`.                                         |
| `listHistory(ref)`                    | Every revision of a claim, oldest first.                                  |
| `query(lens)`                         | The latest revision of each claim that matches a lens (see below).        |
| `beginBackfill` / `updateBackfill` / `getBackfill` | Save and read a resumable cursor for a bulk import.          |
| `close()`                             | Close the database. A database you passed in yourself is left open.       |

A **lens** (`StatementLensQuery`) picks claims by `worldId` and `branchId` (required) and optionally
by `contextKind`, `actorInstanceId`, `statuses`, `modalities`, `sourceIds`, `validAt`,
`recordedFrom`, `recordedTo`, and `limit`. Results are newest-recorded first, with ties broken by
statement id. `limit` defaults to 100. Every filter, `sourceIds` included, applies before `limit`.
`validAt` compares instants only: a statement whose `validTime` has a `before` or `after` anchor
bound on either end names an event, not a time, so no `validAt` lens returns it. It is still
returned by lenses without `validAt`.

## Two kinds of safety

**Retries are safe.** A receipt is stored under the request's authority scope, idempotency key, and
operation kind. A repeat of the exact same request returns the original result, committed or
refused, without writing again. The same key with a different request returns
`idempotency-conflict` and does not touch the revision log. That conflict answer is stored too, so
repeating it gets the same answer, including after a restart.

**Writers do not race.** The SQLite adapter uses `@mirk/store/coordination` to serialize admission
for each statement, so two writers revising the same claim cannot both win. The loser gets a
`revision-conflict` receipt. Each operation commits its revision, its latest-revision pointer, and
its receipt in one SQLite transaction.

## Moving from an older store

[`@mirk/statements/testing`](#subpaths) holds `compareLegacySurface`, a _dual-read parity harness_.
If you are replacing an older claims store, run both side by side and ask whether the new one holds
the same answers. You describe the old store as a named surface: a `name`, a `read()` that yields
its records, and a `toStatement()` that converts each to a `StatementRecord`. The harness compares
each record to the stored revision and returns a report: how many it checked, which are missing
from the new store, and which fields differ.

Fields compared: `status`, `modality`, `polarity`, `context`, `proposition`, and `provenance`.

For a large import, `beginBackfill` and `updateBackfill` save a cursor and a `running`, `complete`,
or `failed` status, so an interrupted import resumes where it stopped.

## Subpaths

- `@mirk/statements` — public factory, adapter class, testing helper, and storage-schema types.
- `@mirk/statements/sqlite` — SQLite production adapter.
- `@mirk/statements/testing` — named legacy dual-read parity harness.
- `@mirk/statements/types` — storage-schema/v1 TypeScript types only.

## Reference

### Options

`createSqliteStatementStore(options)` returns a `SqliteStatementStore`. The constructor takes the
same options.

| Option           | Default                                       | Meaning                                                              |
| ---------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `path`           | required unless `db` is given                 | Database file. Missing with no `db` throws `missing-database-path`.  |
| `authority`      | required                                      | Your admission rule (see below).                                     |
| `db`             | opens `path`                                  | An open `better-sqlite3` database to use instead.                    |
| `coordinator`    | a SQLite coordinator on `path`, namespace `mirk-statements` | Where admission serialization runs. Required when `db` is given without `path` (`missing-coordinator`); the default coordinator opens its own connection to `path`. |
| `busyTimeoutMs`  | 30000                                         | How long SQLite waits on a locked file.                              |
| `now`            | `() => new Date()`                            | Clock for migration and backfill timestamps.                         |
| `receiptIdFactory` | `receipt:<uuid>`                            | Makes receipt ids.                                                   |

Creating the store creates its tables if they are missing. `migrate()` is also callable and safe to
repeat.

### The admission authority

An authority has an `authorityId`, an `authorityRevision`, and a synchronous
`decide(auth, request)` that returns either `{ outcome: { kind: "admit", status, reason } }` or
`{ outcome: { kind: "refuse", code } }`, plus `decidedAt`. Both ids are written into every receipt's
metadata, with `schemaVersion: "statements-storage/v1"` and any `receiptMetadata` the request
carried. An exact replay does not call the authority again.

### Store rules that apply after the authority

The store enforces these whatever the authority says:

- Material that involved a model, or whose origin is `inferred`, `perceived`, or `consolidated`, is
  stored as `proposed`.
- A first admission cannot be `rejected`, `superseded`, or `retracted` (throws
  `terminal-initial-status`).
- A claim whose latest revision is `rejected`, `superseded`, or `retracted` takes no more
  revisions; the attempt gets a `revision-conflict` receipt with reason `terminal-head`.
- Status moves from `proposed` to anything, and from `accepted` to `accepted` or `superseded`.
  Anything else throws `invalid-status-transition`.
- A `superseded` revision needs a `supersededBy` reference, or the call gets a `store-refused`
  receipt (`superseded-requires-reference`).
- `admit` on a claim that already exists, `revise` or `retract` on one that does not, and a wrong
  `expectedRevision` all get `revision-conflict` receipts.
- Every revision needs at least one provenance source.
- A context of kind `actor-epistemic` needs an `actorInstanceId`; any other kind must not have one.
- The envelope's `worldId` and `branchId` must match the context's.

### Receipt codes

`StatementReceipt.code` is one of `committed`, `authority-refused`, `store-refused`,
`revision-conflict`, or `idempotency-conflict`. A refused result has `ok: false`, a `code`, and a
receipt with `refusedBy` (`authority` or `store`) and a `reason`. Refusals are stored, so they
replay like commits do.

### Errors

Invalid input throws `StatementStoreError`, with a `code` of `missing-database-path`,
`missing-coordinator`, `missing-required-field`, `terminal-initial-status`, `invalid-status-transition`, `world-mismatch`,
`branch-mismatch`, `missing-actor-instance`, `unexpected-actor-instance`,
`missing-provenance-source`, or `missing-admission-receipt`. Input checks that fail before the
write leave the store unchanged.

### Request fingerprints

A receipt stores a fingerprint of the request: a SHA-256 of its JSON with object keys sorted by
code point, so the same request always produces the same fingerprint on every runtime. Receipts
written by 0.2.0 or earlier used a locale-dependent key order; replays still recognise them.
