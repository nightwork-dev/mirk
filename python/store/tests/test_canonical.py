"""Byte-identity proof for `mirk.store.canonical` against the probed TypeScript digest.

Every case here is quoted from `docs/python-port/digests/artifact.md` sections 2 and
13, marked **PROBED** there (executed against the real `@mirk/store` code, not
inferred). A mismatch in either the canonical text or its sha256 means this port
diverges from `@mirk/store/atomic`'s `canonicalJson`, which is a portability bug,
not a test to adjust.
"""

from __future__ import annotations

import hashlib
import math

import pytest

from mirk.store.canonical import (
    canonical_digest,
    canonical_json,
    compare_code_points,
    js_number_to_string,
    sha256_hex,
    sha256_hex_bytes,
)
from mirk.store.conformance.runner import expand_hash_wrappers

# ── §13.3 the twelve discriminating cases (+ three more, + anchors) ─────────


def _check(value: object, expected_text: str, expected_sha256: str) -> None:
    text = canonical_json(value)
    assert text == expected_text
    assert sha256_hex(text) == expected_sha256
    assert canonical_digest(value) == expected_sha256


def test_case_1_astral_key_order() -> None:
    value = {"\U0001f600": 1, "�": 2, "a": 3, "A": 4, "ä": 5}
    _check(
        value,
        '{"A":4,"a":3,"ä":5,"�":2,"\U0001f600":1}',
        "b43f65e9bee3e7086d257a2e046302e7008f9750eb067cdb13564c7315f934d6",
    )


def test_case_2_numeric_looking_keys() -> None:
    value = {"b": 1, "a": 2, "10": 3, "2": 4}
    _check(
        value,
        '{"10":3,"2":4,"a":2,"b":1}',
        "61148428c19ea27217951d647538266ed8df349d71b8982b3e3e37dfeb0b9643",
    )


def test_case_3_negative_zero() -> None:
    _check(-0.0, "0", "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9")


def test_case_4_large_exponent() -> None:
    _check(1e21, "1e+21", "241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c")


def test_case_5_small_exponent() -> None:
    _check(1e-7, "1e-7", "5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22")


def test_case_6_two_pow_53_plus_1() -> None:
    _check(
        float(9007199254740993),
        "9007199254740992",
        "c681da39d7273a6a24c15c9cac3a75526ff2ecf8ba4ee60346a0c70c8163bdb2",
    )


def test_case_7_integral_float() -> None:
    _check(100.0, "100", "ad57366865126e55649ecb23ae1d48887544976efea46a48eb5d85a6eeb4d306")


def test_case_8_subnormal() -> None:
    _check(5e-324, "5e-324", "c46e7ca1be4c8734f373a56530787288fa2058d73d07855e9247e949f811a42a")


def test_case_9_empty_containers() -> None:
    value: dict[str, object] = {"a": {}, "b": []}
    text = canonical_json(value)
    assert text == '{"a":{},"b":[]}'
    assert canonical_digest(value) == sha256_hex(text)


def test_case_10_nested_nulls() -> None:
    value = {"a": [None, {"b": None}], "c": None}
    _check(
        value,
        '{"a":[null,{"b":null}],"c":null}',
        "2a7f1a3c029c0e48f68eaeb0215f2f862a39cafd9d9ed84fc7b6a7d1d3a384ce",
    )


def test_case_11_surrogate_pair_is_raw_utf8() -> None:
    _check(
        "\U0001f600",
        '"\U0001f600"',
        "7a0c50b92434b015545fe93ab723db2d4b2cdd14a441405624a9ce8be29f1d5a",
    )


def test_case_12_lone_surrogate() -> None:
    value = "".join(chr(point) for point in [55296])
    text = canonical_json(value)
    assert text == '"\\ud800"'
    assert len(text) == 8
    assert sha256_hex(text) == "8c0c59dd0d275aadcd462a5fe12eb352cbdfeaf961eae4f85a4660521df7d2f5"
    # The trap the digest names: the raw code point cannot round-trip through
    # UTF-8, so the escaped canonical text must be what actually gets hashed.
    with pytest.raises(UnicodeEncodeError):
        value.encode("utf-8")


