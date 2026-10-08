from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any

import pytest
from mirk.store.memory import InMemoryStore

from mirk.artifact.coordinator import ArtifactCoordinator, ArtifactWriteError
from mirk.artifact.errors import ArtifactConflictError, ArtifactOperationError
from mirk.artifact.memory import InMemoryArtifactRepository, InMemoryObjectStore
from mirk.artifact.store import StoreArtifactRepository
from mirk.artifact.types import ImportArtifactInput, WriteArtifactInput


def _backends() -> Iterator[tuple[str, Any, Any]]:
    yield "memory", InMemoryObjectStore(), InMemoryArtifactRepository(now=lambda: 1000)
    yield (
        "store",
        InMemoryObjectStore(),
        StoreArtifactRepository(
            InMemoryStore(), now=lambda: 1000, lease_id_factory=lambda: "lease-fixed"
        ),
    )


@pytest.fixture(params=list(_backends()), ids=lambda value: value[0])
def backend(request: pytest.FixtureRequest) -> tuple[str, Any, Any]:
    return request.param


def _coordinator(
    objects: Any, repository: Any, ids: list[str] | None = None
) -> ArtifactCoordinator:
    values = iter(ids or ["artifact-1", "edge-1"])
    return ArtifactCoordinator(
        objects,
        repository,
        id_factory=lambda: next(values),
        now=lambda: 1000,
        owner_id="writer",
        concurrency={"mode": "repository-atomic"},
    )


def test_write_read_verify_and_replay_use_portable_descriptors(
    backend: tuple[str, Any, Any],
) -> None:
    _, objects, repository = backend
    coordinator = _coordinator(objects, repository)
    consumed: list[bytes] = []

    def source() -> Iterator[bytes]:
        consumed.append(b"first")
        yield b"first"
        consumed.append(b"second")
        yield b"second"

    request: WriteArtifactInput = {
        "bytes": source(),
        "mediaType": "text/plain",
        "filename": "value.txt",
        "producer": {"system": "test", "operation": "write"},
        "idempotencyKey": "same",
    }
    first = coordinator.write(request)
    assert consumed == [b"first", b"second"]
    assert "objectKey" not in first
    assert first["sizeBytes"] == 11
    assert coordinator.verify(first["id"])["ok"] is True
    read = coordinator.read(first["id"])
    assert read is not None
    assert b"".join(read["bytes"]) == b"firstsecond"

    replay = coordinator.write(
        {
            "bytes": b"firstsecond",
            "mediaType": "text/plain",
            "filename": "value.txt",
            "producer": {"system": "test", "operation": "write"},
            "idempotencyKey": "same",
        }
    )
    assert replay["id"] == first["id"]
    with pytest.raises(ArtifactConflictError):
        coordinator.write(
            {"bytes": b"changed", "mediaType": "text/plain", "idempotencyKey": "same"}
        )


def test_lineage_failure_rolls_back_record_and_owned_object(
    backend: tuple[str, Any, Any],
) -> None:
    _, objects, repository = backend
    coordinator = _coordinator(objects, repository, ["source", "result", "edge"])
    source = coordinator.write({"bytes": b"source", "mediaType": "text/plain"})
    with pytest.raises(ArtifactWriteError) as caught:
        coordinator.write(
            {
                "bytes": b"result",
                "mediaType": "text/plain",
                "sources": [{"artifactId": "missing", "operation": "transform"}],
            }
        )
    assert caught.value.cleanup == "succeeded"
    assert repository.get("result") is None
    assert objects.head("artifacts/result") is None
    assert repository.get(source["id"]) is not None


def test_missing_import_is_distinct_and_shared_import_bytes_are_retained(
    backend: tuple[str, Any, Any],
) -> None:
    _, objects, repository = backend
    coordinator = _coordinator(objects, repository, ["one", "two"])
    with pytest.raises(ArtifactOperationError) as caught:
        coordinator.importArtifact({"objectKey": "missing", "mediaType": "text/plain"})
    assert caught.value.code == "object-not-found"

    objects.put("objects/shared", b"shared")
    request: ImportArtifactInput = {"objectKey": "objects/shared", "mediaType": "text/plain"}
    one = coordinator.importArtifact(request)
    two = coordinator.importArtifact(request)
    assert coordinator.delete(one["id"]) is True
    assert objects.head("objects/shared") is not None
    assert coordinator.verify(two["id"])["ok"] is True
    assert coordinator.delete(two["id"]) is True
    assert objects.head("objects/shared") is None


def test_stale_shared_lease_prevents_commit_and_cleans_owned_bytes() -> None:
    objects = InMemoryObjectStore()
    repository = InMemoryArtifactRepository(now=lambda: 0)
    coordinator = ArtifactCoordinator(
        objects,
        repository,
        id_factory=lambda: "stale",
        now=lambda: 100,
        owner_id="writer",
        lease_ttl_ms=1,
    )
    original = repository.renewObjectLease
    repository.renewObjectLease = lambda **kwargs: {"status": "unavailable", "reason": "expired"}  # type: ignore[method-assign]
    with pytest.raises(ArtifactWriteError) as caught:
        coordinator.write({"bytes": b"stale", "mediaType": "text/plain"})
    assert caught.value.cleanup == "succeeded"
    assert objects.head("artifacts/stale") is None
    assert repository.get("stale") is None
    repository.renewObjectLease = original  # type: ignore[method-assign]


