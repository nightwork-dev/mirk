"""Dependency-free authored-data merge operations, also available in the Godot addon.

This module does not import the fixture loader. Its standalone adapter supports
Python 3.9; the mirk-fixtures distribution continues to require Python 3.12.
"""

from __future__ import annotations

import copy
from typing import Any, cast


def merge_overlay(base: Any, over: Any) -> Any:
    """Merge objects recursively, joining arrays after removing overridden ids.

    Unchanged branches and incoming values retain their original references.
    """
    if isinstance(base, dict) and isinstance(over, dict):
        left = cast(dict[str, Any], base)
        right = cast(dict[str, Any], over)
        return {
            **left,
            **{
                key: merge_overlay(left[key], value) if key in left else value
                for key, value in right.items()
            },
        }
    if isinstance(base, list) and isinstance(over, list):
        left_items = cast(list[Any], base)
        right_items = cast(list[Any], over)
        ids = {
            cast(Any, value)["id"]
            for value in right_items
            if isinstance(value, dict) and "id" in value
        }
        return [
            cast(Any, value)
            for value in left_items
            if not (isinstance(value, dict) and cast(Any, value).get("id") in ids)
        ] + right_items
    return over


def merge_layers(
    base: dict[str, Any], over: dict[str, Any], append_keys: tuple[str, ...] = ()
) -> dict[str, Any]:
    """Deep-copy object layers, replacing arrays except the configured append keys."""
    out = copy.deepcopy(base)
    for key, value in over.items():
        if key in append_keys:
            out[key] = out.get(key, []) + copy.deepcopy(value)
        elif isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge_layers(out[key], cast(dict[str, Any], value), append_keys)
        else:
            out[key] = copy.deepcopy(cast(Any, value))
    return out