def test_case_13_c0_controls() -> None:
    value = "".join(chr(point) for point in (0x0000, 0x0001, 0x001F))
    _check(
        value,
        '"\\u0000\\u0001\\u001f"',
        "842096a6d3fcd0968fe35809ea5810d33f7072b93743fc0f7b4ff484ae727d20",
    )


def test_case_14_quote_backslash_newline_tab() -> None:
    _check(
        'a"b\\c\nd\te',
        '"a\\"b\\\\c\\nd\\te"',
        "e0127043d1716c8ca6a938b7e89d96244bbca272dba3306802222a2daf1fecb7",
    )


def test_case_15_line_and_paragraph_separators_unescaped() -> None:
    value = "\u2028\u2029"
    _check(value, f'"{value}"', "e3a0e2262ac7790f4df36b522a8fbdd4ee3370d568eb15dc25c5f1775f14ed6c")


# ── cheap sanity anchors ─────────────────────────────────────────────────────


def test_anchor_empty_object() -> None:
    _check({}, "{}", "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")


def test_anchor_empty_array() -> None:
    _check([], "[]", "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945")


def test_anchor_simple_array() -> None:
    _check(
        [True, False, None],
        "[true,false,null]",
        "4d0f18de2133118249c26acc481838d4f6bb6bc1de882d99abbd19ae9397e8df",
    )


def test_anchor_deep_nesting() -> None:
    value = {"a": {"b": {"c": [1, 2, {"d": "e"}]}}}
    _check(
        value,
        '{"a":{"b":{"c":[1,2,{"d":"e"}]}}}',
        "f16ac108f5aa7e1af9d308eb47a1b02f21f2dfa65cc8f9a2af6b54b85d617502",
    )


def test_anchor_unicode_string() -> None:
    _check(
        "café ünï 中文",
        '"café ünï 中文"',
        "45e7e822afdd27e7e40f6b80bb165c0fb7396ec8e72f3bec1b5872c2d9c66aa5",
    )


def test_anchor_del_unescaped() -> None:
    _check("\x7f", '"\x7f"', "6fe76740e12a93d5598fe685cb6ad3d3c94e44609065a56866b69647772026ec")


def test_anchor_simple_float() -> None:
    _check(1.5, "1.5", "9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725")


def test_anchor_large_named_exponent() -> None:
    _check(1e100, "1e+100", "33d5997bb6b66e3ae3b8e79fff5fe0954bc7b2a38a9d95d83f437d0e57b68f82")


# ── §13.4 rejections (the ones that apply to Python) ─────────────────────────


def test_rejects_nan() -> None:
    with pytest.raises(TypeError, match="non-finite numbers are not JSON-safe"):
        canonical_json(float("nan"))


def test_rejects_positive_infinity() -> None:
    with pytest.raises(TypeError, match="non-finite numbers are not JSON-safe"):
        canonical_json(float("inf"))


def test_rejects_negative_infinity() -> None:
    with pytest.raises(TypeError, match="non-finite numbers are not JSON-safe"):
        canonical_json(float("-inf"))


def test_rejects_cyclic_list() -> None:
    cyclic: list[object] = []
    cyclic.append(cyclic)
    with pytest.raises(TypeError, match="cyclic values are not JSON-safe"):
        canonical_json(cyclic)


def test_rejects_cyclic_dict() -> None:
    cyclic: dict[str, object] = {}
    cyclic["self"] = cyclic
    with pytest.raises(TypeError, match="cyclic values are not JSON-safe"):
        canonical_json(cyclic)


def test_rejects_non_plain_values() -> None:
    for value in ((1, 2), {1, 2}, b"bytes", object()):
        with pytest.raises(TypeError, match="only plain objects are JSON-safe"):
            canonical_json(value)


def test_rejects_non_string_dict_keys() -> None:
    with pytest.raises(TypeError, match="only plain objects are JSON-safe"):
        canonical_json({1: "a"})  # type: ignore[dict-item]


def test_a_large_int_clamps_through_float_and_can_overflow() -> None:
    # Within float64 range: clamps and formats like the equivalent float.
    assert canonical_json(9007199254740993) == "9007199254740992"
    # Far beyond float64 range: float() overflows, which is a non-finite rejection.
    with pytest.raises(TypeError, match="non-finite numbers are not JSON-safe"):
        canonical_json(10**400)


