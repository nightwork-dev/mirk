from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import cast

import pytest
from mirk.store import InMemoryStore, SqliteStore

from mirk.artifact.errors import ArtifactConflictError, ArtifactOperationError
from mirk.artifact.memory import InMemoryArtifactRepository
from mirk.artifact.store import StoreArtifactRepository
from mirk.artifact.types import AtomicLeaseArtifactRepository, StoredArtifactRecord
from mirk.artifact.util import UNDEFINED, artifactFinalizationDigest


def record(id: str, created: float = 1, **extra: object) -> StoredArtifactRecord:
    return cast(
        StoredArtifactRecord,
        {
            "id": id,
            "objectKey": f"objects/{id}",
            "mediaType": "text/plain",
            "sizeBytes": 1,
            "digest": {"algorithm": "sha256", "value": id},
            "createdAt": created,
            **extra,
        },
    )


@pytest.mark.parametrize(
    "factory", [InMemoryArtifactRepository, lambda: StoreArtifactRepository(InMemoryStore())]
)
def test_record_listing_cursor_and_annotations(
    factory: Callable[[], AtomicLeaseArtifactRepository],
) -> None:
    repository = factory()
    repository.create(record("a", 1, annotations={"nullable": None, "remove": True}))
    repository.create(record("b", 2))
    page = repository.list({"limit": 1})
    assert [item["id"] for item in page["items"]] == ["b"]
    cursor = page.get("nextCursor")
    assert cursor is not None
    assert [item["id"] for item in repository.list({"cursor": cursor})["items"]] == ["a"]
    updated = repository.updateAnnotations("a", {"nullable": None, "remove": UNDEFINED})
    assert updated.get("annotations") == {"nullable": None}


@pytest.mark.parametrize(
    "factory", [InMemoryArtifactRepository, lambda: StoreArtifactRepository(InMemoryStore())]
)
def test_idempotency_replays_and_conflicts(
    factory: Callable[[], AtomicLeaseArtifactRepository],
) -> None:
    repository = factory()
    first = record("a", annotations={"v": 1})
    created = repository.createIdempotent(record=first, idempotencyKey="job/a")
    assert created["status"] == "created"
    replay = repository.createIdempotent(
        record={**first, "mediaType": "text/html"}, idempotencyKey="job/a"
    )
    assert replay["status"] == "conflict"
    same = repository.createIdempotent(record=first, idempotencyKey="job/a")
    assert same["status"] == "replayed"
    assert same["record"]["id"] == "a"


@pytest.mark.parametrize(
    "factory", [InMemoryArtifactRepository, lambda: StoreArtifactRepository(InMemoryStore())]
)
def test_deleted_idempotent_record_keeps_tombstone(
    factory: Callable[[], AtomicLeaseArtifactRepository],
) -> None:
    repository = factory()
    candidate = record("deleted")
    assert (
        repository.createIdempotent(record=candidate, idempotencyKey="deleted-key")["status"]
        == "created"
    )
    assert repository.delete("deleted") is True
    acquired = repository.acquireObjectLease(
        objectKey="objects/deleted", ownerId="writer", mode="shared-writer", now=0
    )
    assert acquired["status"] == "acquired"
    if acquired["status"] != "acquired":
        return
    lease = acquired["lease"]
    result = repository.createIdempotentWithLease(
        record=candidate, idempotencyKey="deleted-key", lease=lease, now=0
    )
    assert result["status"] == "conflict"
    assert repository.get("deleted") is None


def test_producer_system_must_be_a_string() -> None:
    from mirk.artifact.errors import ArtifactValidationError
    from mirk.artifact.util import assertPortableMetadata

    with pytest.raises(ArtifactValidationError) as caught:
        assertPortableMetadata(mediaType="text/plain", producer={"system": 17})
    assert caught.value.code == "invalid-producer"