def test_reported_store_size_mismatch_cleans_owned_object() -> None:
    class LyingStore(InMemoryObjectStore):
        def put(self, key: str, source: object, options: object = None) -> Any:  # type: ignore[override]
            info: Any = super().put(key, source, options)  # type: ignore[arg-type]
            info["sizeBytes"] = int(info["sizeBytes"]) + 1
            return info

    objects = LyingStore()
    repository = InMemoryArtifactRepository(now=lambda: 1000)
    coordinator = _coordinator(objects, repository)
    with pytest.raises(ArtifactWriteError) as caught:
        coordinator.write({"bytes": b"value", "mediaType": "text/plain"})
    assert caught.value.cleanup == "succeeded"
    assert objects.head("artifacts/artifact-1") is None


def test_head_failure_before_put_does_not_delete_existing_object() -> None:
    sentinel = RuntimeError("head unavailable")

    class HeadFailingStore(InMemoryObjectStore):
        fail = True

        def head(self, key: str):  # type: ignore[override]
            if self.fail:
                raise sentinel
            return super().head(key)

    objects = HeadFailingStore()
    objects.put("artifacts/fixed", b"existing")
    repository = InMemoryArtifactRepository(now=lambda: 1000)
    coordinator = ArtifactCoordinator(
        objects, repository, id_factory=lambda: "fixed", now=lambda: 1000
    )
    with pytest.raises(RuntimeError) as caught:
        coordinator.write({"bytes": b"replacement", "mediaType": "text/plain"})
    assert caught.value is sentinel
    objects.fail = False
    existing = objects.get("artifacts/fixed")
    assert existing is not None
    assert b"".join(existing) == b"existing"


def test_direct_delete_uses_exclusive_lease_and_fails_safe_while_writer_races() -> None:
    class RacingRepository(InMemoryArtifactRepository):
        raced = False

        def acquireObjectLease(
            self,
            input: Mapping[str, Any] | None = None,
            *,
            objectKey: str | None = None,
            ownerId: str | None = None,
            mode: Any = None,
            ttlMs: float | None = None,
            now: float | None = None,
        ) -> dict[str, Any]:
            values = dict(input or {})
            object_key = objectKey or values.get("objectKey")
            owner_id = ownerId or values.get("ownerId")
            mode = mode or values.get("mode")
            ttl_ms = ttlMs if ttlMs is not None else values.get("ttlMs")
            now = now if now is not None else values.get("now")
            assert object_key is not None and owner_id is not None and mode is not None
            if mode == "exclusive-delete" and not self.raced:
                self.raced = True
                super().acquireObjectLease(
                    objectKey=object_key,
                    ownerId="racing-writer",
                    mode="shared-writer",
                    ttlMs=ttl_ms,
                    now=now,
                )
            return super().acquireObjectLease(
                objectKey=object_key,
                ownerId=owner_id,
                mode=mode,
                ttlMs=ttl_ms,
                now=now,
            )

    objects = InMemoryObjectStore()
    repository = RacingRepository(now=lambda: 1000)
    coordinator = ArtifactCoordinator(
        objects, repository, id_factory=lambda: "raced", now=lambda: 1000
    )
    artifact = coordinator.write({"bytes": b"value", "mediaType": "text/plain"})
    with pytest.raises(ArtifactOperationError) as caught:
        coordinator.delete(artifact["id"])
    assert caught.value.code == "object-deletion-failed"
    assert repository.get(artifact["id"]) is None
    assert objects.head("artifacts/raced") is not None


def test_direct_delete_renews_after_final_reference_scan() -> None:
    clock = [1000.0]

    class ExpiringRepository(InMemoryArtifactRepository):
        scans = 0

        def list(self, query: Any = None) -> Any:
            page = super().list(query)
            self.scans += 1
            if self.scans == 2:
                clock[0] = 2000
                importer = ArtifactCoordinator(
                    objects,
                    self,
                    id_factory=lambda: "imported",
                    now=lambda: clock[0],
                    owner_id="importer",
                    lease_ttl_ms=10,
                )
                importer.importArtifact(
                    {"objectKey": "artifacts/target", "mediaType": "text/plain"}
                )
            return page

    objects = InMemoryObjectStore()
    repository = ExpiringRepository(now=lambda: clock[0], lease_id_factory=lambda: "lease")
    coordinator = ArtifactCoordinator(
        objects,
        repository,
        id_factory=lambda: "target",
        now=lambda: clock[0],
        owner_id="deleter",
        lease_ttl_ms=10,
    )
    artifact = coordinator.write({"bytes": b"value", "mediaType": "text/plain"})
    with pytest.raises(ArtifactOperationError) as caught:
        coordinator.delete(artifact["id"])
    assert caught.value.code == "object-deletion-failed"
    assert repository.get("imported") is not None
    assert objects.head("artifacts/target") is not None
