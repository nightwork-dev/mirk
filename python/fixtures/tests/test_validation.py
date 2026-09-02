"""JSON Schema validation with an injected engine, and the registry rule.

The package imports no JSON Schema engine. These tests inject `jsonschema`'s
`Draft202012Validator` exactly as the conformance backend does, and pin the
flattening that lets two engines be compared: leaf instance paths only, with
`anyOf`, `oneOf` and `if` aggregates dropped.
"""

from __future__ import annotations

from typing import Any, cast

import pytest

from helpers import loader, memory, passthrough, registry
from mirk.fixtures import FixtureError, FixtureLoader, FixtureRegistry, FixtureValidationError
from mirk.fixtures.conformance import json_schema_validator_factory

SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["name", "palette"],
    "properties": {
        "name": {"type": "string"},
        "palette": {
            "type": "object",
            "properties": {"bg": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"}},
        },
        "tags": {"type": "array", "items": {"type": "string"}},
    },
}
THEME: dict[str, Any] = {"type": "theme", "directory": "themes", "jsonSchema": SCHEMA}


def paths(report: Any) -> list[str]:
    return sorted({f"{d['fixture']}#{d.get('fieldPath', '')}" for d in report["diagnostics"]})


def test_a_valid_document_loads_unchanged() -> None:
    source = memory("s", {"themes/a.json": '{"name":"A","palette":{"bg":"#000000"}}'})
    fixtures = loader(registry(THEME), [source])
    assert fixtures.load("theme:a") == {"name": "A", "palette": {"bg": "#000000"}}
    assert fixtures.validate() == {"ok": True, "diagnostics": []}


def test_every_failing_leaf_path_is_reported_once() -> None:
    source = memory("s", {"themes/a.json": '{"name":5,"palette":{"bg":"nope"},"tags":["ok",7]}'})
    report = loader(registry(THEME), [source]).validate()
    assert not report["ok"]
    assert paths(report) == ["theme:a#name", "theme:a#palette.bg", "theme:a#tags.1"]
    assert {d["code"] for d in report["diagnostics"]} == {"schema-invalid"}


def test_a_root_level_failure_reports_an_empty_field_path() -> None:
    source = memory("s", {"themes/a.json": "{}"})
    report = loader(registry(THEME), [source]).validate()
    # Two missing required properties, both reported at the document root, so
    # the de-duplicated path set is one entry with an empty instance path.
    assert len(report["diagnostics"]) == 2
    assert all(d.get("fieldPath") == "" for d in report["diagnostics"])
    assert paths(report) == ["theme:a#"]


def test_aggregate_keyword_paths_are_dropped_and_only_leaves_survive() -> None:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "model": {"anyOf": [{"type": "string"}, {"type": "object", "required": ["id"]}]}
        },
    }
    validate = json_schema_validator_factory(schema)
    issues = validate({"model": {"wrong": 1}})
    assert [list(cast(Any, issue)["path"]) for issue in issues] == [["model"], ["model"]]
    assert all(issue.get("message") for issue in issues)


def test_a_boolean_schema_document_is_accepted() -> None:
    assert json_schema_validator_factory(True)({"anything": 1}) == []
    assert json_schema_validator_factory(False)({"anything": 1}) != []


def test_the_first_issue_supplies_the_error_field_path() -> None:
    source = memory("s", {"themes/a.json": '{"name":5,"palette":{}}'})
    fixtures = loader(registry(THEME), [source])
    with pytest.raises(FixtureValidationError) as info:
        fixtures.load("theme:a")
    assert info.value.diagnostic["code"] == "schema-invalid"
    assert info.value.diagnostic.get("fieldPath") == "name"
    assert info.value.diagnostic.get("path") == "themes/a.json"


def test_a_merged_patch_is_revalidated_and_blamed_on_the_patch() -> None:
    base = memory("base", {"themes/a.json": '{"name":"A","palette":{}}'})
    patch = memory("over", {"themes/a.json": '{"$patch":"theme:a","name":5}'})
    definition = {**THEME, "mergeStrategy": "deep"}
    with pytest.raises(FixtureValidationError) as info:
        loader(registry(definition), [base, patch]).load("theme:a")
    assert info.value.diagnostic.get("source") == "over"


def test_a_schema_callable_transforms_the_value_after_the_document_runs() -> None:
    def upcase(value: Any) -> dict[str, Any]:
        return {"value": {**value, "name": value["name"].upper()}}

    definition = {**THEME, "schema": upcase}
    source = memory("s", {"themes/a.json": '{"name":"a","palette":{}}'})
    assert loader(registry(definition), [source]).load("theme:a")["name"] == "A"


def test_a_schema_callable_returning_issues_fails_validation() -> None:
    def reject(value: Any) -> dict[str, Any]:
        return {"issues": [{"message": "no", "path": ["name"]}]}

    definition = {"type": "theme", "directory": "themes", "schema": reject}
    source = memory("s", {"themes/a.json": "{}"})
    report = loader(registry(definition), [source]).validate()
    assert paths(report) == ["theme:a#name"]


