from __future__ import annotations

from collections.abc import Iterable, Iterator
from pathlib import Path
from typing import Any

import opendal
import pytest
from mirk.artifact.coordinator import ArtifactCoordinator, ArtifactWriteError
from mirk.artifact.errors import ObjectWriteIndeterminateError, ObjectWriteRejectedError
from mirk.artifact.memory import InMemoryArtifactRepository, ObjectAlreadyExistsError
from mirk.artifact.types import ByteSource, ObjectInfo, ObjectPutOptions
from opendal.exceptions import AlreadyExists  # pyright: ignore[reportMissingModuleSource]

from mirk.artifact_opendal import OpenDalObjectStore, OpenDalObjectStoreError


def drain(stream: Iterable[bytes] | None) -> bytes:
    assert stream is not None
    return b"".join(stream)


def test_memory_round_trip_and_conditional_write() -> None:
    store = OpenDalObjectStore(opendal.Operator("memory"))
    assert store.put("objects/a", [b"a", b"b"], {"ifAbsent": True})["sizeBytes"] == 2
    assert drain(store.get("objects/a")) == b"ab"
    with pytest.raises(ObjectAlreadyExistsError):
        store.put("objects/a", b"replacement", {"ifAbsent": True})
    assert drain(store.get("objects/a")) == b"ab"


def test_filesystem_round_trip_and_unsupported_recursive_list(tmp_path: Path) -> None:
    store = OpenDalObjectStore(opendal.Operator("fs", root=str(tmp_path)))
    store.put("objects/a", b"value", {"ifAbsent": True})
    assert drain(store.get("objects/a")) == b"value"
    with pytest.raises(OpenDalObjectStoreError) as caught:
        store.list("objects/")
    assert caught.value.code == "unsupported-recursive-list"


def test_filesystem_rejects_unsupported_content_type(tmp_path: Path) -> None:
    store = OpenDalObjectStore(opendal.Operator("fs", root=str(tmp_path)))
    with pytest.raises(ObjectWriteRejectedError) as caught:
        store.put("objects/a", b"value", {"mediaType": "text/plain"})
    cause = caught.value.__cause__
    assert isinstance(cause, OpenDalObjectStoreError)
    assert cause.code == "unsupported-content-type"


def test_memory_listing_has_nonempty_prefixed_entries_in_order() -> None:
    store = OpenDalObjectStore(opendal.Operator("memory"))
    store.put("objects/b", b"b")
    store.put("objects/a", b"a")
    store.put("other", b"other")

    entries = store.list("objects/")
    assert entries
    assert [info["key"] for info in entries] == ["objects/a", "objects/b"]
    assert all(str(info["key"]).startswith("objects/") for info in entries)
    assert [info["key"] for info in store.list("objects/a")] == ["objects/a"]


@pytest.mark.parametrize("before_yield", [True, False])
@pytest.mark.parametrize("preexisting", [True, False])
def test_conditional_source_failures_preserve_conflicts_and_clean_owned_objects(
    before_yield: bool, preexisting: bool
) -> None:
    store = OpenDalObjectStore(opendal.Operator("memory"))
    key = f"objects/failure-{before_yield}-{preexisting}"
    if preexisting:
        store.put(key, b"existing", {"ifAbsent": True})

    def failing():
        if not before_yield:
            yield b"partial"
        raise RuntimeError("source failed")

    expected = ObjectAlreadyExistsError if preexisting else ObjectWriteRejectedError
    with pytest.raises(expected):
        store.put(key, failing(), {"ifAbsent": True})
    if preexisting:
        assert drain(store.get(key)) == b"existing"
    else:
        store.put(key, b"retry", {"ifAbsent": True})
        assert drain(store.get(key)) == b"retry"


def test_coordinator_never_deletes_a_concurrent_writers_object_after_a_rejected_write() -> None:
    class WinnerStore(OpenDalObjectStore):
        def put(
            self, key: str, source: ByteSource, options: ObjectPutOptions | None = None
        ) -> ObjectInfo:
            try:
                return super().put(key, source, options)
            except Exception:
                if key == "artifacts/same":
                    super().put(key, b"winner", {"mediaType": "text/plain"})
                raise

    def failing() -> Iterator[bytes]:
        yield b"partial"
        raise RuntimeError("source failed")

    store = WinnerStore(opendal.Operator("memory"))
    coordinator = ArtifactCoordinator(
        store, InMemoryArtifactRepository(), id_factory=lambda: "same"
    )
    with pytest.raises(ArtifactWriteError) as caught:
        coordinator.write({"bytes": failing(), "mediaType": "text/plain"})
    assert caught.value.cleanup == "not-needed"
    assert drain(store.get("artifacts/same")) == b"winner"


