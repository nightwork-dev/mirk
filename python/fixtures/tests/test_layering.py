"""Merge strategies, patch detection, and JavaScript object key order."""

from __future__ import annotations

from typing import Any

import pytest

from helpers import memory
from mirk.fixtures import is_patch_document, js_entries, merge_with_strategy, normalize_layers
from mirk.fixtures.types import LayeredSource

EXISTING: dict[str, Any] = {
    "nested": {"keep": True, "replace": "base"},
    "list": ["base"],
    "retained": {"stable": True},
}
INCOMING: dict[str, Any] = {"nested": {"replace": "patch"}, "list": ["patch"]}
CTX: Any = {"fixture": "t:x", "layers": []}


def test_replace_keeps_only_the_incoming_keys() -> None:
    assert merge_with_strategy("replace", EXISTING, INCOMING, CTX) == {
        "nested": {"replace": "patch"},
        "list": ["patch"],
    }


def test_deep_merges_objects_and_replaces_arrays() -> None:
    assert merge_with_strategy("deep", EXISTING, INCOMING, CTX) == {
        "nested": {"keep": True, "replace": "patch"},
        "list": ["patch"],
        "retained": {"stable": True},
    }


def test_array_replace_merges_only_top_level_keys() -> None:
    assert merge_with_strategy("array-replace", EXISTING, INCOMING, CTX) == {
        "nested": {"replace": "patch"},
        "list": ["patch"],
        "retained": {"stable": True},
    }


def test_the_default_strategy_is_replace() -> None:
    assert merge_with_strategy(None, EXISTING, INCOMING, CTX) == merge_with_strategy(
        "replace", EXISTING, INCOMING, CTX
    )


@pytest.mark.parametrize("strategy", ["replace", "deep", "array-replace"])
def test_every_strategy_deep_copies_both_inputs(strategy: str) -> None:
    existing: dict[str, Any] = {"nested": {"keep": True}, "list": ["base"]}
    incoming: dict[str, Any] = {"nested": {"add": 1}, "list": ["patch"]}
    result: Any = merge_with_strategy(strategy, existing, incoming, CTX)  # type: ignore[arg-type]
    result["nested"]["mutated"] = True
    result["list"].append("mutated")
    assert existing == {"nested": {"keep": True}, "list": ["base"]}
    assert incoming == {"nested": {"add": 1}, "list": ["patch"]}


def test_deep_treats_null_as_an_overwrite_not_a_no_op() -> None:
    assert merge_with_strategy("deep", {"a": {"b": 1}}, {"a": None}, CTX) == {"a": None}


def test_deep_replaces_an_object_with_a_scalar_and_a_scalar_with_an_object() -> None:
    assert merge_with_strategy("deep", {"a": {"b": 1}}, {"a": 5}, CTX) == {"a": 5}
    assert merge_with_strategy("deep", {"a": 5}, {"a": {"b": 1}}, CTX) == {"a": {"b": 1}}


def test_no_strategy_can_delete_a_key() -> None:
    for strategy in ("deep", "array-replace"):
        merged: Any = merge_with_strategy(strategy, {"gone": 1}, {"kept": 2}, CTX)  # type: ignore[arg-type]
        assert merged["gone"] == 1


def test_a_callable_strategy_result_is_used_verbatim() -> None:
    sentinel = object()

    def strategy(existing: Any, incoming: Any, ctx: Any) -> Any:
        return sentinel

    assert merge_with_strategy(strategy, EXISTING, INCOMING, CTX) is sentinel


def test_a_patch_document_needs_a_string_dollar_patch() -> None:
    assert is_patch_document({"$patch": "t:x"})
    assert not is_patch_document({"$patch": 42})
    assert not is_patch_document([{"$patch": "t:x"}])
    assert not is_patch_document("t:x")


def test_js_entries_puts_array_index_keys_first_in_numeric_order() -> None:
    """Verified against Node: `Object.entries({"10":…,"2":…,"b":…,"a":…})`
    yields `2, 10, b, a`. Python dicts are pure insertion order, so the loader
    would otherwise report a different one of several bad map entries."""
    entries = js_entries({"10": 1, "2": 2, "b": 3, "a": 4})
    assert [key for key, _ in entries] == ["2", "10", "b", "a"]


@pytest.mark.parametrize("key", ["01", "-1", "1.0", "4294967295", " 1", "1e2"])
def test_a_key_that_is_not_a_canonical_array_index_keeps_insertion_order(key: str) -> None:
    entries = js_entries({key: 1, "0": 2})
    assert [name for name, _ in entries] == ["0", key]


def test_a_bare_source_takes_its_declaration_index_as_its_priority() -> None:
    first = memory("first", {})
    second = memory("second", {})
    layers = normalize_layers([first, second])
    assert [(layer.layer, layer.priority) for layer in layers] == [("first", 0), ("second", 1)]


def test_layers_sort_by_priority_then_declaration_order() -> None:
    a = memory("a", {})
    b = memory("b", {})
    c = memory("c", {})
    layers = normalize_layers(
        [LayeredSource(a, "a", 5), LayeredSource(b, "b", 1), LayeredSource(c, "c", 5)]
    )
    assert [layer.layer for layer in layers] == ["b", "a", "c"]
