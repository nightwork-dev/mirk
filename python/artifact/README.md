# mirk-artifact

Artifact identity, integrity, lineage, and byte storage for Python.
This package uses the same records, SQLite collections, and filesystem layout as `@mirk/artifact`.
Its only runtime dependency is `mirk-store`.

## Use

```python
from mirk.artifact import ArtifactCoordinator
from mirk.artifact.fs import FileObjectStore
from mirk.artifact.store import StoreArtifactRepository
from mirk.store import SqliteStore

with SqliteStore("metadata.sqlite") as store:
    repository = StoreArtifactRepository(store, namespace="documents")
    artifacts = ArtifactCoordinator(
        FileObjectStore("objects"),
        repository,
        namespace="documents",
        concurrency={"mode": "repository-atomic"},
    )
    record = artifacts.write({
        "bytes": b"A portable document.",
        "mediaType": "text/plain",
        "idempotencyKey": "document-1",
    })
    assert artifacts.verify(record["id"])["ok"]
    result = artifacts.read(record["id"])
    assert result is not None
    content = b"".join(result["bytes"])
```

The host owns the store and closes it.
The repository does not open another connection.
All methods are synchronous, like the existing Python Mirk store.
Byte sources accept bytes or an iterable of byte chunks.
Reads return a lazy iterable.

Keep a SQLite connection on its owning thread.
An asynchronous host can call these methods on that thread, or use a dedicated storage worker with its own connection.

## Contract

- Records retain TypeScript field names and method names.
  Constructor options use Python names, such as `id_factory` and `lease_id_factory`.
- `StoreArtifactRepository` accepts a store and optional `namespace`, `now`, and
  `lease_id_factory` arguments. `FileObjectStore` accepts `root` as a keyword or positional argument.
- `importArtifact(input)` corresponds to the TypeScript `import(input)` method.
  Python reserves `import` as a keyword.
- Matching idempotent requests return the original artifact.
  Changed bytes or immutable metadata cause a conflict.
- SHA-256 establishes byte integrity.
  Finalization digests use the shared Mirk canonical JSON contract.
- Writer leases protect finalization.
  Conditional repair requires an exclusive lease and a fresh precondition check.
- `updateAnnotations(id, patch)` changes annotations only.
  `None` stores JSON null. The exported `UNDEFINED` sentinel removes a key.
- File objects use `<key>.bin` and `<key>.sidecar.json`.
  A Python process can reopen the files that TypeScript writes, and the reverse.

The in-memory repository and object store are reference implementations.
`StoreArtifactRepository` persists metadata through a supplied Mirk store.
`FileObjectStore` persists bytes beneath its root and rejects paths that escape through symbolic links.

## Maintenance

```python
from mirk.artifact import ArtifactMaintenance

maintenance = ArtifactMaintenance(objects, repository)
report = maintenance.audit()
plan = maintenance.planRepair(report)
# Inspect the plan before applying a destructive repair.
results = maintenance.applyRepair(plan)
```

Use the same maintenance instance for audit, plan, and apply.
Plans contain opaque object references, not physical storage keys.
A changed object, new reference, or active writer prevents deletion.

The separate [`mirk-artifact-opendal`](../artifact-opendal/README.md) package supplies S3-compatible object storage.
The package does not own jobs, scheduling, authorization, or application acceptance.

Cross-language compatibility follows the shared
[conformance contract](../../conformance/README.md).
