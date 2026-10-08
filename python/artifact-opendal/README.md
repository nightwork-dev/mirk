# mirk-artifact-opendal

Synchronous OpenDAL object storage for `mirk-artifact`.

Pass a configured OpenDAL `Operator` to `OpenDalObjectStore`. The adapter uses
OpenDAL for provider transport, streaming, conditional writes, and retries.
It does not discover credentials or create a provider client for you.

```python
from opendal import Operator
from mirk.artifact_opendal import OpenDalObjectStore

objects = OpenDalObjectStore(Operator("memory"))
objects.put("objects/example", b"hello", {"ifAbsent": True})
```

The adapter checks OpenDAL capabilities before it uses conditional writes,
content type metadata, user metadata, or recursive listing. Unsupported
capabilities raise `OpenDalObjectStoreError`.

## S3

S3 stores artifact bytes. Pair this adapter with a Mirk repository for records, lineage, and leases.
OpenDAL owns credentials, request signing, retry behavior, and multipart transport.
The adapter receives the configured operator and does not implement another provider client.

```python
from mirk.artifact import ArtifactCoordinator
from mirk.artifact.store import StoreArtifactRepository
from mirk.store import SqliteStore

operator = Operator("s3", bucket="my-artifacts", region="us-east-1", root="documents/")
objects = OpenDalObjectStore(operator)

with SqliteStore("metadata.sqlite") as metadata:
    artifacts = ArtifactCoordinator(
        objects,
        StoreArtifactRepository(metadata),
        concurrency={"mode": "repository-atomic"},
    )
    record = artifacts.write({
        "bytes": b"A stored document.",
        "mediaType": "text/plain",
        "idempotencyKey": "document-1",
    })
    assert artifacts.verify(record["id"])["ok"]
```

Use OpenDAL's host credential configuration for AWS.
For an S3-compatible service, also supply its `endpoint` and credentials to `Operator`.
The operator's `root` limits listings and maintenance to that prefix.

Writes use native conditional creation when `ifAbsent` is true.
A conflict raises Mirk's `ObjectAlreadyExistsError` and preserves the existing object.
Reads are lazy byte iterators. The optional `digest_metadata_key` buffers a source once to hash it
before opening the writer. Stored digest metadata is advisory. Artifact verification hashes the actual bytes.
