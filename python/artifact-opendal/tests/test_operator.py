from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import opendal
import pytest
from mirk.artifact.memory import ObjectAlreadyExistsError

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
    with pytest.raises(OpenDalObjectStoreError) as caught:
        store.put("objects/a", b"value", {"mediaType": "text/plain"})
    assert caught.value.code == "unsupported-content-type"


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

    expected = ObjectAlreadyExistsError if preexisting else RuntimeError
    with pytest.raises(expected):
        store.put(key, failing(), {"ifAbsent": True})
    if preexisting:
        assert drain(store.get(key)) == b"existing"
    else:
        store.put(key, b"retry", {"ifAbsent": True})
        assert drain(store.get(key)) == b"retry"
