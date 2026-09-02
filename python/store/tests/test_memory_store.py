"""Behaviors the language-neutral corpus cannot express."""

from __future__ import annotations

import pytest

from mirk.store import InMemoryStore, namespace_store
from mirk.store.namespace import SEPARATOR


def test_list_returns_copies_not_live_references() -> None:
    store = InMemoryStore()
    store.put("things", {"id": "a", "n": 1})
    first = store.list("things")[0]
    first["n"] = 99
    assert store.getById("things", "a")["n"] == 1


def test_put_copies_the_argument_so_later_mutation_does_not_leak() -> None:
    store = InMemoryStore()
    item = {"id": "a", "n": 1}
    returned = store.put("things", item)
    assert returned is item
    item["n"] = 99
    assert store.getById("things", "a")["n"] == 1


def test_kv_values_are_copied_on_read() -> None:
    store = InMemoryStore()
    store.set("k", {"nested": [1, 2]})
    value = store.get("k")
    value["nested"].append(3)
    assert store.get("k") == {"nested": [1, 2]}


def test_nan_is_rejected_by_the_encoder() -> None:
    store = InMemoryStore()
    with pytest.raises(ValueError):
        store.set("k", float("nan"))


def test_namespace_isolates_keys_and_collections() -> None:
    backing = InMemoryStore()
    alpha = namespace_store(backing, "alpha")
    beta = namespace_store(backing, "beta")
    alpha.set("k", 1)
    beta.set("k", 2)
    alpha.put("c", {"id": "x", "v": "a"})
    beta.put("c", {"id": "x", "v": "b"})
    assert alpha.get("k") == 1
    assert beta.get("k") == 2
    assert alpha.getById("c", "x")["v"] == "a"
    assert beta.getById("c", "x")["v"] == "b"
    assert alpha.keys() == ["k"]
    assert backing.keys() == [f"alpha{SEPARATOR}k", f"beta{SEPARATOR}k"]


@pytest.mark.parametrize("namespace", ["", f"a{SEPARATOR}b"])
def test_invalid_namespace_raises(namespace: str) -> None:
    with pytest.raises(ValueError) as info:
        namespace_store(InMemoryStore(), namespace)
    assert str(info.value) == (
        "namespace must be non-empty and must not contain the unit separator"
    )


def test_default_version_identity_is_a_per_process_serial() -> None:
    """Two default stores mint distinguishable tokens; an injected identity wins."""
    first = InMemoryStore()
    second = InMemoryStore()
    first.set("k", 1)
    second.set("k", 1)
    first_version = first.getVersioned({"kind": "key", "key": "k"})
    second_version = second.getVersioned({"kind": "key", "key": "k"})
    assert first_version is not None and second_version is not None
    assert first_version["version"] != second_version["version"]
    assert first_version["version"].endswith("-v1")
    assert first_version["version"].startswith("m")

    pinned = InMemoryStore(version_identity="conformance")
    pinned.set("k", 1)
    pinned.put("c", {"id": "a"})
    assert pinned.getVersioned({"kind": "key", "key": "k"}) == {
        "value": 1,
        "version": "conformance-v1",
    }
    assert pinned.getVersioned({"kind": "record", "collection": "c", "id": "a"}) == {
        "value": {"id": "a"},
        "version": "conformance-v2",
    }


def test_integers_above_2_53_round_to_the_nearest_double() -> None:
    """JavaScript has only float64; a Python int must not survive more exactly."""
    store = InMemoryStore()
    store.set("big", 9007199254740993)
    assert store.get("big") == 9007199254740992
    store.put("n", {"id": "r", "n": 9007199254740993, "nested": [-9007199254740993]})
    assert store.getById("n", "r") == {
        "id": "r",
        "n": 9007199254740992,
        "nested": [-9007199254740992],
    }
    store.set("safe", 9007199254740992)
    assert store.get("safe") == 9007199254740992


def test_lone_surrogate_values_round_trip() -> None:
    store = InMemoryStore()
    store.set("lone", "x\udc00y")
    assert store.get("lone") == "x\udc00y"
    store.put("s", {"id": "r", "text": "\ud800", "pair": "\U0001f600"})
    assert store.getById("s", "r") == {"id": "r", "text": "\ud800", "pair": "\U0001f600"}
