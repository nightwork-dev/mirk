"""Shared JSON value semantics: filtering, equality, and encoding.

Filter order is `where`, then `sortBy`/`sortDir`, then `offset`, then `limit`.
Null and missing sort values land last in both directions. Ties keep insertion
order.
"""

from __future__ import annotations

import json
import math
from typing import Any, cast

from .canonical import escape_lone_surrogates
from .types import StoreFilter

__all__ = [
    "FILTER_SCALAR_MESSAGE",
    "IN_SCALAR_MESSAGE",
    "apply_filter",
    "dumps_json",
    "json_equal",
    "matches_where",
    "normalize_json_numbers",
    "sort_key",
    "validate_where",
]

FILTER_SCALAR_MESSAGE = "Store filters only support JSON scalar values."
IN_SCALAR_MESSAGE = "Store IN queries only support JSON scalar values."
_MAX_SAFE_INTEGER = 2**53


def normalize_json_numbers(value: Any) -> Any:
    """Rewrite integral floats as ints, recursively.

    JavaScript has one number type, so ``JSON.stringify(1.0)`` writes ``1`` and
    SQLite's ``json_type`` then reports ``integer``. Python would write ``1.0``
    and get ``real``. Normalizing before encoding keeps the two writers
    indistinguishable to a SQLite reader. Booleans are left alone.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    if isinstance(value, int) and abs(value) > _MAX_SAFE_INTEGER:
        # JavaScript has only float64, so an integer above 2^53 is stored as its
        # nearest double by the TypeScript writer; match it or the two languages
        # read different values from one file.
        return int(float(value))
    if isinstance(value, list):
        return [normalize_json_numbers(item) for item in cast(list[Any], value)]
    if isinstance(value, dict):
        source = cast(dict[str, Any], value)
        return {key: normalize_json_numbers(item) for key, item in source.items()}
    return value


def dumps_json(value: Any) -> str:
    """Encode JSON the way ``JSON.stringify`` does, everywhere SQLite can see it.

    A missing field is an absent key, never an explicit ``null``: ``where {f:
    None}`` matches a stored null and not a missing key, so writing one for the
    other would change what matches.
    """
    return escape_lone_surrogates(
        json.dumps(
            normalize_json_numbers(value),
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
    )


def is_scalar(value: object) -> bool:
    """True for the JSON scalars a filter may compare against."""
    return value is None or isinstance(value, bool | int | float | str)


def json_equal(a: Any, b: Any) -> bool:
    """Type-aware JSON equality.

    `True` and `1` are different values even though Python compares them equal;
    `1` and `1.0` are the same value because JSON has one number type.
    """
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, int | float) and isinstance(b, int | float):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        xs = cast(list[Any], a)
        ys = cast(list[Any], b)
        return len(xs) == len(ys) and all(json_equal(x, y) for x, y in zip(xs, ys, strict=True))
    if isinstance(a, dict) and isinstance(b, dict):
        left = cast(dict[str, Any], a)
        right = cast(dict[str, Any], b)
        if left.keys() != right.keys():
            return False
        return all(json_equal(left[key], right[key]) for key in left)
    return False


def validate_where(where: dict[str, Any]) -> None:
    """Reject non-scalar `where` values before any row is examined."""
    for value in where.values():
        if not is_scalar(value):
            raise ValueError(FILTER_SCALAR_MESSAGE)


def matches_where(item: Any, where: dict[str, Any]) -> bool:
    """Exact match on literal top-level keys, ANDed. A dotted name is one key."""
    if not isinstance(item, dict):
        return False
    record = cast(dict[str, Any], item)
    for key, value in where.items():
        if key not in record:
            return False
        if not json_equal(record[key], value):
            return False
    return True


def _rank(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int | float):
        return 1
    if isinstance(value, str):
        return 2
    return 3


def sort_key(value: Any) -> tuple[int, Any]:
    """Deterministic, total sort key.

    Ordering across different JSON types is unspecified by the contract; a type
    rank keeps it deterministic instead of raising.
    """
    rank = _rank(value)
    if rank == 0:
        return (0, 1 if value else 0)
    if rank == 1:
        return (1, float(value))
    if rank == 2:
        return (2, value)
    return (3, json.dumps(value, sort_keys=True, ensure_ascii=False))


def _floor(value: float) -> int:
    return math.floor(value)


def apply_filter(items: list[Any], filter: StoreFilter | None = None) -> list[Any]:
    """Apply where, sort, offset and limit in that order."""
    if not filter:
        return list(items)

    result = list(items)

    where = filter.get("where")
    if where:
        validate_where(where)
        result = [item for item in result if matches_where(item, where)]

    sort_by = filter.get("sortBy")
    if sort_by:
        descending = filter.get("sortDir") == "desc"
        present: list[Any] = []
        absent: list[Any] = []
        for item in result:
            record = cast(dict[str, Any], item) if isinstance(item, dict) else {}
            value = record.get(sort_by)
            (absent if value is None else present).append(item)
        present.sort(
            key=lambda item: sort_key(cast(dict[str, Any], item).get(sort_by)),
            reverse=descending,
        )
        result = present + absent

    offset = filter.get("offset")
    if offset is not None and offset > 0:
        result = result[_floor(offset) :]

    limit = filter.get("limit")
    if limit is not None:
        result = result[: max(0, _floor(limit))]

    return result