class _CloseFails:
    """An operator whose writers commit their bytes and then lose the close reply."""

    def __init__(self, operator: opendal.Operator) -> None:
        self._operator = operator

    def __getattr__(self, name: str) -> Any:
        return getattr(self._operator, name)

    def open(self, path: str, mode: str, **options: Any) -> Any:
        file = self._operator.open(path, mode, **options)
        if mode != "wb":
            return file

        class Writer:
            def write(self, chunk: bytes) -> None:
                file.write(chunk)

            def close(self) -> None:
                file.close()
                raise OSError("connection reset after upload")

        return Writer()


def test_conditional_close_failure_is_indeterminate_and_the_coordinator_keeps_the_object() -> None:
    store = OpenDalObjectStore(_CloseFails(opendal.Operator("memory")))  # pyright: ignore[reportArgumentType]
    with pytest.raises(ObjectWriteIndeterminateError):
        store.put("objects/a", b"landed", {"ifAbsent": True})
    assert drain(store.get("objects/a")) == b"landed"

    repository = InMemoryArtifactRepository()
    coordinator = ArtifactCoordinator(store, repository, id_factory=lambda: "uncertain")
    with pytest.raises(ArtifactWriteError) as caught:
        coordinator.write({"bytes": b"maybe", "mediaType": "text/plain"})
    assert caught.value.cleanup == "preserved-indeterminate"
    assert drain(store.get("artifacts/uncertain")) == b"maybe"
    assert repository.get("uncertain") is None


class _CommitOnClose:
    """An operator whose writers buffer and commit on close, like S3 multipart.

    ``close_error`` is raised after the commit; ``delete_fails`` makes deletes
    raise while leaving the object in place.
    """

    def __init__(
        self,
        operator: opendal.Operator,
        *,
        close_error: BaseException | None = None,
        delete_fails: bool = False,
    ) -> None:
        self._operator = operator
        self.close_error = close_error
        self.delete_fails = delete_fails

    def __getattr__(self, name: str) -> Any:
        return getattr(self._operator, name)

    def delete(self, path: str) -> None:
        if self.delete_fails:
            raise OSError("delete refused")
        self._operator.delete(path)

    def open(self, path: str, mode: str, **options: Any) -> Any:
        if mode != "wb":
            return self._operator.open(path, mode, **options)
        double = self
        parts: list[bytes] = []

        class Writer:
            def write(self, chunk: bytes) -> None:
                parts.append(bytes(chunk))

            def close(self) -> None:
                double._operator.write(path, b"".join(parts))
                if double.close_error is not None:
                    raise double.close_error

        return Writer()


def _partial_then_failure() -> Iterator[bytes]:
    yield b"partial-"
    raise RuntimeError("source failed")


@pytest.mark.parametrize("if_absent", [True, False])
def test_a_committed_partial_that_cannot_be_removed_is_indeterminate(if_absent: bool) -> None:
    operator = _CommitOnClose(opendal.Operator("memory"), delete_fails=True)
    store = OpenDalObjectStore(operator)  # pyright: ignore[reportArgumentType]
    with pytest.raises(ObjectWriteIndeterminateError):
        store.put("objects/a", _partial_then_failure(), {"ifAbsent": if_absent})
    assert drain(store.get("objects/a")) == b"partial-"


def test_coordinator_keeps_a_partial_it_could_not_remove() -> None:
    operator = _CommitOnClose(opendal.Operator("memory"), delete_fails=True)
    store = OpenDalObjectStore(operator)  # pyright: ignore[reportArgumentType]
    coordinator = ArtifactCoordinator(
        store, InMemoryArtifactRepository(), id_factory=lambda: "same"
    )
    with pytest.raises(ArtifactWriteError) as caught:
        coordinator.write({"bytes": _partial_then_failure(), "mediaType": "text/plain"})
    assert caught.value.cleanup == "preserved-indeterminate"


@pytest.mark.parametrize("delete_fails", [False, True])
def test_unconditional_write_removes_its_partial_after_a_close_conflict(
    delete_fails: bool,
) -> None:
    operator = _CommitOnClose(
        opendal.Operator("memory"),
        close_error=AlreadyExists("conflict at close"),
        delete_fails=delete_fails,
    )
    store = OpenDalObjectStore(operator)  # pyright: ignore[reportArgumentType]
    expected = ObjectWriteIndeterminateError if delete_fails else ObjectWriteRejectedError
    with pytest.raises(expected):
        store.put("objects/a", _partial_then_failure())
    assert (store.head("objects/a") is None) is not delete_fails
