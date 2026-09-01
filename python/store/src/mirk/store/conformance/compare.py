"""Compare a step result against a corpus ``expect`` clause.

Every function returns ``None`` on a match, or a human-readable diff naming the
JSON path that disagreed.

Forms: ``value`` (exact), ``values`` with optional ``approxFields``/``tol``
(compared within tolerance) and optional ``ignoreFields`` (dropped from both
sides before comparison), ``ids`` (ordered result ids), and ``throws`` (exact
message).
"""

from __future__ import annotations

from typing import Any, cast

__all__ = ["compare_expect", "deep_equal"]

_DEFAULT_TOL = 1e-6


def _kind(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _as_list(value: Any) -> list[Any]:
    return cast(list[Any], value)


def _as_object(value: Any) -> dict[str, Any]:
    return cast(dict[str, Any], value)


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _field_names(value: Any) -> list[str]:
    return [str(field) for field in _as_list(value)] if isinstance(value, list) else []


def deep_equal(actual: Any, expected: Any, path: str = "$") -> str | None:
    """Exact deep equality. Bools are not numbers; ints and floats compare by value."""
    if isinstance(expected, bool) or isinstance(actual, bool):
        if actual is expected:
            return None
        return f"{path}: expected {expected!r}, got {actual!r}"
    if expected is None or actual is None:
        if actual is None and expected is None:
            return None
        return f"{path}: expected {expected!r}, got {actual!r}"
    if _is_number(expected) and _is_number(actual):
        return None if actual == expected else f"{path}: expected {expected!r}, got {actual!r}"
    if _kind(actual) != _kind(expected):
        return f"{path}: expected {_kind(expected)} {expected!r}, got {_kind(actual)} {actual!r}"
    if isinstance(expected, str):
        return None if actual == expected else f"{path}: expected {expected!r}, got {actual!r}"
    if isinstance(expected, list):
        actual_items = _as_list(actual)
        expected_items = _as_list(expected)
        if len(actual_items) != len(expected_items):
            return f"{path}: expected {len(expected_items)} items, got {len(actual_items)}"
        for index in range(len(expected_items)):
            diff = deep_equal(actual_items[index], expected_items[index], f"{path}[{index}]")
            if diff is not None:
                return diff
        return None
    if isinstance(expected, dict):
        actual_obj = _as_object(actual)
        expected_obj = _as_object(expected)
        for key in sorted(set(actual_obj) | set(expected_obj)):
            if key not in actual_obj:
                return f"{path}.{key}: missing, expected {expected_obj[key]!r}"
            if key not in expected_obj:
                return f"{path}.{key}: unexpected {actual_obj[key]!r}"
            diff = deep_equal(actual_obj[key], expected_obj[key], f"{path}.{key}")
            if diff is not None:
                return diff
        return None
    return None if actual == expected else f"{path}: expected {expected!r}, got {actual!r}"


def _compare_approx(
    actual: Any,
    expected: Any,
    approx_fields: list[str],
    ignore_fields: list[str],
    tol: float,
    path: str,
) -> str | None:
    if not isinstance(actual, list):
        return f"{path}: expected an array, got {_kind(actual)}"
    actual_rows = _as_list(actual)
    expected_rows = _as_list(expected)
    if len(actual_rows) != len(expected_rows):
        return f"{path}: expected {len(expected_rows)} rows, got {len(actual_rows)}"
    for index in range(len(expected_rows)):
        row: Any = actual_rows[index]
        want: Any = expected_rows[index]
        row_path = f"{path}[{index}]"
        if not isinstance(row, dict) or not isinstance(want, dict):
            diff = deep_equal(row, want, row_path)
            if diff is not None:
                return diff
            continue
        row_obj = _as_object(row)
        want_obj = _as_object(want)
        for field in approx_fields:
            if field not in want_obj:
                continue
            if field not in row_obj:
                return f"{row_path}.{field}: missing"
            got: Any = row_obj[field]
            target: Any = want_obj[field]
            if not _is_number(got):
                return f"{row_path}.{field}: expected a number, got {got!r}"
            if abs(float(got) - float(target)) > tol:
                return f"{row_path}.{field}: {got!r} is not within {tol} of {target!r}"
        dropped = set(approx_fields) | set(ignore_fields)
        stripped_row = {k: v for k, v in row_obj.items() if k not in dropped}
        stripped_want = {k: v for k, v in want_obj.items() if k not in dropped}
        diff = deep_equal(stripped_row, stripped_want, row_path)
        if diff is not None:
            return diff
    return None


def compare_expect(actual: Any, expect: dict[str, Any]) -> str | None:
    """Check one step result against its ``expect`` clause."""
    threw = isinstance(actual, dict) and _as_object(actual).get("ok") is False

    if "throws" in expect:
        if not threw:
            return f"expected a raise with {expect['throws']!r}, got {actual!r}"
        message: Any = _as_object(actual).get("message")
        if message != expect["throws"]:
            return f"$.message: expected {expect['throws']!r}, got {message!r}"
        return None

    if threw:
        return f"unexpected raise: {_as_object(actual).get('message')!r}"

    if "value" in expect:
        return deep_equal(actual, expect["value"])

    if "values" in expect:
        approx = _field_names(expect.get("approxFields"))
        ignore = _field_names(expect.get("ignoreFields"))
        tol_raw: Any = expect.get("tol")
        tol = float(tol_raw) if _is_number(tol_raw) else _DEFAULT_TOL
        return _compare_approx(actual, expect["values"], approx, ignore, tol, "$")

    if "ids" in expect:
        if not isinstance(actual, list):
            return f"$: expected an array, got {_kind(actual)}"
        ids: list[Any] = []
        for row in _as_list(actual):
            ids.append(_as_object(row).get("id") if isinstance(row, dict) else row)
        return deep_equal(ids, expect["ids"], "$.ids")

    return f"unsupported expect form: {sorted(expect)}"
