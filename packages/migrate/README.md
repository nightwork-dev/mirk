# @mirk/migrate

> **Move data from one Mirk backend to another, and pick up where you stopped if the copy is
> interrupted.**

```bash
npm install @mirk/migrate
```

## Why

Your app starts on a SQLite file. Months later it needs Postgres, or a hosted database, or a
different object store. The data has to move, and a real copy is rarely quick. It can be a few
hundred thousand records. The network drops at record 180,000, and the choice is to start over or
to guess where it stopped.

`@mirk/migrate` copies records in batches and reports a **checkpoint** after each batch: the lane
being copied and how many entries are done. Save the checkpoint. After a crash, pass it back as
`resume` and the copy continues from that count instead of from zero.

It only copies. It never deletes or changes the source, never transforms records, and does not
decide when the move is finished. You check that, then you switch over.

## A first look

```ts
import { migrateStore } from "@mirk/migrate";
import { InMemoryKv, toAsync } from "@mirk/store/kv";

// Two stores. In real use the source is your old backend and the destination is the new one.
const source = new InMemoryKv();
for (let i = 1; i <= 5; i++) {
  source.put("tasks", { id: `t${i}`, title: `Task ${i}` });
}
const destination = new InMemoryKv();

const saved: Record<string, number> = {};
const counts = await migrateStore(toAsync(source), toAsync(destination), ["tasks"], {
  batchSize: 2,
  onCheckpoint: ({ lane, processed }) => {
    saved[lane] = processed; // write this somewhere that survives a restart
  },
});

console.log(counts); // { tasks: 5 }
console.log(saved); // { "collection:tasks": 5 }
console.log(destination.list("tasks").length); // 5
```

To resume after an interruption, pass the saved counts back:

```ts
await migrateStore(toAsync(source), toAsync(destination), ["tasks"], {
  batchSize: 2,
  resume: saved, // { "collection:tasks": 4 } skips the first four records
  onCheckpoint: ({ lane, processed }) => {
    saved[lane] = processed;
  },
});
```

Re-running a lane is safe, because every write is an upsert (it overwrites the record with the same
key).

## What it can copy

Key-value collections can be listed, so `@mirk/migrate` finds their records itself. Vector, search,
graph, and object ports cannot be listed, so for those you supply the entries yourself as an async
iterable called a **manifest**. A manifest must produce the same entries in the same order each time
it runs; that is what makes resuming by count correct.

| Helper               | Source                                 | Destination                   | Checkpoint lane        |
| -------------------- | -------------------------------------- | ----------------------------- | ---------------------- |
| `copyCollection`     | one named `AsyncStore` collection      | `AsyncStore`                  | `collection:<name>`    |
| `migrateStore`       | several named `AsyncStore` collections | `AsyncStore`                  | `collection:<name>` each |
| `copyVectorManifest` | `AsyncIterable<VectorManifestEntry>`   | `AsyncVectorStore`            | `vector`               |
| `copySearchManifest` | `AsyncIterable<SearchManifestEntry>`   | `AsyncSearchStore`            | `search`               |
| `copyGraphManifest`  | `AsyncIterable<GraphManifestEntry>`    | `AsyncStore` edge collections | `graph`                |
| `copyObjectManifest` | `AsyncIterable<ObjectManifestEntry>`   | `ObjectStore`                 | `object`               |

`copyCollection` and `migrateStore` read each collection sorted by `id` ascending, in pages of
`batchSize`. `migrateStore` rejects duplicate or non-string collection names. The collection helpers
return the processed count (`migrateStore` returns a count per collection); manifest helpers return
the total processed count.

A manifest copy, with a checkpoint saved after every 100 entries:

```ts
await copyVectorManifest(entries(), destination, {
  batchSize: 100,
  resume: { vector: previousVectorCount },
  onCheckpoint: async ({ lane, processed }) => {
    await saveCheckpoint(lane, processed);
  },
});
```

