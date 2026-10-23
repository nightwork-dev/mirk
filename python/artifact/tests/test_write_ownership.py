from __future__ import annotations

from collections.abc import Callable, Iterable, Iterator
from pathlib import Path
from typing import Any

import pytest

from mirk.artifact.coordinator import ArtifactCoordinator, ArtifactWriteError
from mirk.artifact.errors import ArtifactOperationError, ObjectWriteIndeterminateError
from mirk.artifact.fs import FileObjectStore
from mirk.artifact.maintenance import ArtifactMaintenance
from mirk.artifact.memory import (
    InMemoryArtifactRepository,
    InMemoryObjectStore,
    ObjectAlreadyExistsError,
)
from mirk.artifact.types import ByteSource, ObjectInfo, ObjectPutOptions


def _read(stream: Iterable[bytes] | None) -> bytes:
    assert stream is not None
    return b"".join(stream)


def _failing_source() -> Iterator[bytes]:
    yield b"partial"
    raise RuntimeError("source failed")


class _MemoryWithWinner(InMemoryObjectStore):
    """Another writer with the same id lands its object right after this write fails."""

    def put(
        self, key: str, source: ByteSource, options: ObjectPutOptions | None = None
    ) -> ObjectInfo:
        try:
            return super().put(key, source, options)
        except Exception:
            if key == "artifacts/same":
                super().put(key, b"winner", {"mediaType": "text/plain"})
            raise


class _FileWithWinner(FileObjectStore):
    def put(
        self, key: str, source: ByteSource, options: ObjectPutOptions | None = None
    ) -> ObjectInfo:
        try:
            return super().put(key, source, options)
        except Exception:
            if key == "artifacts/same":
                super().put(key, b"winner", {"mediaType": "text/plain"})
            raise


StoreFactory = Callable[[Path], Any]
_WINNER_STORES: list[tuple[str, StoreFactory]] = [
    ("memory", lambda _: _MemoryWithWinner()),
    ("file", lambda root: _FileWithWinner(root)),
]
_STORES: list[tuple[str, StoreFactory]] = [
    ("memory", lambda _: InMemoryObjectStore()),
    ("file", lambda root: FileObjectStore(root)),
]


@pytest.mark.parametrize(("name", "open_store"), _WINNER_STORES, ids=[s[0] for s in _WINNER_STORES])
def test_rejected_write_never_deletes_a_concurrent_writers_object(
    name: str, open_store: StoreFactory, tmp_path: Path
) -> None:
    objects = open_store(tmp_path)
    coordinator = ArtifactCoordinator(
        objects, InMemoryArtifactRepository(), id_factory=lambda: "same"
    )
    with pytest.raises(ArtifactWriteError) as caught:
        coordinator.write({"bytes": _failing_source(), "mediaType": "text/plain"})
    assert caught.value.cleanup == "not-needed"
    assert _read(objects.get("artifacts/same")) == b"winner"


@pytest.mark.parametrize(("name", "open_store"), _STORES, ids=[s[0] for s in _STORES])
def test_if_absent_refuses_a_key_created_while_the_source_streamed(
    name: str, open_store: StoreFactory, tmp_path: Path
) -> None:
    objects = open_store(tmp_path)
    theirs: list[BaseException | ObjectInfo] = []

    def slow_source() -> Iterator[bytes]:
        yield b"mine"
        try:
            theirs.append(objects.put("k", b"theirs", {"ifAbsent": True}))
        except ObjectAlreadyExistsError as error:
            theirs.append(error)
        yield b"!"

    try:
        mine: BaseException | ObjectInfo = objects.put("k", slow_source(), {"ifAbsent": True})
    except ObjectAlreadyExistsError as error:
        mine = error
    outcomes = [mine, *theirs]
    assert [isinstance(outcome, ObjectAlreadyExistsError) for outcome in outcomes].count(True) == 1
    stored = _read(objects.get("k"))
    assert stored == (b"theirs" if isinstance(mine, BaseException) else b"mine!")


class _LoseFirstReply(InMemoryObjectStore):
    def __init__(self, losses: int = 1) -> None:
        super().__init__()
        self.losses = losses

    def put(
        self, key: str, source: ByteSource, options: ObjectPutOptions | None = None
    ) -> ObjectInfo:
        info = super().put(key, source, options)
        if self.losses:
            self.losses -= 1
            raise ObjectWriteIndeterminateError(key)
        return info


def test_indeterminate_write_keeps_the_object_and_creates_no_record() -> None:
    objects = _LoseFirstReply()
    repository = InMemoryArtifactRepository()
    coordinator = ArtifactCoordinator(objects, repository, id_factory=lambda: "uncertain")
    with pytest.raises(ArtifactWriteError) as caught:
        coordinator.write({"bytes": b"maybe", "mediaType": "text/plain"})
    assert caught.value.cleanup == "preserved-indeterminate"
    assert isinstance(caught.value.__cause__, ObjectWriteIndeterminateError)
    assert objects.head("artifacts/uncertain") is not None
    assert repository.get("uncertain") is None


def test_retry_with_the_same_bytes_adopts_an_indeterminate_object() -> None:
    objects = _LoseFirstReply()
    coordinator = ArtifactCoordinator(
        objects, InMemoryArtifactRepository(), id_factory=lambda: "job-1-output"
    )
    request = {"mediaType": "text/plain", "idempotencyKey": "job-1:output"}
    with pytest.raises(ArtifactWriteError) as caught:
        coordinator.write({**request, "bytes": b"rendered"})
    assert caught.value.cleanup == "preserved-indeterminate"
    artifact = coordinator.write({**request, "bytes": iter([b"rend", b"ered"])})
    assert artifact["id"] == "job-1-output"
    assert coordinator.verify(artifact["id"])["ok"] is True
    result = coordinator.read(artifact["id"])
    assert result is not None
    assert _read(result["bytes"]) == b"rendered"


def test_left_over_object_with_different_bytes_is_never_adopted_or_deleted() -> None:
    objects = InMemoryObjectStore()
    objects.put("artifacts/job-1-output", b"someone else's", {"mediaType": "text/plain"})
    coordinator = ArtifactCoordinator(
        objects, InMemoryArtifactRepository(), id_factory=lambda: "job-1-output"
    )
    with pytest.raises(ArtifactOperationError) as caught:
        coordinator.write({"bytes": b"rendered", "mediaType": "text/plain"})
    assert caught.value.code == "object-key-occupied"
    assert "delete-unreferenced-object" in str(caught.value)
    assert _read(objects.get("artifacts/job-1-output")) == b"someone else's"


def test_maintenance_audits_the_whole_store_only_when_namespace_is_none() -> None:
    objects = InMemoryObjectStore()
    objects.put("artifacts/orphan", b"orphan")
    objects.put("other-app/upload", b"not ours")
    repository = InMemoryArtifactRepository()
    scoped = ArtifactMaintenance(objects, repository).audit()
    assert scoped["scannedObjects"] == 1
    whole = ArtifactMaintenance(objects, repository, namespace=None).audit()
    assert whole["scannedObjects"] == 2
    assert [finding["code"] for finding in whole["findings"]] == ["object-without-record"] * 2