def test_store_persists_across_sqlite_reopen(tmp_path: Path) -> None:
    path = tmp_path / "artifacts.db"
    first = SqliteStore(str(path))
    repository = StoreArtifactRepository(first, namespace="cross")
    repository.create(record("persisted", 7))
    first.close()
    reopened = StoreArtifactRepository(SqliteStore(str(path)), namespace="cross")
    persisted = reopened.get("persisted")
    assert persisted is not None
    assert persisted["objectKey"] == "objects/persisted"


def test_leases_expire_and_fence_commit() -> None:
    clock = [100.0]
    repository = InMemoryArtifactRepository(
        now=lambda: clock[0], lease_id_factory=lambda: "lease-1"
    )
    acquired = repository.acquireObjectLease(
        objectKey="objects/a", ownerId="writer", mode="shared-writer", ttlMs=10
    )
    lease = acquired["lease"]
    clock[0] = 111
    assert (
        repository.createWithLease(record("a"), lease=lease, now=clock[0])["status"] == "lease-lost"
    )
    recovered = repository.acquireObjectLease(
        objectKey="objects/a", ownerId="writer-2", mode="shared-writer", ttlMs=10, now=clock[0]
    )
    assert recovered["lease"]["generation"] == lease["generation"] + 1


@pytest.mark.parametrize("backend", ["memory", "sqlite"])
@pytest.mark.parametrize("operation", ["normal", "idempotent"])
def test_lease_object_identity_fences_record_and_receipt(
    backend: str, operation: str, tmp_path: Path
) -> None:
    ids = iter(["lease-a", "lease-b"])
    store = None
    if backend == "memory":
        repository = InMemoryArtifactRepository(now=lambda: 0, lease_id_factory=lambda: next(ids))
    else:
        store = SqliteStore(str(tmp_path / "lease-identity.sqlite"))
        repository = StoreArtifactRepository(
            store,
            namespace="lease-test",
            now=lambda: 0,
            lease_id_factory=lambda: next(ids),
        )
    try:
        writer = repository.acquireObjectLease(
            objectKey="A", ownerId="writer", mode="shared-writer", now=0
        )["lease"]
        blocker = repository.acquireObjectLease(
            objectKey="B", ownerId="repair", mode="exclusive-delete", now=0
        )
        assert blocker["status"] == "acquired"
        candidate = record("blocked", objectKey="B")
        if operation == "normal":
            result = repository.createWithLease(record=candidate, lease=writer, now=0)
        else:
            result = repository.createIdempotentWithLease(
                record=candidate, idempotencyKey="blocked", lease=writer, now=0
            )
        assert result["status"] == "lease-lost"
        assert repository.get("blocked") is None
        assert repository.getByIdempotencyKey("blocked") is None
        if store is not None:
            assert store.get("lease-test:idempotency:blocked") is None
    finally:
        if store is not None:
            store.close()


def test_lineage_requires_endpoints_and_rejects_cycles() -> None:
    repository = InMemoryArtifactRepository()
    repository.create(record("source"))
    repository.create(record("result"))
    repository.addLineage(
        {
            "id": "edge",
            "sourceArtifactId": "source",
            "resultArtifactId": "result",
            "operation": "derive",
            "createdAt": 1,
        }
    )
    with pytest.raises(ArtifactConflictError):
        repository.addLineage(
            {
                "id": "cycle",
                "sourceArtifactId": "result",
                "resultArtifactId": "source",
                "operation": "derive",
                "createdAt": 1,
            }
        )
    with pytest.raises(ArtifactOperationError):
        repository.addLineage(
            {
                "id": "missing",
                "sourceArtifactId": "nope",
                "resultArtifactId": "source",
                "operation": "derive",
                "createdAt": 1,
            }
        )


def test_finalization_digest_ignores_internal_and_mutable_fields() -> None:
    base = record("a", idempotencyKey="key", idempotencyFingerprint="old")
    assert artifactFinalizationDigest(base) == artifactFinalizationDigest(
        {**base, "id": "other", "objectKey": "other", "idempotencyKey": "other"}
    )
