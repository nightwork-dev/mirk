"""The loader pipeline: matching, map expansion, layering, references, caches.

Every expectation here was cross-checked against the TypeScript package running
on the same inputs, not read off the source.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from helpers import loader, memory, passthrough, registry
from mirk.fixtures import FixtureError, FixtureLoader, FixtureValidationError
from mirk.fixtures.types import FixtureSource, FixtureSourceEntry, LayeredSource

THEME: dict[str, Any] = {"type": "theme", "directory": "themes", "schema": passthrough}


def theme(**overrides: Any) -> dict[str, Any]:
    return {**THEME, **overrides}


# ── Entry matching ───────────────────────────────────────────────────────


def test_a_nested_path_is_ignored_rather_than_recursed_into() -> None:
    source = memory("s", {"themes/a.json": "{}", "themes/nested/b.json": "{}"})
    assert loader(registry(theme()), [source]).list() == ["theme:a"]


def test_an_empty_directory_matches_the_source_root() -> None:
    source = memory("s", {"a.json": "{}", "n/b.json": "{}"})
    for directory in ("", "/"):
        assert loader(registry(theme(directory=directory)), [source]).list() == ["theme:a"]


def test_a_bare_extension_with_no_stem_is_not_a_fixture() -> None:
    source = memory("s", {"themes/.json": "{}", "themes/a.json": "{}"})
    assert loader(registry(theme()), [source]).list() == ["theme:a"]


def test_extension_order_decides_the_parsed_id() -> None:
    """`endswith`, first match wins. Confirmed against TypeScript: the same
    file is `t:a.min` under one order and `u:a` under the other."""
    source = memory("s", {"themes/a.min.json": "{}"})
    parsers = {".min.json": json.loads}
    forward = registry(theme(type="t", extensions=[".json", ".min.json"]))
    reverse = registry(theme(type="u", extensions=[".min.json", ".json"]))
    assert loader(forward, [source], parsers=parsers).list() == ["t:a.min"]
    assert loader(reverse, [source], parsers=parsers).list() == ["u:a"]


def test_the_document_cache_is_keyed_without_the_extension() -> None:
    """A quirk carried over deliberately: the parsed-document cache key is
    source, locator and path, so a second type matching the same file with an
    extension that has no parser reads the cached document instead of failing.
    Confirmed against TypeScript, which lists both refs here."""
    source = memory("s", {"themes/a.min.json": "{}"})
    both = registry(
        theme(type="t", extensions=[".json", ".min.json"]),
        theme(type="u", extensions=[".min.json", ".json"]),
    )
    assert loader(both, [source]).list() == ["t:a.min", "u:a"]


def test_two_files_resolving_to_one_id_in_one_layer_collide() -> None:
    source = memory("s", {"themes/a.json": "{}", "themes/a.txt": "{}"})
    fixtures = loader(
        registry(theme(extensions=[".json", ".txt"])), [source], parsers={".txt": json.loads}
    )
    with pytest.raises(FixtureError) as info:
        fixtures.list()
    assert str(info.value) == 'Fixture "theme:a" appears more than once in the same source layer.'
    assert info.value.diagnostic["code"] == "duplicate-map-fixture"


def test_the_same_id_in_two_sources_is_layering_not_a_collision() -> None:
    low = memory("low", {"themes/a.json": '{"v":1}'})
    high = memory("high", {"themes/a.json": '{"v":2}'})
    assert loader(registry(theme()), [low, high]).load("theme:a") == {"v": 2}


# ── Layering and patches ─────────────────────────────────────────────────


def test_a_patch_deep_merges_into_a_lower_base() -> None:
    base = memory("base", {"themes/dark.json": '{"name":"Dark","palette":{"bg":"#000"}}'})
    patch = memory("over", {"themes/dark.json": '{"$patch":"theme:dark","palette":{"fg":"#fff"}}'})
    fixtures = loader(registry(theme(mergeStrategy="deep")), [base, patch])
    assert fixtures.load("theme:dark") == {"name": "Dark", "palette": {"bg": "#000", "fg": "#fff"}}
    kinds = [layer["kind"] for layer in fixtures.loadRaw("theme:dark")["provenance"]["layers"]]
    assert kinds == ["base", "patch"]


def test_a_shadowed_patch_still_has_its_ref_checked() -> None:
    """The mismatch fires even though this patch would never apply."""
    stray = memory("low", {"themes/dark.json": '{"$patch":"theme:other"}'})
    base = memory("high", {"themes/dark.json": '{"name":"Dark"}'})
    with pytest.raises(FixtureError) as info:
        loader(registry(theme()), [stray, base]).load("theme:dark")
    assert (
        str(info.value)
        == 'Patch declares "$patch: theme:other" but is being applied to "theme:dark".'
    )
    assert info.value.diagnostic["code"] == "patch-ref-mismatch"


def test_a_patch_at_or_below_the_base_priority_does_not_apply() -> None:
    low = memory("low", {"themes/a.json": '{"v":1}'})
    high = memory("high", {"themes/a.json": '{"v":3}'})
    same = memory("same", {"themes/a.json": '{"$patch":"theme:a","v":2}'})
    fixtures = loader(
        registry(theme(mergeStrategy="deep")),
        [
            LayeredSource(low, "low", 0),
            LayeredSource(high, "high", 5),
            LayeredSource(same, "same", 5),
        ],
    )
    assert fixtures.load("theme:a") == {"v": 3}
    layers = fixtures.loadRaw("theme:a")["provenance"]["layers"]
    assert [layer["kind"] for layer in layers] == ["replace", "base", "shadowed"]


def test_patches_with_no_base_are_rejected() -> None:
    only = memory("s", {"themes/a.json": '{"$patch":"theme:a","v":1}'})
    with pytest.raises(FixtureError) as info:
        loader(registry(theme()), [only]).load("theme:a")
    assert str(info.value) == 'Fixture "theme:a" has patches but no base document.'
    assert info.value.diagnostic["code"] == "patch-without-base"


def test_a_shadowed_base_is_never_validated() -> None:
    """A lower-priority document may be arbitrarily malformed and load cleanly."""
    definition = theme(jsonSchema={"type": "object", "required": ["name"]}, schema=None)
    definition.pop("schema")
    low = memory("low", {"themes/a.json": "[]"})
    high = memory("high", {"themes/a.json": '{"name":"ok"}'})
    assert loader(registry(definition), [low, high]).load("theme:a") == {"name": "ok"}


def test_a_missing_fixture_reports_where_it_looked() -> None:
    with pytest.raises(FixtureError) as info:
        loader(registry(theme()), [memory("s", {})]).loadRaw("theme:zz")
    assert str(info.value) == 'Fixture "theme:zz" not found in any registered source.'
    assert info.value.diagnostic.get("hint") == 'Looked under "themes/zz" with extensions .json.'


def test_an_unregistered_type_is_a_load_error() -> None:
    with pytest.raises(FixtureError) as info:
        loader(registry(theme()), [memory("s", {})]).load("other:x")
    assert str(info.value) == 'Unknown fixture type "other".'


# ── Keyed map documents ──────────────────────────────────────────────────

MAP = theme(document={"kind": "map", "idField": "id"}, mergeStrategy="deep")


def test_one_map_document_yields_one_fixture_per_key() -> None:
    source = memory(
        "s", {"themes/core.json": '{"dark":{"name":"Dark"},"light":{"id":"light","name":"L"}}'}
    )
    fixtures = loader(registry(MAP), [source])
    assert fixtures.list() == ["theme:dark", "theme:light"]
    assert fixtures.load("theme:dark") == {"id": "dark", "name": "Dark"}
    assert fixtures.load("theme:light") == {"id": "light", "name": "L"}


def test_the_injected_id_lands_first_in_key_order() -> None:
    source = memory("s", {"themes/core.json": '{"dark":{"name":"Dark"}}'})
    value: Any = loader(registry(MAP), [source]).load("theme:dark")
    assert list(value) == ["id", "name"]


def test_a_map_entry_provenance_path_carries_the_key() -> None:
    base = memory("base", {"themes/core.json": '{"dark":{"name":"Dark"}}'})
    over = memory("over", {"themes/overrides.json": '{"dark":{"$patch":"theme:dark","name":"D2"}}'})
    fixtures = loader(registry(MAP), [base, over])
    layers = fixtures.loadRaw("theme:dark")["provenance"]["layers"]
    assert [layer["path"] for layer in layers] == [
        "themes/core.json#dark",
        "themes/overrides.json#dark",
    ]
    assert fixtures.load("theme:dark") == {"id": "dark", "name": "D2"}


def test_a_patch_map_entry_never_gains_an_injected_id() -> None:
    base = memory("base", {"themes/core.json": '{"dark":{"name":"Dark"}}'})
    over = memory("over", {"themes/p.json": '{"dark":{"$patch":"theme:dark","extra":1}}'})
    value: Any = loader(registry(MAP), [base, over]).load("theme:dark")
    assert value == {"id": "dark", "name": "Dark", "extra": 1}


@pytest.mark.parametrize("file_name", ["core.json", "patch.json"])
def test_a_map_key_disagreeing_with_an_explicit_id_is_rejected(file_name: str) -> None:
    body = '{"dark":{"id":"other"}}'
    if file_name == "patch.json":
        body = '{"dark":{"$patch":"theme:dark","id":"other"}}'
    source = memory("s", {f"themes/{file_name}": body})
    with pytest.raises(FixtureError) as info:
        loader(registry(MAP), [source]).list()
    assert str(info.value) == 'Map key "dark" does not match explicit id "other".'
    assert info.value.diagnostic.get("path") == f"themes/{file_name}#dark"


def test_a_map_entry_that_is_not_an_object_cannot_take_an_injected_id() -> None:
    source = memory("s", {"themes/core.json": '{"dark":42}'})
    with pytest.raises(FixtureError) as info:
        loader(registry(MAP), [source]).list()
    assert str(info.value) == 'Fixture "theme:dark" must be an object to inject "id".'


def test_a_map_document_that_is_not_an_object_is_rejected() -> None:
    for body in ("[]", "null", '"x"'):
        source = memory("s", {"themes/core.json": body})
        with pytest.raises(FixtureError) as info:
            loader(registry(MAP), [source]).list()
        assert str(info.value) == (
            "Fixture map documents must parse to an object keyed by fixture id."
        )


def test_a_map_without_an_id_field_accepts_any_json_value() -> None:
    source = memory("s", {"themes/core.json": '{"a":1,"b":[2],"c":null}'})
    fixtures = loader(registry(theme(document={"kind": "map"})), [source])
    assert fixtures.list() == ["theme:a", "theme:b", "theme:c"]
    assert fixtures.load("theme:b") == [2]


def test_map_entries_expand_in_javascript_key_order() -> None:
    """Two bad entries, and the one JavaScript reaches first must be the one
    reported. Confirmed against TypeScript: `"2"` before `"10"`."""
    source = memory("s", {"themes/x.json": '{"10":{"id":"W10"},"2":{"id":"W2"},"b":{"id":"WB"}}'})
    with pytest.raises(FixtureError) as info:
        loader(registry(MAP), [source]).list()
    assert str(info.value) == 'Map key "2" does not match explicit id "W2".'


# ── Parsers ──────────────────────────────────────────────────────────────


def test_a_malformed_document_reports_a_parse_error() -> None:
    source = memory("s", {"themes/a.json": "{not json"})
    with pytest.raises(FixtureError) as info:
        loader(registry(theme()), [source]).load("theme:a")
    assert str(info.value).startswith("Parse error: ")
    assert info.value.diagnostic["code"] == "parse-failed"


@pytest.mark.parametrize("literal", ["NaN", "Infinity", "-Infinity"])
def test_the_javascript_non_constants_are_a_parse_failure(literal: str) -> None:
    """CPython reads these three bare literals as floats; `JSON.parse` rejects
    them. Accepting them would let one file mean different things per port."""
    source = memory("s", {"themes/a.json": '{"v": ' + literal + "}"})
    with pytest.raises(FixtureError) as info:
        loader(registry(theme()), [source]).load("theme:a")
    assert info.value.diagnostic["code"] == "parse-failed"


def test_an_integer_beyond_float64_is_read_at_its_nearest_double() -> None:
    """JavaScript has only float64, so `JSON.parse` cannot hold 2^53 + 1."""
    source = memory("s", {"themes/a.json": '{"v": 9007199254740993}'})
    assert loader(registry(theme()), [source]).load("theme:a") == {"v": 9007199254740992}


def test_a_matched_extension_with_no_parser_is_rejected_on_load() -> None:
    source = memory("s", {"themes/a.yaml": "x"})
    with pytest.raises(FixtureError) as info:
        loader(registry(theme(extensions=[".yaml"])), [source]).load("theme:a")
    assert str(info.value) == 'No parser registered for ".yaml".'
    assert (
        info.value.diagnostic.get("hint") == 'Pass a parser for ".yaml" to createFixtureLoader().'
    )


def test_a_type_without_extensions_falls_back_to_every_registered_parser() -> None:
    source = memory("s", {"themes/a.yaml": '{"v":1}'})
    fixtures = loader(registry(theme()), [source], parsers={".yaml": json.loads})
    assert fixtures.list() == ["theme:a"]


def test_validate_reports_one_no_parser_diagnostic_for_a_direct_child_only() -> None:
    source = memory("s", {"themes/a.yaml": "x", "themes/nested/b.yaml": "x", "other/c.yaml": "x"})
    report = loader(registry(theme()), [source]).validate()
    assert not report["ok"]
    assert [(d["code"], d.get("path")) for d in report["diagnostics"]] == [
        ("no-parser", "themes/a.yaml")
    ]


# ── References ───────────────────────────────────────────────────────────


def test_an_explicit_ref_produces_one_edge_and_a_resolved_node() -> None:
    source = memory("s", {"themes/a.json": '{"other":{"$ref":"theme:b"}}', "themes/b.json": "{}"})
    fixtures = loader(registry(theme()), [source])
    graph = fixtures.referenceGraph()
    assert graph["edges"] == [{"from": "theme:a", "to": "theme:b", "fieldPath": ["other"]}]
    assert graph["nodes"]["theme:b"]["resolved"] is True
    assert fixtures.validate()["ok"]


def test_a_ref_to_a_missing_fixture_is_one_diagnostic_and_an_unresolved_node() -> None:
    source = memory("s", {"themes/a.json": '{"other":{"$ref":"theme:gone"}}'})
    fixtures = loader(registry(theme()), [source])
    report = fixtures.validate()
    assert not report["ok"]
    assert [(d["code"], d.get("fieldPath")) for d in report["diagnostics"]] == [
        ("missing-reference", "other")
    ]
    assert fixtures.referenceGraph()["nodes"]["theme:gone"]["resolved"] is False


def test_a_bare_ref_string_is_inert_under_the_default_mode() -> None:
    source = memory("s", {"themes/a.json": '{"other":"theme:b"}', "themes/b.json": "{}"})
    fixtures = loader(registry(theme()), [source])
    assert fixtures.referenceGraph()["edges"] == []
    assert fixtures.resolveRef("theme:b") == "theme:b"


def test_explicit_and_bare_mode_resolves_a_whole_string_ref() -> None:
    source = memory("s", {"themes/a.json": '{"other":"theme:b"}', "themes/b.json": '{"v":1}'})
    fixtures = loader(registry(theme()), [source], reference_mode="explicit-and-bare")
    assert fixtures.resolveRef("theme:b") == {"v": 1}
    assert fixtures.referenceGraph()["edges"] == [
        {"from": "theme:a", "to": "theme:b", "fieldPath": ["other"]}
    ]


def test_prose_containing_a_ref_is_not_a_reference() -> None:
    source = memory("s", {"themes/a.json": '{"note":"Use theme:missing in prose only."}'})
    fixtures = loader(registry(theme()), [source], reference_mode="explicit-and-bare")
    assert fixtures.validate()["ok"]
    assert fixtures.referenceGraph()["edges"] == []


def test_a_type_level_reference_mode_overrides_the_loader_level_one() -> None:
    source = memory("s", {"themes/a.json": '{"other":"theme:b"}', "themes/b.json": "{}"})
    definition = theme(referenceMode="explicit-only")
    fixtures = loader(registry(definition), [source], reference_mode="explicit-and-bare")
    assert fixtures.referenceGraph()["edges"] == []


def test_a_dollar_ref_object_is_not_descended_into() -> None:
    source = memory(
        "s",
        {
            "themes/a.json": '{"o":{"$ref":"theme:b","inner":{"$ref":"theme:c"}}}',
            "themes/b.json": "{}",
        },
    )
    graph = loader(registry(theme()), [source]).referenceGraph()
    assert [edge["to"] for edge in graph["edges"]] == ["theme:b"]


def test_the_same_target_at_two_paths_yields_two_edges() -> None:
    source = memory(
        "s",
        {"themes/a.json": '{"z":[{"$ref":"theme:b"},{"$ref":"theme:b"}]}', "themes/b.json": "{}"},
    )
    graph = loader(registry(theme()), [source]).referenceGraph()
    assert [edge["fieldPath"] for edge in graph["edges"]] == [["z", 0], ["z", 1]]


def test_references_deeper_than_thirty_two_levels_are_invisible() -> None:
    deep: Any = {"$ref": "theme:b"}
    for _ in range(33):
        deep = {"n": deep}
    source = memory("s", {"themes/a.json": json.dumps(deep), "themes/b.json": "{}"})
    assert loader(registry(theme()), [source]).referenceGraph()["edges"] == []


def test_a_malformed_extracted_ref_stays_visible_as_a_node() -> None:
    source = memory("s", {"themes/a.json": '{"o":{"$ref":"not a ref"}}'})
    graph = loader(registry(theme()), [source]).referenceGraph()
    assert graph["nodes"]["not a ref"]["type"] == "<malformed>"
    assert [(d["code"], d.get("fieldPath")) for d in graph["diagnostics"]] == [("invalid-ref", "o")]


def test_an_extract_references_hook_contributes_edges_the_walk_cannot_find() -> None:
    def extract(value: Any) -> list[dict[str, Any]]:
        target = value.get("points_at")
        return [{"ref": f"theme:{target}", "fieldPath": ["points_at"]}] if target else []

    source = memory("s", {"themes/a.json": '{"points_at":"b"}', "themes/b.json": "{}"})
    graph = loader(registry(theme(extractReferences=extract)), [source]).referenceGraph()
    assert [edge["to"] for edge in graph["edges"]] == ["theme:b"]


def test_resolve_ref_rejects_a_ref_of_the_wrong_type() -> None:
    source = memory("s", {"themes/b.json": "{}"})
    fixtures = loader(registry(theme()), [source])
    with pytest.raises(FixtureError) as info:
        fixtures.resolveRef({"$ref": "theme:b"}, "other")
    assert str(info.value) == 'Expected ref of type "other" but got "theme".'


def test_resolve_ref_validates_an_inline_value_against_an_expected_type() -> None:
    definition = theme(jsonSchema={"type": "object", "required": ["name"]})
    definition.pop("schema")
    fixtures = loader(registry(definition), [memory("s", {})])
    assert fixtures.resolveRef({"name": "ok"}, "theme") == {"name": "ok"}
    with pytest.raises(FixtureValidationError) as info:
        fixtures.resolveRef({}, "theme")
    assert info.value.diagnostic.get("fixture") == "<inline theme>"
    assert info.value.diagnostic.get("source") == "<inline>"


# ── Degrading on a broken source ─────────────────────────────────────────


class BrokenSource:
    id = "broken"

    def list(self) -> list[FixtureSourceEntry]:
        raise RuntimeError("disk on fire")

    def read(self, entry: FixtureSourceEntry) -> str:
        raise RuntimeError("disk on fire")


def test_validate_degrades_around_a_source_whose_listing_fails() -> None:
    good = memory("good", {"themes/a.json": "{}"})
    sources: list[FixtureSource | LayeredSource] = [BrokenSource(), good]
    report = loader(registry(theme()), sources).validate()
    assert not report["ok"]
    codes = [d["code"] for d in report["diagnostics"]]
    assert codes == ["source-list-failed"]
    assert "disk on fire" in report["diagnostics"][0]["message"]


def test_load_does_not_degrade_the_way_validate_does() -> None:
    good = memory("good", {"themes/a.json": "{}"})
    sources: list[FixtureSource | LayeredSource] = [BrokenSource(), good]
    with pytest.raises(FixtureError) as info:
        loader(registry(theme()), sources).load("theme:a")
    assert info.value.diagnostic["code"] == "source-list-failed"


# ── Materialization and caches ───────────────────────────────────────────


def test_a_materialize_hook_cycle_is_reported_as_a_chain() -> None:
    def materialize(value: Any, ctx: Any) -> Any:
        return ctx["materialize"](value["next"])

    source = memory(
        "s", {"themes/a.json": '{"next":"theme:b"}', "themes/b.json": '{"next":"theme:a"}'}
    )
    fixtures = loader(registry(theme(materialize=materialize)), [source])
    with pytest.raises(FixtureError) as info:
        fixtures.materialize("theme:a")
    assert str(info.value) == "Materialization cycle detected: theme:a -> theme:b -> theme:a."


def test_materialize_context_load_raw_returns_the_value_not_the_loaded_fixture() -> None:
    seen: list[Any] = []

    def materialize(value: Any, ctx: Any) -> Any:
        seen.append(ctx["loadRaw"]("theme:b"))
        return value

    source = memory("s", {"themes/a.json": "{}", "themes/b.json": '{"v":1}'})
    loader(registry(theme(materialize=materialize)), [source]).materialize("theme:a")
    assert seen == [{"v": 1}]


def test_a_materialized_value_is_computed_once_and_reused() -> None:
    """The hook builds a NEW object every call, so identity across two loads can
    only come from the materialization cache and never from the raw one."""
    calls: list[str] = []

    def materialize(value: Any, ctx: Any) -> Any:
        del ctx
        calls.append("call")
        return {"v": value["v"]}

    source = memory("s", {"themes/a.json": '{"v":1}'})
    fixtures = loader(registry(theme(materialize=materialize)), [source])
    first = fixtures.materialize("theme:a")
    assert fixtures.materialize("theme:a") is first
    assert calls == ["call"]


def test_invalidate_for_one_ref_still_clears_the_document_cache() -> None:
    """A materialized value may depend on any other fixture, so a targeted
    invalidation is deliberately conservative."""
    files = {"themes/a.json": '{"v":1}'}
    source = memory("s", files)
    fixtures = FixtureLoader(registry(theme()), [source])
    assert fixtures.load("theme:a") == {"v": 1}
    source._files["themes/a.json"] = '{"v":2}'  # pyright: ignore[reportPrivateUsage]
    assert fixtures.load("theme:a") == {"v": 1}
    fixtures.invalidate("theme:a")
    assert fixtures.load("theme:a") == {"v": 2}


def test_list_filters_by_type_and_ignores_an_unregistered_one() -> None:
    other = {"type": "other", "directory": "others", "schema": passthrough}
    source = memory("s", {"themes/a.json": "{}", "others/b.json": "{}"})
    fixtures = loader(registry(theme(), other), [source])
    assert fixtures.list() == ["other:b", "theme:a"]
    assert fixtures.list("theme") == ["theme:a"]
    assert fixtures.list("nope") == []
