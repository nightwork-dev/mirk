"""The ECMAScript-to-Python regex translation, against Node's own answers.

JSON Schema says a `pattern` is an ECMAScript regular expression, so the
question every row asks is: does the translated Python pattern accept exactly
what `new RegExp(p, "u").test(s)` accepts?

**The expected column is not authored.** It was produced by running each
(pattern, sample) pair through Node and pasting the result, which is why rows
that look wrong to a Python reader — `^\\w+$` rejecting `"é"`, `\\d` rejecting
`"٣"`, `\\bfoo\\b` matching inside `"éfoo"`, `\\s` matching U+FEFF, `$` rejecting
a trailing newline — are the ones that carry the contract. Regenerate the
column the same way after changing the table:

    node -e 'for (const s of ["e_1", "\u00e9"]) \
      console.log(s, new RegExp("^\\\\w+$", "u").test(s))'

Paste what it prints. A row edited to make a test pass, rather than to match what
Node answers, removes a divergence from the record instead of fixing it.
"""

from __future__ import annotations

import pytest

from mirk.fixtures.ecma_regex import (
    UnportablePatternError,
    compile_ecma,
    translate,
)

# (pattern, [(sample, what ECMAScript with the `u` flag answers)])
ECMASCRIPT_TABLE: list[tuple[str, list[tuple[str, bool]]]] = [
    (
        "^\\w+$",
        [
            ("e_1", True),
            ("\xe9", False),
            ("abc", True),
            ("a b", False),
            ("\u0663", False),
            ("abc\n", False),
            ("", False),
        ],
    ),
    (
        "\\w",
        [
            ("_", True),
            ("\xe9", False),
            ("\uff46", False),
        ],
    ),
    (
        "\\W",
        [
            ("!", True),
            ("a", False),
            ("\xe9", True),
        ],
    ),
    (
        "\\d",
        [
            ("1", True),
            ("\u0663", False),
            ("a", False),
            ("\uff11", False),
        ],
    ),
    (
        "\\D",
        [
            ("a", True),
            ("1", False),
            ("\u0663", True),
        ],
    ),
    (
        "^\\d+$",
        [
            ("12", True),
            ("\u0663\u0664", False),
            ("1\u0663", False),
        ],
    ),
    (
        "\\bfoo\\b",
        [
            ("foo", True),
            ("\xe9foo", True),
            ("afoo", False),
            ("foo bar", True),
            ("_foo", False),
            ("foo_", False),
        ],
    ),
    (
        "\\Bfoo",
        [
            ("afoo", True),
            ("foo", False),
            (" foo", False),
            ("\xe9foo", False),
        ],
    ),
    (
        "\\s",
        [
            (" ", True),
            ("\xa0", True),
            ("\u2003", True),
            ("a", False),
            ("\t", True),
            ("\u180e", False),
            ("\ufeff", True),
            ("\u2028", True),
        ],
    ),
    (
        "\\S",
        [
            (" ", False),
            ("a", True),
            ("\xa0", False),
            ("\ufeff", False),
        ],
    ),
    (
        "^a.c$",
        [
            ("abc", True),
            ("a\nc", False),
            ("a\xe9c", True),
            ("a\rc", False),
            ("a\u2028c", False),
            ("a c", True),
        ],
    ),
    (
        "^[a-z]+$",
        [
            ("abc", True),
            ("\xe9", False),
            ("abc\n", False),
            ("ABC", False),
        ],
    ),
    (
        "^[\\w-]+$",
        [
            ("a-b", True),
            ("\xe9", False),
            ("a_1-b", True),
        ],
    ),
    (
        "^\\w[\\d]$",
        [
            ("a1", True),
            ("\xe91", False),
            ("a\u0663", False),
        ],
    ),
    (
        "^\\S+@\\S+$",
        [
            ("a@b", True),
            ("a b@c", False),
            ("\xe9@b", True),
        ],
    ),
    (
        "colou?r",
        [
            ("color", True),
            ("colour", True),
            ("colr", False),
        ],
    ),
    (
        "^(?:ab)+$",
        [
            ("abab", True),
            ("aba", False),
            ("ab", True),
        ],
    ),
    (
        "^[^\\d]+$",
        [
            ("abc", True),
            ("a1", False),
            ("\u0663", True),
        ],
    ),
    (
        "^\\$\\d+\\.\\d\\d$",
        [
            ("$1.50", True),
            ("$1.5", False),
            ("$\u0663.50", False),
        ],
    ),
    (
        "^[A-Za-z0-9_]+$",
        [
            ("e_1", True),
            ("\xe9", False),
        ],
    ),
]


@pytest.mark.parametrize(
    ("pattern", "sample", "expected"),
    [
        pytest.param(pattern, sample, expected, id=f"{pattern}::{sample!r}")
        for pattern, samples in ECMASCRIPT_TABLE
        for sample, expected in samples
    ],
)
def test_translated_pattern_agrees_with_ecmascript(
    pattern: str, sample: str, expected: bool
) -> None:
    assert bool(compile_ecma(pattern).search(sample)) is expected


def test_the_table_covers_every_translated_construct() -> None:
    """A row silently dropped from the table would retire a divergence."""
    patterns = " ".join(pattern for pattern, _ in ECMASCRIPT_TABLE)
    for construct in ("\\w", "\\W", "\\d", "\\D", "\\b", "\\B", "\\s", "\\S", "$", "."):
        assert construct in patterns, construct
    assert len(ECMASCRIPT_TABLE) >= 12


def test_anchors_become_input_anchors_not_line_anchors() -> None:
    assert translate("^a$") == "\\Aa\\Z"


def test_the_empty_character_class_keeps_its_ecmascript_meaning() -> None:
    """`[]` matches nothing and `[^]` matches anything, which Python cannot
    spell with brackets at all."""
    assert compile_ecma("a[]b").search("ab") is None
    assert compile_ecma("^a[^]b$").search("a\nb") is not None


@pytest.mark.parametrize(
    ("pattern", "named"),
    [
        (r"\p{L}+", "Unicode property escape"),
        (r"\P{L}+", "Unicode property escape"),
        (r"\k<name>", "named backreference"),
        (r"\cJ", "control escape"),
        (r"\u{1F600}", "code point escape"),
        (r"[\W]", "character class"),
        (r"[\D]", "character class"),
        (r"[\S]", "character class"),
        (r"(?<year>\d{4})", "named group"),
        ("[abc", "unterminated character class"),
        ("\\", "trailing backslash"),
    ],
)
def test_an_unportable_construct_is_named_rather_than_mistranslated(
    pattern: str, named: str
) -> None:
    """Silently mistranslating one of these would put the divergence back,
    invisibly, so the translation refuses and says which construct it was."""
    with pytest.raises(UnportablePatternError) as info:
        translate(pattern)
    assert named in str(info.value)
