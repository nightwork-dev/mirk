"""Layer normalization, patch detection, and the three builtin merge strategies.

All three strategies deep-copy, so a merge result never aliases either input.
That is a contract, not an implementation detail: a custom strategy is required
to hold it too.
"""

from __future__ import annotations

import copy
from collections.abc import Sequence
from typing import Any, cast

from .types import (
    FixtureProvenanceLayer,
    FixtureSource,
    LayeredSource,
    MergeContext,
    MergeStrategy,
)

__all__ = [
    "NormalizedLayeredSource",
    "clone_jsonish",
    "is_patch_document",
    "is_plain_object",
    "js_entries",
    "merge_with_strategy",
    "normalize_layers",
    "patch_body",
    "provenance_ctx",
]

_MAX_ARRAY_INDEX = 2**32 - 2


class NormalizedLayeredSource:
    """A layered source plus its declaration index, the documented tie-break."""

    __slots__ = ("layer", "order", "priority", "source")

    def __init__(self, source: FixtureSource, layer: str, priority: float, order: int) -> None:
        self.source = source
        self.layer = layer
        self.priority = priority
        self.order = order


def normalize_layers(
    sources: Sequence[FixtureSource | LayeredSource],
) -> list[NormalizedLayeredSource]:
    """Sort by priority, then by declaration order.

    A bare source takes its declaration index as its priority, so mixing bare
    and explicit entries is legal: the implicit priorities are indexes, never
    zeros.
    """
    normalized: list[NormalizedLayeredSource] = []
    for index, entry in enumerate(sources):
        if isinstance(entry, LayeredSource):
            normalized.append(
                NormalizedLayeredSource(entry.source, entry.layer, entry.priority, index)
            )
        else:
            normalized.append(NormalizedLayeredSource(entry, entry.id, index, index))
    return sorted(normalized, key=lambda item: (item.priority, item.order))


def is_patch_document(value: Any) -> bool:
    """A non-list object with a **string** `$patch`. `$patch: 42` is a base."""
    return isinstance(value, dict) and isinstance(cast(Any, value).get("$patch"), str)


def patch_body(doc: dict[str, Any]) -> dict[str, Any]:
    """The patch minus its `$patch` marker. There is no delete sentinel."""
    return {key: value for key, value in doc.items() if key != "$patch"}


def js_entries(obj: dict[str, Any]) -> list[tuple[str, Any]]:
    """Iterate a dict the way JavaScript's `Object.entries` iterates an object.

    Array-index-like keys come first in ascending numeric order, then every
    other key in insertion order. Python dicts are pure insertion order, so
    `{"10": …, "2": …, "b": …}` would otherwise expand in a different order
    from the TypeScript loader, changing which of several bad map entries
    reports its error first and the order references are extracted in.
    """
    indexed: list[tuple[int, str]] = []
    rest: list[str] = []
    for key in obj:
        if _is_array_index(key):
            indexed.append((int(key), key))
        else:
            rest.append(key)
    indexed.sort(key=lambda pair: pair[0])
    return [(key, obj[key]) for _, key in indexed] + [(key, obj[key]) for key in rest]


def _is_array_index(key: str) -> bool:
    if not key.isascii() or not key.isdigit():
        return False
    if key != "0" and key.startswith("0"):
        return False
    return int(key) <= _MAX_ARRAY_INDEX


def merge_with_strategy(
    strategy: MergeStrategy | None,
    existing: Any,
    incoming: Any,
    ctx: MergeContext,
) -> Any:
    if callable(strategy):
        return strategy(existing, incoming, ctx)
    if strategy is None or strategy == "replace":
        return clone_jsonish(incoming)
    if strategy == "deep":
        return _deep_merge(existing, incoming)
    if strategy == "array-replace":
        return _shallow_object_merge(existing, incoming)
    raise ValueError(f"unknown merge strategy: {strategy!r}")


def provenance_ctx(layers: Sequence[FixtureProvenanceLayer]) -> list[dict[str, Any]]:
    """The layers a custom strategy sees: everything applied so far, not this one."""
    return [
        {
            "sourceId": layer["sourceId"],
            "layer": layer["layer"],
            "priority": layer["priority"],
            "kind": layer["kind"],
        }
        for layer in layers
    ]


def _deep_merge(existing: Any, incoming: Any) -> Any:
    """Recursive object merge. Arrays, `null` and scalars replace at every depth."""
    if not is_plain_object(existing) or not is_plain_object(incoming):
        return clone_jsonish(incoming)

    out: dict[str, Any] = {}
    for key, value in js_entries(existing):
        out[key] = clone_jsonish(value)
    for key, value in js_entries(incoming):
        out[key] = _deep_merge(existing[key], value) if key in existing else clone_jsonish(value)
    return out


def _shallow_object_merge(existing: Any, incoming: Any) -> Any:
    """Top-level keys from `incoming` win wholesale; nothing recurses."""
    if not is_plain_object(existing) or not is_plain_object(incoming):
        return clone_jsonish(incoming)
    out: dict[str, Any] = {}
    for key, value in js_entries(existing):
        out[key] = clone_jsonish(value)
    for key, value in js_entries(incoming):
        out[key] = clone_jsonish(value)
    return out


def is_plain_object(value: Any) -> bool:
    """Exactly a `dict`. A subclass is a replacement value, like a class
    instance in TypeScript, which fails the `Object.prototype` test."""
    return type(value) is dict


def clone_jsonish(value: Any) -> Any:
    if not isinstance(value, dict | list):
        return value
    return copy.deepcopy(cast(Any, value))
