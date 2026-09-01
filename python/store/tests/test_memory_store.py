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
