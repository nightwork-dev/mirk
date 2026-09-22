"""Translate a JSON Schema `pattern` from ECMAScript to Python's `re`.

JSON Schema says a `pattern` is an ECMAScript regular expression. Ajv compiles
one with the `u` flag; Python's `re` compiles a Unicode-by-default dialect that
disagrees with it on five points, every one of which is silent — the pattern
compiles on both sides and simply accepts a different set of strings:

===========  ============================  ==============================
construct    ECMAScript with `u`           Python `re` on `str`
===========  ============================  ==============================
`\\w` `\\W`    ASCII letters, digits, `_`    every Unicode word character
`\\d` `\\D`    `0-9`                         every Unicode decimal digit
`\\b` `\\B`    boundary of the ASCII set     boundary of the Unicode set
`\\s` `\\S`    includes U+FEFF               excludes U+FEFF
`^` `$`       start and end of input        `$` also matches before a
                                           trailing newline
`.`          not `\\n \\r` U+2028 U+2029     only not `\\n`
===========  ============================  ==============================

So `^\\w+$` rejects `"é"` in Ajv and accepts it in Python; `\\d` rejects the
Arabic-Indic digit `"٣"` in Ajv and accepts it in Python; `\\bfoo\\b` matches
inside `"éfoo"` in Ajv and does not in Python.

`translate` rewrites each of those constructs into an explicit form that means
in Python what it means in ECMAScript, and raises `UnportablePatternError`
naming any construct it cannot express. It handles the dialect, not the whole
grammar: what it does not rewrite it passes through, and an expression Python
cannot parse fails at `re.compile` as it always did.

This is the REFERENCE engine, the one the corpus and the tests inject. A caller
who injects their own engine owns regex dialect parity themselves.
"""

from __future__ import annotations

import re
from typing import Final

__all__ = ["UnportablePatternError", "compile_ecma", "translate"]


class UnportablePatternError(ValueError):
    """A pattern uses an ECMAScript construct with no Python equivalent."""


#: The ASCII word set `\w` means under the `u` flag.
_WORD: Final = "A-Za-z0-9_"

#: `WhiteSpace` + `LineTerminator` from the ECMAScript grammar. U+FEFF is the
#: one Python omits; U+180E is the one Python and modern ECMAScript both omit.
_SPACE: Final = (
    " \\t\\n\\r\\v\\f\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
)

#: `.` under `u` excludes exactly the four LineTerminator code points.
_DOT: Final = "[^\\n\\r\\u2028\\u2029]"

_WORD_AHEAD: Final = f"(?=[{_WORD}])"
_WORD_BEHIND: Final = f"(?<=[{_WORD}])"
_NOT_WORD_AHEAD: Final = f"(?![{_WORD}])"
_NOT_WORD_BEHIND: Final = f"(?<![{_WORD}])"

#: An ASCII word boundary written out of lookaround, because Python's `\b` reads
#: the Unicode word set and `re.ASCII` would also narrow `\s` and every other
#: shorthand in the pattern.
_BOUNDARY: Final = f"(?:{_WORD_BEHIND}{_NOT_WORD_AHEAD}|{_NOT_WORD_BEHIND}{_WORD_AHEAD})"
_NON_BOUNDARY: Final = f"(?:{_WORD_BEHIND}{_WORD_AHEAD}|{_NOT_WORD_BEHIND}{_NOT_WORD_AHEAD})"

#: Outside a character class, one shorthand maps to one bracketed set.
_OUTSIDE_CLASS: Final = {
    "w": f"[{_WORD}]",
    "W": f"[^{_WORD}]",
    "d": "[0-9]",
    "D": "[^0-9]",
    "s": f"[{_SPACE}]",
    "S": f"[^{_SPACE}]",
    "b": _BOUNDARY,
    "B": _NON_BOUNDARY,
}

#: Inside a character class the same shorthands are set FRAGMENTS. A negated
#: shorthand has no fragment form — `[\W]` is "not an ASCII word character"
#: unioned with whatever else the class holds, which brackets cannot say — so
#: those are refused rather than approximated.
_INSIDE_CLASS: Final = {"w": _WORD, "d": "0-9", "s": _SPACE}

_UNPORTABLE: Final = {
    "p": "the Unicode property escape \\p{...}",
    "P": "the Unicode property escape \\P{...}",
    "k": "the named backreference \\k<name>",
    "c": "the control escape \\cX",
}


def translate(pattern: str) -> str:
    """The Python pattern that accepts exactly what `pattern` accepts in
    ECMAScript under the `u` flag.

    Raises `UnportablePatternError` naming the construct when the pattern uses
    one this translation cannot express.
    """
    out: list[str] = []
    index = 0
    length = len(pattern)
    in_class = False
    while index < length:
        char = pattern[index]
        if char == "\\":
            if index + 1 >= length:
                raise UnportablePatternError(f"pattern {pattern!r} ends with a trailing backslash.")
            escape = pattern[index + 1]
            index += 2
            if escape in _UNPORTABLE:
                raise UnportablePatternError(
                    f"pattern {pattern!r} uses {_UNPORTABLE[escape]}, "
                    "which has no Python equivalent."
                )
            if escape == "u" and index < length and pattern[index] == "{":
                raise UnportablePatternError(
                    f"pattern {pattern!r} uses the code point escape \\u{{...}}, "
                    "which has no Python equivalent."
                )
            if in_class:
                if escape in _INSIDE_CLASS:
                    out.append(_INSIDE_CLASS[escape])
                elif escape in ("W", "D", "S"):
                    raise UnportablePatternError(
                        f"pattern {pattern!r} uses \\{escape} inside a character class, "
                        "which cannot be written as an ASCII set fragment."
                    )
                else:
                    out.append("\\" + escape)
            elif escape in _OUTSIDE_CLASS:
                out.append(_OUTSIDE_CLASS[escape])
            else:
                out.append("\\" + escape)
            continue

        index += 1
        if in_class:
            out.append(char)
            if char == "]":
                in_class = False
            continue

        if (
            char == "("
            and pattern.startswith("?<", index)
            and not pattern.startswith(("?<=", "?<!"), index)
        ):
            raise UnportablePatternError(
                f"pattern {pattern!r} uses the named group (?<name>...), "
                "which Python spells (?P<name>...)."
            )

        if char == "[":
            # ECMAScript allows the empty class, which Python cannot spell:
            # `[]` matches nothing and `[^]` matches anything including a line
            # terminator.
            if pattern.startswith("]", index):
                out.append("(?!)")
                index += 1
                continue
            if pattern.startswith("^]", index):
                out.append("(?s:.)")
                index += 2
                continue
            in_class = True
            out.append(char)
            if index < length and pattern[index] == "^":
                out.append("^")
                index += 1
            continue
        if char == "^":
            # No `m` flag, so `^` is the start of the input and nothing else.
            out.append("\\A")
            continue
        if char == "$":
            # `\Z` is Python's end of input. A bare `$` would also match before
            # a trailing newline, so `^\w+$` would accept `"abc\n"` here and
            # reject it in Ajv.
            out.append("\\Z")
            continue
        if char == ".":
            out.append(_DOT)
            continue
        out.append(char)

    if in_class:
        raise UnportablePatternError(f"pattern {pattern!r} has an unterminated character class.")
    return "".join(out)


def compile_ecma(pattern: str) -> re.Pattern[str]:
    """`translate`, compiled. `re.search` on the result is ECMAScript `test`."""
    return re.compile(translate(pattern))
