# @mirk/migrate

Checkpointed, backend-agnostic copy helpers over Mirk ports.

Known KV collections can be copied directly. Vector, search, graph, and object ports are intentionally not enumerable, so callers provide deterministic async export manifests for those lanes. Resume checkpoints are processed-entry counts and therefore require the caller to reproduce the same manifest order.

Validation should use representative caller manifests rather than private consumer datasets: copy named store collections through the `AsyncStore` port, replay vector/search/graph/object manifests in a stable order, interrupt after a checkpoint, resume from the recorded processed counts, and assert destination counts plus restored content.

```ts
import { migrateStore } from "@mirk/migrate";

await migrateStore(source, destination, ["documents", "edges"], {
  batchSize: 250,
  onCheckpoint: saveCheckpoint,
});
```

The package does not provide transforms, schema inference, a domain migration language, or a general ETL framework.
