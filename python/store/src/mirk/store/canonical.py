"""Canonical JSON and SHA-256 digests, byte-identical to `@mirk/store/atomic`.

Ports `canonicalValue`/`canonicalJson` from `packages/store/src/atomic.ts:206-256` and
the ECMAScript `Number::toString` algorithm those functions rely on (`JSON.stringify`
on a JS number). The exact rules are pinned in
`docs/python-port/digests/artifact.md` sections 2 and 13; this module and its test
suite are the byte-identity proof for the Python port.

No dependency beyond the standard library: this stays importable from anywhere
`@mirk/store/atomic` is importable in TypeScript (root and browser-facing ports).
"""

from __future__ import annotations

import hashlib
import json
import math
from decimal import Decimal
from typing import cast

__all__ = [
    "canonical_digest",
    "canonical_json",
    "compare_code_points",
    "js_number_to_string",
    "sha256_hex",
    "sha256_hex_bytes",
]

_NON_FINITE_MESSAGE = "non-finite numbers are not JSON-safe"
_NOT_SAFE_MESSAGE = "only plain objects are JSON-safe"
_CYCLIC_MESSAGE = "cyclic values are not JSON-safe"

_SURROGATE_LOW = 0xD800
_SURROGATE_HIGH = 0xDFFF


def js_number_to_string(value: float) -> str:
    """ECMAScript `Number::toString(10)` (spec 6.1.6.1.20).

    Takes the shortest round-trip digits CPython's `repr(float)` already produces
    and repackages them under the ECMAScript fixed/exponential rules: with
    significant digits `d` (`k` of them) and decimal exponent `n` such that
    `value = 0.d * 10^n`:

    - `k <= n <= 21` -> digits followed by `n - k` zeros (no point).
    - `0 < n <= 21` -> digits with a point after the first `n` digits.
    - `-6 < n <= 0` -> `"0."` + `-n` zeros + digits.
    - otherwise -> exponent form `d[.ddd]e±(n-1)`, no zero padding.

    `-0.0` prints as `"0"`. Non-finite values raise `TypeError`.
    """
    if math.isnan(value) or math.isinf(value):
        raise TypeError(_NON_FINITE_MESSAGE)
    if value == 0:
        return "0"

    negative = value < 0
    text = repr(-value if negative else value)
    sign, digit_tuple, exponent = Decimal(text).as_tuple()
    assert sign == 0, "abs(value) must parse as a non-negative Decimal"
    digits = list(digit_tuple)
    exponent = int(exponent)

    # `digits`/`exponent` here come from Python's `repr`, which pads a trailing
    # ".0" onto integral floats (`300.0`). Those trailing zeros are positional,
    # not significant, so strip them and fold them into the exponent instead.
    while len(digits) > 1 and digits[-1] == 0:
        digits.pop()
        exponent += 1

    digit_str = "".join(str(d) for d in digits)
    k = len(digits)
    n = k + exponent

    if k <= n <= 21:
        body = digit_str + "0" * (n - k)
    elif 0 < n <= 21:
        body = f"{digit_str[:n]}.{digit_str[n:]}"
    elif -6 < n <= 0:
        body = f"0.{'0' * -n}{digit_str}"
    else:
        exp = n - 1
        mantissa = digit_str if k == 1 else f"{digit_str[0]}.{digit_str[1:]}"
        body = f"{mantissa}e{'+' if exp >= 0 else '-'}{abs(exp)}"

    return f"-{body}" if negative else body


def _canonical_string(value: str) -> str:
    """ECMAScript `QuoteJSONString`, including lone-surrogate escaping.

    `json.dumps(s, ensure_ascii=False)` already reproduces every row of the
    digest's string-escaping table (short forms, lowercase `\\u00XX` for other C0
    controls, DEL/U+2028/U+2029 and every non-ASCII character left raw) except
    lone surrogates: a Python `str` can hold an unpaired surrogate code point
    (there is no UTF-16 storage to forbid it), and `json.dumps` passes it through
    literally, which is not valid UTF-8. Escape those after the fact so the
    result always encodes.
    """
    dumped = json.dumps(value, ensure_ascii=False)
    if any(_SURROGATE_LOW <= ord(char) <= _SURROGATE_HIGH for char in dumped):
        dumped = "".join(
            f"\\u{ord(char):04x}" if _SURROGATE_LOW <= ord(char) <= _SURROGATE_HIGH else char
            for char in dumped
        )
    return dumped


def _canonical_list(value: list[object], stack: set[int]) -> str:
    marker = id(value)
    if marker in stack:
        raise TypeError(_CYCLIC_MESSAGE)
    stack.add(marker)
    try:
        return "[" + ",".join(_canonical_value(item, stack) for item in value) + "]"
    finally:
        stack.discard(marker)


def _canonical_dict(value: dict[object, object], stack: set[int]) -> str:
    marker = id(value)
    if marker in stack:
        raise TypeError(_CYCLIC_MESSAGE)
    for key in value:
        if not isinstance(key, str):
            raise TypeError(_NOT_SAFE_MESSAGE)
    stack.add(marker)
    try:
        keys: list[str] = sorted(cast(str, key) for key in value)
        parts = (f"{_canonical_string(key)}:{_canonical_value(value[key], stack)}" for key in keys)
        return "{" + ",".join(parts) + "}"
    finally:
        stack.discard(marker)


def _canonical_value(value: object, stack: set[int]) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        # bool is an int subclass in Python; this check must precede `int`.
        return "true" if value else "false"
    if isinstance(value, int):
        try:
            value = float(value)
        except OverflowError as exc:
            raise TypeError(_NON_FINITE_MESSAGE) from exc
    if isinstance(value, float):
        return js_number_to_string(value)
    if isinstance(value, str):
        return _canonical_string(value)
    if isinstance(value, list):
        return _canonical_list(cast("list[object]", value), stack)
    if isinstance(value, dict):
        return _canonical_dict(cast("dict[object, object]", value), stack)
    raise TypeError(_NOT_SAFE_MESSAGE)


def canonical_json(value: object) -> str:
    """Port of `canonicalJson` (`packages/store/src/atomic.ts:254-256`).

    Accepts `None`, `bool`, `int` (clamped through `float()` so values above
    2^53 round exactly as float64; an `OverflowError` from that clamp is a
    non-finite rejection), `float`, `str`, `list`, and `dict` with `str` keys.
    Anything else — `tuple`, `set`, `bytes`, a dataclass instance, a non-`str`
    key — raises `TypeError("only plain objects are JSON-safe")`. No whitespace;
    `,`/`:` separators; keys sorted by Unicode code point (`sorted()` on `str`
    is code-point order). A cyclic object graph raises
    `TypeError("cyclic values are not JSON-safe")`.
    """
    return _canonical_value(value, set())


def compare_code_points(a: str, b: str) -> int:
    """-1/0/1 comparison of two strings by Unicode code point.

    Python's `str` ordering is already code-point order (unlike JavaScript's
    default `<`, which compares UTF-16 code units and sorts astral characters
    below the BMP), so this is a thin convenience wrapper, not a reimplementation.
    """
    if a < b:
        return -1
    if a > b:
        return 1
    return 0


def sha256_hex(text: str) -> str:
    """Lowercase hex SHA-256 over the UTF-8 encoding of `text`."""
    return sha256_hex_bytes(text.encode("utf-8"))


def sha256_hex_bytes(data: bytes) -> str:
    """Lowercase hex SHA-256 over `data`."""
    return hashlib.sha256(data).hexdigest()


def canonical_digest(value: object) -> str:
    """`sha256_hex(canonical_json(value))`."""
    return sha256_hex(canonical_json(value))