Each manifest entry names its collection and carries the document: `{ collection, document }` for
vectors and search, `{ collection, edge }` for graph, and `{ key, bytes, mediaType?, metadata? }` for
objects.

## Options

Every helper accepts the same options:

| Option         | Default | Meaning                                                                                       |
| -------------- | ------- | --------------------------------------------------------------------------------------------- |
| `batchSize`    | `100`   | Entries per page and per checkpoint. Must be a positive integer.                              |
| `resume`       | none    | Where to continue: a map of lane to processed count, a checkpoint, or a list of checkpoints.  |
| `onCheckpoint` | none    | Called after each batch and once more for any final partial batch. May be async.              |
| `plan`         | none    | A plan identity (see below). Checkpoints then carry the plan and a timestamp.                 |

A checkpoint contains a stable lane name and the processed-entry count. Collection checkpoints also
carry the `collection` name.

Resume checkpoints are processed-entry counts. Callers must reproduce the same collection ordering
or manifest order when resuming. Writes use each destination port's ordinary upsert semantics; this
package does not infer deletions or transform schemas.

## Plan-bound checkpoints

A plain checkpoint says how far a copy got, not which copy it belonged to. If you resume with the
wrong checkpoint file, the copy starts mid-way through the wrong data.

To bind a run to a caller-owned source, destination, and plan digest, provide a complete
`MigrationPlanIdentity`. The checkpoint callback then receives `MigrationCheckpointV2` values, which
add the plan and an `updatedAt` time. The original numeric resume map and `MigrationCheckpointV1`
shape remain supported.

```ts
const plan = {
  schema: "mirk-migration-plan/v1",
  planDigest: "sha256:…",
  sourceIdentity: "source:prod",
  destinationIdentity: "destination:staging",
} as const;

await copyVectorManifest(entries(), destination, {
  plan,
  onCheckpoint: saveCheckpointV2,
});
```

Use `upgradeCheckpointV1` when an existing checkpoint must be resumed under a plan. The helper
validates the v1 lane and processed count, requires the complete plan identity and an explicit
`convertedAt` (the conversion time, not when the v1 checkpoint was written), and never infers the
source, destination, or digest. A v2 resume rejects a different plan identity, and plan-bound
resumes must use v2 checkpoints rather than silently treating an old count as plan-bound. Plan
identities are stored in checkpoints; keep credentials and connection strings out of them.

Invalid input throws `MigrationError` with a stable `code`, such as `invalid-batch-size`,
`invalid-checkpoint`, `invalid-plan`, `plan-identity-mismatch`, `v2-checkpoint-required`, or
`duplicate-collection`.

## Post-copy verification

Copy helpers keep their existing numeric results. Wrap any copy operation with a caller-owned verifier
when a structured check is needed:

```ts
const { result, verification } = await runMigrationWithVerification(
  () => migrateStore(source, destination, ["documents"]),
  async (counts) => ({
    ok: counts.documents === 10,
    checked: counts.documents,
    diagnostics: [],
  })
);
```

`MigrationVerification` is domain-free (`ok`, `checked`, and diagnostic records). A failed check is
returned to the caller; the wrapper does not decide whether to roll back, retry, or delete source data.

## Guarantees and caller responsibilities

- A checkpoint records progress only. It does not verify the destination, and it is not proof that
  a cutover is complete; verify counts, IDs, and content before switching over.
- Persist checkpoints in a restart-safe store, not only in memory, and replay the same ordering on
  resume. Re-running a lane is safe because writes are upserts.
- The package never deletes or modifies source data. Keep the source intact until you no longer
  need to roll back.
- Stop ordinary writes to a destination namespace until its migration is complete; the helpers do
  not exclude concurrent writers.

Test a migration with representative manifests: copy named collections, replay manifests in a
stable order, interrupt after a checkpoint, resume from the recorded counts, and assert destination
counts and restored content.

The package does not provide transforms, schema inference, a domain migration language, source
enumeration for non-KV ports, deletion propagation, or a general ETL framework.