def test_bool_is_not_treated_as_int() -> None:
    assert canonical_json(True) == "true"
    assert canonical_json(False) == "false"
    assert canonical_json({"a": True, "b": 1}) == '{"a":true,"b":1}'


# ── js_number_to_string, standalone ──────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (0.0, "0"),
        (-0.0, "0"),
        (100.0, "100"),
        (1.5, "1.5"),
        (1e21, "1e+21"),
        (1e20, "100000000000000000000"),
        (1e-7, "1e-7"),
        (1e-6, "0.000001"),
        (5e-324, "5e-324"),
        (1e100, "1e+100"),
        (float(9007199254740993), "9007199254740992"),
        (0.1 + 0.2, "0.30000000000000004"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (2.5e-8, "2.5e-8"),
        (-1.5, "-1.5"),
        (123456789012345680000.0, "123456789012345680000"),
    ],
)
def test_js_number_to_string_pinned_cases(value: float, expected: str) -> None:
    assert js_number_to_string(value) == expected


def test_js_number_to_string_rejects_non_finite() -> None:
    for value in (float("nan"), float("inf"), float("-inf")):
        with pytest.raises(TypeError, match="non-finite numbers are not JSON-safe"):
            js_number_to_string(value)


# ── sha256_hex / sha256_hex_bytes against hashlib directly ──────────────────


def test_sha256_hex_matches_hashlib_on_a_long_input() -> None:
    text = "mirk-conformance-" * 20  # > 128 bytes
    assert len(text.encode("utf-8")) > 128
    assert sha256_hex(text) == hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_sha256_hex_bytes_matches_hashlib() -> None:
    data = b"\x00\x01\xffmirk" * 50
    assert sha256_hex_bytes(data) == hashlib.sha256(data).hexdigest()


# ── compare_code_points ───────────────────────────────────────────────────


def test_compare_code_points_orders_by_code_point_not_utf16_unit() -> None:
    # U+1F600 (astral) sorts above U+FFFD under code-point order, the opposite
    # of a UTF-16-code-unit sort (whose leading surrogate is below U+FFFD).
    assert compare_code_points("\U0001f600", "�") == 1
    assert compare_code_points("�", "\U0001f600") == -1
    assert compare_code_points("a", "a") == 0
    assert compare_code_points("a", "b") == -1
    assert compare_code_points("10", "2") == -1


# ── the hash port's wrapper expansion, through the runner's public function ─


def test_expand_num_wrapper() -> None:
    assert expand_hash_wrappers({"$num": "-0"}) == 0.0
    assert math.copysign(1.0, expand_hash_wrappers({"$num": "-0"})) == -1.0
    assert math.isnan(expand_hash_wrappers({"$num": "NaN"}))
    assert expand_hash_wrappers({"$num": "Infinity"}) == float("inf")
    assert expand_hash_wrappers({"$num": "-Infinity"}) == float("-inf")
    assert expand_hash_wrappers({"$num": "9007199254740993"}) == 9007199254740992.0


def test_expand_codepoints_wrapper_allows_lone_surrogates() -> None:
    assert expand_hash_wrappers({"$codepoints": [97, 98]}) == "ab"
    assert expand_hash_wrappers({"$codepoints": [55296]}) == "\ud800"


def test_expand_b64_wrapper() -> None:
    assert expand_hash_wrappers({"$b64": "aGVsbG8="}) == b"hello"


def test_expand_utf8_wrapper() -> None:
    assert expand_hash_wrappers({"$utf8": "hello"}) == b"hello"


def test_expand_wrappers_recurses_through_arrays_and_objects() -> None:
    value = {
        "outer": [{"$num": "1.5"}, {"nested": {"$utf8": "hi"}}],
        "plain": "unchanged",
    }
    assert expand_hash_wrappers(value) == {
        "outer": [1.5, {"nested": b"hi"}],
        "plain": "unchanged",
    }


def test_expand_wrappers_leaves_non_wrapper_dicts_alone() -> None:
    # A dict with more than one key, even if one is a wrapper name, is data.
    value = {"$num": "1", "extra": True}
    assert expand_hash_wrappers(value) == {"$num": "1", "extra": True}
