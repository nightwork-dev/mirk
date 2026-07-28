# @mirk/migrate

Checkpointed, backend-agnostic copy helpers over Mirk ports.

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

| Helper | Source | Destination |
|---|---|---|
| `copyCollection` | one named `AsyncStore` collection | `AsyncStore` |
| `migrateStore` | several named `AsyncStore` collections | `AsyncStore` |
| `copyVectorManifest` | `AsyncIterable<VectorManifestEntry>` | `AsyncVectorStore` |
| `copySearchManifest` | `AsyncIterable<SearchManifestEntry>` | `AsyncSearchStore` |
| `copyGraphManifest` | `AsyncIterable<GraphManifestEntry>` | `AsyncStore` edge collections |
| `copyObjectManifest` | `AsyncIterable<ObjectManifestEntry>` | `ObjectStore` |

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

## Contract boundary

Validation should use representative caller manifests rather than private consumer datasets: copy
named store collections through the `AsyncStore` port, replay vector/search/graph/object manifests in
a stable order, interrupt after a checkpoint, resume from the recorded processed counts, and assert
destination counts plus restored content.

The package does not provide transforms, schema inference, a domain migration language, source
enumeration for non-KV ports, or a general ETL framework.