def test_a_type_declaring_neither_schema_nor_json_schema_is_rejected() -> None:
    reg = FixtureRegistry()
    with pytest.raises(FixtureError) as info:
        reg.register({"type": "theme", "directory": "themes"})
    assert info.value.diagnostic["code"] == "missing-schema"
    assert str(info.value) == 'Fixture type "theme" must declare "jsonSchema" or "schema".'


def test_the_false_schema_document_still_counts_as_declared() -> None:
    reg = FixtureRegistry()
    reg.register({"type": "theme", "directory": "themes", "jsonSchema": False})
    assert reg.types() == ["theme"]


def test_registering_one_type_twice_is_rejected() -> None:
    reg = FixtureRegistry()
    reg.register({"type": "theme", "directory": "themes", "schema": passthrough})
    with pytest.raises(FixtureError) as info:
        reg.register({"type": "theme", "directory": "other", "schema": passthrough})
    assert str(info.value) == 'Fixture type "theme" is already registered.'
    assert info.value.diagnostic["code"] == "duplicate-type"


def test_types_are_returned_in_code_point_order() -> None:
    reg = FixtureRegistry()
    for name in ("zebra", "Apple", "apple"):
        reg.register({"type": name, "directory": name, "schema": passthrough})
    assert reg.types() == ["Apple", "apple", "zebra"]


def test_a_json_schema_with_no_injected_validator_fails_loudly() -> None:
    """Silently skipping validation would let a broken pack load clean."""
    source = memory("s", {"themes/a.json": "{}"})
    fixtures = FixtureLoader(registry(THEME), [source])
    with pytest.raises(FixtureError) as info:
        fixtures.load("theme:a")
    assert info.value.diagnostic["code"] == "no-json-schema-validator"


# ── The two rules that make Ajv and `jsonschema` agree ───────────────────


def test_a_required_failure_keeps_the_containing_objects_path() -> None:
    """The missing property name is never appended. Ajv puts it in `params`
    and `jsonschema` only in the message text, so appending it in one language
    and not the other would diverge."""
    schema: dict[str, Any] = {
        "type": "object",
        "required": ["a"],
        "properties": {"a": {"type": "object", "required": ["b"]}},
    }
    issues = json_schema_validator_factory(schema)({"a": {}})
    assert [list(cast(Any, issue)["path"]) for issue in issues] == [["a"]]


def test_a_root_required_failure_reports_the_empty_path() -> None:
    schema: dict[str, Any] = {"type": "object", "required": ["a"]}
    issues = json_schema_validator_factory(schema)({})
    assert [list(cast(Any, issue)["path"]) for issue in issues] == [[]]


def test_a_not_failure_is_reported_at_its_own_path() -> None:
    """`not` has no branch failures underneath it. Dropping the aggregate would
    leave an empty issue set, which reads as a valid document, so the aggregate
    is the only evidence there is and it is kept at its own instance path."""
    schema: dict[str, Any] = {"type": "object", "properties": {"x": {"not": {"const": "bad"}}}}
    issues = json_schema_validator_factory(schema)({"x": "bad"})
    assert [list(cast(Any, issue)["path"]) for issue in issues] == [["x"]]
    assert json_schema_validator_factory(schema)({"x": "fine"}) == []


def test_an_overlapping_one_of_is_reported_at_its_own_path() -> None:
    """Matching two branches is a failure with nothing underneath it: the
    engines report only that too many branches matched."""
    schema: dict[str, Any] = {
        "type": "object",
        "properties": {"v": {"oneOf": [{"type": "number"}, {"type": "integer"}]}},
    }
    issues = json_schema_validator_factory(schema)({"v": 1})
    assert [list(cast(Any, issue)["path"]) for issue in issues] == [["v"]]


def test_a_one_of_branch_failure_replaces_the_aggregate_with_the_leaf_path() -> None:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": {
            "v": {
                "oneOf": [
                    {"type": "object", "required": ["a"], "properties": {"a": {"type": "string"}}}
                ]
            }
        },
    }
    issues = json_schema_validator_factory(schema)({"v": {"a": 1}})
    assert [list(cast(Any, issue)["path"]) for issue in issues] == [["v", "a"]]


def test_an_if_then_failure_surfaces_the_branch_not_the_aggregate() -> None:
    schema: dict[str, Any] = {
        "if": {"properties": {"kind": {"const": "remote"}}, "required": ["kind"]},
        "then": {"required": ["baseUrl"]},
    }
    validate = json_schema_validator_factory(schema)
    assert [list(cast(Any, i)["path"]) for i in validate({"kind": "remote"})] == [[]]
    assert validate({"kind": "local"}) == []
