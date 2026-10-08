from __future__ import annotations

import os
from collections.abc import Iterable
from pathlib import Path

import pytest

from mirk.artifact.errors import ArtifactValidationError
from mirk.artifact.fs import FileObjectStore
from mirk.artifact.memory import ObjectAlreadyExistsError
from mirk.artifact.types import ObjectInfo


def drain(stream: Iterable[bytes] | None) -> bytes:
    assert stream is not None
    return b"".join(stream)


def test_round_trip_and_reopen(tmp_path: Path) -> None:
    store = FileObjectStore(tmp_path)
    info = store.put(
        "images/x", [b"ab", b"cd"], {"mediaType": "image/png", "metadata": {"origin": "test"}}
    )
    assert info["sizeBytes"] == 4
    reopened = FileObjectStore(root=tmp_path)
    assert drain(reopened.get("images/x")) == b"abcd"
    head = reopened.head("images/x")
    assert head is not None
    assert head.get("mediaType") == "image/png"


def test_if_absent_conflict_preserves_existing(tmp_path: Path) -> None:
    store = FileObjectStore(tmp_path)
    store.put("k", b"old", {"ifAbsent": True})
    with pytest.raises(ObjectAlreadyExistsError):
        store.put("k", b"new", {"ifAbsent": True})
    assert drain(store.get("k")) == b"old"


@pytest.mark.parametrize("failure_type", [RuntimeError, KeyboardInterrupt, SystemExit])
def test_failed_stream_does_not_poison_if_absent(
    tmp_path: Path, failure_type: type[BaseException]
) -> None:
    store = FileObjectStore(tmp_path)
    failure = failure_type()

    def failing():
        yield b"partial"
        raise failure

    with pytest.raises(failure_type) as caught:
        store.put("k", failing(), {"ifAbsent": True})
    assert caught.value is failure
    assert store.head("k") is None
    store.put("k", b"retry", {"ifAbsent": True})
    assert drain(store.get("k")) == b"retry"


def test_sidecar_failure_after_replace_cleans_object_and_allows_retry(tmp_path: Path) -> None:
    failure = KeyboardInterrupt()

    class InterruptAfterReplace(FileObjectStore):
        def __init__(self, root: Path) -> None:
            super().__init__(root)
            self.inject = True

        def _write_sidecar(self, key: str, info: ObjectInfo) -> None:
            super()._write_sidecar(key, info)
            if self.inject:
                self.inject = False
                raise failure

    store = InterruptAfterReplace(tmp_path)
    with pytest.raises(KeyboardInterrupt) as caught:
        store.put("k", b"value", {"ifAbsent": True})
    assert caught.value is failure
    assert store.head("k") is None
    assert store.get("k") is None

    store.put("k", b"retry", {"ifAbsent": True})
    assert drain(store.get("k")) == b"retry"


def test_lazy_read_rejects_final_symlink_replacement(tmp_path: Path) -> None:
    store = FileObjectStore(tmp_path)
    store.put("k", b"inside")
    outside = tmp_path.parent / "mirk-artifact-lazy-outside"
    outside.write_bytes(b"outside")
    stream = store.get("k")
    assert stream is not None
    (tmp_path / "k.bin").unlink()
    os.symlink(outside, tmp_path / "k.bin")
    try:
        with pytest.raises(OSError):
            drain(stream)
        assert outside.read_bytes() == b"outside"
    finally:
        outside.unlink(missing_ok=True)


def test_rejects_keys_and_symlink_escape(tmp_path: Path) -> None:
    store = FileObjectStore(tmp_path)
    with pytest.raises(ArtifactValidationError):
        store.put("../escape", b"x")
    outside = tmp_path.parent / "mirk-artifact-outside"
    outside.mkdir()
    try:
        os.symlink(outside, tmp_path / "link")
        with pytest.raises(ArtifactValidationError):
            store.put("link/escape", b"x")
    finally:
        outside.rmdir()


def test_list_is_codepoint_sorted(tmp_path: Path) -> None:
    store = FileObjectStore(tmp_path)
    for key in ("objects/b", "objects/a", "objects/Z", "objects/😀"):
        store.put(key, b"x")
    assert [info["key"] for info in store.list("objects/")] == [
        "objects/Z",
        "objects/a",
        "objects/b",
        "objects/😀",
    ]
