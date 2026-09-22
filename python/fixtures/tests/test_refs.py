"""Ref grammar. The whitespace rule is what makes bare-ref detection safe."""

from __future__ import annotations

import pytest

from mirk.fixtures import FixtureError, format_ref, is_canonical_ref, is_explicit_ref, parse_ref


@pytest.mark.parametrize(
    ("ref", "expected"),
    [
        ("theme:dark", ("theme", "dark")),
        ("a:b", ("a", "b")),
        ("T-9_x:id.with.dots", ("T-9_x", "id.with.dots")),
        ("theme:a/b", ("theme", "a/b")),
    ],
)
def test_a_well_formed_ref_splits_at_the_first_colon(ref: str, expected: tuple[str, str]) -> None:
    assert tuple(parse_ref(ref)) == expected


@pytest.mark.parametrize(
    "ref",
    [
        "",
        "theme",
        ":x",
        "x:",
        "a:b:c",
        "1theme:x",
        "-theme:x",
        "the me:x",
        "theme:a b",
        "theme:a\tb",
        "theme:a\u00a0b",
        "theme:a\u3000b",
        "theme:a\u2028b",
        "theme:a\ufeffb",
        "theme: b",
        "Use theme:missing in prose only.",
    ],
)
def test_a_malformed_ref_is_rejected(ref: str) -> None:
    with pytest.raises(FixtureError) as info:
        parse_ref(ref)
    assert str(info.value) == f'Invalid fixture ref "{ref}". Expected "type:id".'
    assert info.value.diagnostic["code"] == "invalid-ref"
    assert not is_canonical_ref(ref)


@pytest.mark.parametrize("codepoint", ["\u0085", "\u001c", "\u001f"])
def test_characters_python_calls_whitespace_and_javascript_does_not_stay_legal(
    codepoint: str,
) -> None:
    """Verified against the real JavaScript regex: `/[^:\\s]/` accepts U+0085,
    U+001C and U+001F. Reusing Python's `\\s` would reject three ids the
    TypeScript loader accepts, so the character class is written out."""
    ref = f"theme:a{codepoint}b"
    assert is_canonical_ref(ref)
    assert parse_ref(ref).id == f"a{codepoint}b"


@pytest.mark.parametrize("ref", ["theme\n:x", "theme:x\n"])
def test_a_trailing_newline_is_rejected_like_javascript(ref: str) -> None:
    """Python's `$` also matches before a final newline, so the patterns anchor
    with `\\Z`. Verified against the real JavaScript regexes, which reject both."""
    assert not is_canonical_ref(ref)


def test_format_ref_is_concatenation() -> None:
    assert format_ref("theme", "dark") == "theme:dark"


def test_an_explicit_ref_needs_a_string_dollar_ref() -> None:
    assert is_explicit_ref({"$ref": "theme:dark"})
    assert not is_explicit_ref({"$ref": 42})
    assert not is_explicit_ref([{"$ref": "theme:dark"}])
    assert not is_explicit_ref("theme:dark")
    assert not is_explicit_ref(None)
