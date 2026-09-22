"""Fixture refs: `type:id`, split at the first colon.

The whitespace class is written out rather than reused from `\\s`. JavaScript's
`\\s` and Python's differ at both ends (`\\x1c`-`\\x1f` and U+0085 are whitespace
to Python and not to JavaScript), and the id rule is what makes bare-string
reference detection safe, so the two languages must reject exactly the same
strings.
"""

from __future__ import annotations

import re
from typing import Any, NamedTuple, cast

from .errors import FixtureError

__all__ = [
    "ParsedRef",
    "format_ref",
    "is_canonical_ref",
    "is_explicit_ref",
    "parse_ref",
    "ref_string",
]

# ECMAScript `\s`: WhiteSpace + LineTerminator.
_JS_WS = "\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

# `\Z`, not `$`: Python's `$` also matches before a trailing newline, so `$`
# would accept "ab\n:x" where JavaScript rejects it.
_TYPE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*\Z")
_ID_RE = re.compile(f"^[^:{_JS_WS}][^:{_JS_WS}]*\\Z")


class ParsedRef(NamedTuple):
    type: str
    id: str


def parse_ref(ref: str) -> ParsedRef:
    """Split `type:id`, rejecting a second colon anywhere in the string."""
    idx = ref.find(":")
    if idx <= 0 or idx == len(ref) - 1 or ref.find(":", idx + 1) != -1:
        raise _invalid_ref(ref)

    type_name = ref[:idx]
    identifier = ref[idx + 1 :]
    if not _TYPE_RE.match(type_name) or not _ID_RE.match(identifier):
        raise _invalid_ref(ref)
    return ParsedRef(type_name, identifier)


def format_ref(type_name: str, identifier: str) -> str:
    return f"{type_name}:{identifier}"


def is_canonical_ref(value: str) -> bool:
    try:
        parse_ref(value)
    except FixtureError:
        return False
    return True


def is_explicit_ref(value: Any) -> bool:
    """True for a non-list object carrying a **string** `$ref`."""
    if not isinstance(value, dict):
        return False
    return isinstance(cast(Any, value).get("$ref"), str)


def ref_string(value: Any) -> str:
    if isinstance(value, str):
        return value
    return str(value["$ref"])


def _invalid_ref(ref: str) -> FixtureError:
    return FixtureError(
        {
            "severity": "error",
            "code": "invalid-ref",
            "message": f'Invalid fixture ref "{ref}". Expected "type:id".',
            "fixture": ref,
        }
    )
