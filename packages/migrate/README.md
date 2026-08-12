# @mirk/migrate

Checkpointed, backend-agnostic copy helpers over Mirk ports.

Plan-bound checkpoint v2, explicit v1 upgrades, and caller-owned post-copy verification are
implemented locally. Publication and consumer adoption need separate evidence.

```bash
npm install @mirk/migrate
```

Known KV collections can be copied directly. Vector, search, graph, and object ports are intentionally
not enumerable, so callers provide deterministic async export manifests for those lanes.

```ts
import { migrateStore } from "@mirk/migrate";

await migrateStore(source, destination, ["documents", "edges"], {
  batchSize: 250,
  onCheckpoint: saveCheckpoint,
});
```

## Public API

| Helper               | Source                                 | Destination                   |
| -------------------- | -------------------------------------- | ----------------------------- |
| `copyCollection`     | one named `AsyncStore` collection      | `AsyncStore`                  |
| `migrateStore`       | several named `AsyncStore` collections | `AsyncStore`                  |
| `copyVectorManifest` | `AsyncIterable<VectorManifestEntry>`   | `AsyncVectorStore`            |
| `copySearchManifest` | `AsyncIterable<SearchManifestEntry>`   | `AsyncSearchStore`            |
| `copyGraphManifest`  | `AsyncIterable<GraphManifestEntry>`    | `AsyncStore` edge collections |
| `copyObjectManifest` | `AsyncIterable<ObjectManifestEntry>`   | `ObjectStore`                 |

Every helper accepts `batchSize`, `resume`, and `onCheckpoint`. Checkpoints contain a stable lane name
and processed-entry count:

```ts
await copyVectorManifest(entries(), destination, {
  batchSize: 100,
  resume: { vector: previousVectorCount },
  onCheckpoint: async ({ lane, processed }) => {
    await saveCheckpoint(lane, processed);
  },
});
```

Resume checkpoints are processed-entry counts. Callers must reproduce the same collection ordering or
manifest order when resuming. Writes use each destination port's ordinary upsert semantics; this
package does not infer deletions or transform schemas.

## Plan-bound checkpoints

The original numeric resume map and `MigrationCheckpointV1` shape remain supported. To bind a run to a
caller-owned source, destination, and plan digest, provide a complete `MigrationPlanIdentity`. The
checkpoint callback then receives `MigrationCheckpointV2` values:

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

Use `upgradeCheckpointV1` when an existing checkpoint must be resumed under a plan. The helper requires
the complete plan identity and an explicit conversion timestamp; it never derives either from the
old checkpoint. A v2 resume rejects a different plan identity, and plan-bound resumes must use v2
checkpoints rather than silently treating an old count as plan-bound.

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

## Contract boundary

Validation should use representative caller manifests rather than private consumer datasets: copy
named store collections through the `AsyncStore` port, replay vector/search/graph/object manifests in
a stable order, interrupt after a checkpoint, resume from the recorded processed counts, and assert
destination counts plus restored content.

The package does not provide transforms, schema inference, a domain migration language, source
enumeration for non-KV ports, or a general ETL framework.
