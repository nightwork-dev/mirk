from __future__ import annotations

from collections.abc import Iterator

import opendal
import pytest
from mirk.artifact.coordinator import ArtifactCoordinator
from mirk.artifact.memory import InMemoryArtifactRepository

from mirk.artifact_opendal import OpenDalObjectStore


@pytest.mark.parametrize("before_yield", [True, False])
@pytest.mark.parametrize("interrupt_type", [KeyboardInterrupt, SystemExit])
def test_memory_source_interrupt_preserves_identity_and_cleans_owned_object(
    before_yield: bool, interrupt_type: type[BaseException]
) -> None:
    store = OpenDalObjectStore(opendal.Operator("memory"))
    key = f"objects/interrupt-{before_yield}-{interrupt_type.__name__}"
    interrupt = interrupt_type("stop")

    def source() -> Iterator[bytes]:
        if not before_yield:
            yield b"partial"
        raise interrupt

    with pytest.raises(interrupt_type) as caught:
        store.put(key, source(), {"ifAbsent": True})
    assert caught.value is interrupt
    assert store.head(key) is None


def test_memory_source_interrupt_survives_conditional_close_conflict() -> None:
    store = OpenDalObjectStore(opendal.Operator("memory"))
    key = "objects/close-conflict"
    store.put(key, b"preserved", {"ifAbsent": True})
    interrupt = KeyboardInterrupt("stop")

    def source() -> Iterator[bytes]:
        raise interrupt
        yield b"unreachable"

    with pytest.raises(KeyboardInterrupt) as caught:
        store.put(key, source(), {"ifAbsent": True})
    assert caught.value is interrupt
    assert b"".join(store.get(key) or ()) == b"preserved"


def test_coordinator_does_not_delete_competing_memory_object_after_interrupt() -> None:
    objects = OpenDalObjectStore(opendal.Operator("memory"))
    repository = InMemoryArtifactRepository(now=lambda: 1000)
    object_key = "artifacts/artifact-1"
    interrupt = KeyboardInterrupt("stop")

    def source() -> Iterator[bytes]:
        objects.put(object_key, b"competitor", {"ifAbsent": True})
        raise interrupt
        yield b"unreachable"

    coordinator = ArtifactCoordinator(
        objects,
        repository,
        id_factory=lambda: "artifact-1",
        now=lambda: 1000,
        owner_id="writer",
        concurrency={"mode": "repository-atomic"},
    )
    with pytest.raises(KeyboardInterrupt) as caught:
        coordinator.write({"bytes": source(), "mediaType": "text/plain"})
    assert caught.value is interrupt
    assert repository.get("artifact-1") is None
    assert b"".join(objects.get(object_key) or ()) == b"competitor"

    reacquired = repository.acquireObjectLease(
        objectKey=object_key,
        ownerId="after",
        mode="exclusive-delete",
        ttlMs=1_000,
        now=1000,
    )
    assert reacquired["status"] == "acquired"
    assert repository.releaseObjectLease(reacquired["lease"]) is True
