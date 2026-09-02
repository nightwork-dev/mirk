"""The `fixtures` conformance target and its port contract.

The corpus dispatches an `op` string straight onto this object, so the method
names, the argument shapes and the result key spellings are the contract. These
tests exercise it exactly as the runner does, on both backends.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from mirk.store import InMemoryStore, SqliteStore
from mirk.store.conformance import (
    StepOutcome,
    compare_invalid_paths,
    resolve_target,
    run_step,
)

from mirk.fixtures import FixtureError, conformance_target

SPEC: dict[str, Any] = {
    "types": [
        {
            "type": "theme",
            "directory": "themes",
            "mergeStrategy": "deep",
            "jsonSchema": {
                "type": "object",
                "required": ["name"],
                "properties": {"name": {"type": "string"}},
            },
        },
        {"type": "template", "directory": "templates"},
    ],
    "sources": [
        {
            "kind": "memory",
            "name": "base",
            "priority": 0,
            "files": {
                "themes/dark.json": '{"name":"Dark","palette":{"bg":"#000"}}',
                "templates/page.json": '{"theme":{"$ref":"theme:dark"}}',
            },
        },
        {
            "kind": "memory",
            "name": "over",
            "priority": 10,
            "files": {"themes/dark.json": '{"$patch":"theme:dark","palette":{"fg":"#fff"}}'},
        },
    ],
}


@pytest.fixture(params=["memory", "sqlite"])
def backend(request: Any) -> Any:
    store = InMemoryStore() if request.param == "memory" else SqliteStore(":memory:")
    yield (request.param, store)
    close = getattr(store, "close", None)
    if callable(close):
        close()


def configured(backend: Any, spec: dict[str, Any] = SPEC) -> Any:
    name, store = backend
    target: Any = conformance_target(name, store)
    target.configure(spec)
    return target


def test_the_runner_resolves_the_fixtures_port_by_convention() -> None:
    """`mirk.store.fixtures` does not exist, so resolution falls through to
    `mirk.fixtures` without the runner knowing this package by name."""
    target: Any = resolve_target("fixtures", "memory", InMemoryStore())
    assert callable(target.configure)


def test_load_list_types_and_explain(backend: Any) -> None:
    target = configured(backend)
    assert target.types() == ["template", "theme"]
    assert target.list() == ["template:page", "theme:dark"]
    assert target.list("theme") == ["theme:dark"]
    assert target.load("theme:dark") == {
        "name": "Dark",
        "palette": {"bg": "#000", "fg": "#fff"},
    }
    provenance = target.explain("theme:dark")
    assert provenance["finalRef"] == "theme:dark"
    assert [layer["kind"] for layer in provenance["layers"]] == ["base", "patch"]
    assert [layer["path"] for layer in provenance["layers"]] == [
        "themes/dark.json",
        "themes/dark.json",
    ]


def test_validate_reference_graph_and_resolve_ref(backend: Any) -> None:
    target = configured(backend)
    assert target.validate() == {"ok": True, "diagnostics": []}
    graph = target.referenceGraph()
    assert [node["ref"] for node in graph["nodes"]] == ["template:page", "theme:dark"]
    assert graph["edges"] == [{"from": "template:page", "to": "theme:dark", "fieldPath": ["theme"]}]
    assert target.resolveRef({"$ref": "theme:dark"})["name"] == "Dark"
    assert target.resolveRef("theme:dark") == "theme:dark"


def test_invalidate_drops_the_cached_fixture(backend: Any) -> None:
    """A cached load hands back the same object; after invalidation the value
    is parsed and layered again, so it is a new object with the same content."""
    target = configured(backend)
    first = target.load("theme:dark")
    assert target.load("theme:dark") is first

    target.invalidate("theme:dark")
    second = target.load("theme:dark")
    assert second is not first
    assert second == first

    target.invalidate()
    third = target.load("theme:dark")
    assert third is not second
    assert third == first


def test_a_store_source_is_written_through_the_backend_first(backend: Any) -> None:
    spec: dict[str, Any] = {
        "types": [{"type": "theme", "directory": "themes"}],
        "sources": [
            {
                "kind": "store",
                "name": "st",
                "priority": 0,
                "collection": "fx",
                "pathPrefix": "themes",
                "extension": ".json",
                "items": [
                    {
                        "id": "dark",
                        "content": '{"name":"Dark"}',
                        "relativePath": "themes/dark.json",
                    },
                    {"id": "light", "content": '{"name":"Light"}'},
                ],
            }
        ],
    }
    target = configured(backend, spec)
    assert target.list() == ["theme:dark", "theme:light"]
    assert target.load("theme:light") == {"name": "Light"}
    # The default extension filled the row that omitted one.
    _, store = backend
    assert store.getById("fx", "light")["extension"] == ".json"


def test_seed_store_writes_into_the_backend_and_read_seeded_reads_it(backend: Any) -> None:
    target = configured(backend)
    result = target.seedStore({"targets": {"theme": "seeded"}, "includeProvenance": True})
    assert [row["ref"] for row in result["written"]] == ["theme:dark"]
    assert result["skipped"] == []
    seeded = target.readSeeded("seeded", "dark")
    assert seeded["value"]["name"] == "Dark"
    assert seeded["provenance"]["finalRef"] == "theme:dark"


def test_a_type_without_a_json_schema_accepts_anything(backend: Any) -> None:
    """`jsonSchema` defaults to the document `true`, so a scenario that does
    not care about validation declares nothing."""
    spec: dict[str, Any] = {
        "types": [{"type": "theme", "directory": "themes"}],
        "sources": [
            {"kind": "memory", "name": "s", "priority": 0, "files": {"themes/a.json": "5"}}
        ],
    }
    assert configured(backend, spec).load("theme:a") == 5


def test_an_error_this_package_raises_carries_its_exact_message(backend: Any) -> None:
    spec: dict[str, Any] = {
        "types": [{"type": "theme", "directory": "themes"}],
        "sources": [
            {
                "kind": "memory",
                "name": "s",
                "priority": 0,
                "files": {"themes/a.json": '{"$patch":"theme:a"}'},
            }
        ],
    }
    target = configured(backend, spec)
    outcome = run_step(target, "load", ["theme:a"])
    assert outcome.ok is False
    assert outcome.message == 'Fixture "theme:a" has patches but no base document.'


# ── The `invalidPaths` expect form ───────────────────────────────────────

INVALID_SPEC: dict[str, Any] = {
    "types": [
        {
            "type": "theme",
            "directory": "themes",
            "jsonSchema": {
                "type": "object",
                "required": ["name"],
                "properties": {"name": {"type": "string"}, "size": {"type": "integer"}},
            },
        }
    ],
    "sources": [
        {
            "kind": "memory",
            "name": "s",
            "priority": 0,
            "files": {"themes/a.json": '{"name":5,"size":"big"}'},
        }
    ],
}


def test_invalid_paths_compares_the_set_of_failing_leaf_paths(backend: Any) -> None:
    target = configured(backend, INVALID_SPEC)
    outcome = run_step(target, "validate", [])
    assert (
        compare_invalid_paths(outcome, {"invalidPaths": ["theme:a#name", "theme:a#size"]}) is None
    )


def test_invalid_paths_rejects_a_wrong_set(backend: Any) -> None:
    target = configured(backend, INVALID_SPEC)
    outcome = run_step(target, "validate", [])
    detail = compare_invalid_paths(outcome, {"invalidPaths": ["theme:a#name"]})
    assert detail is not None
    assert "theme:a#size" in detail


def test_invalid_paths_refuses_a_diagnostic_of_another_code() -> None:
    outcome = StepOutcome.returned(
        {
            "ok": False,
            "diagnostics": [
                {
                    "severity": "error",
                    "code": "missing-reference",
                    "message": "x",
                    "fixture": "theme:a",
                }
            ],
        }
    )
    detail = compare_invalid_paths(outcome, {"invalidPaths": []})
    assert detail is not None
    assert "missing-reference" in detail


def test_invalid_paths_requires_ok_false_when_the_set_is_non_empty() -> None:
    outcome = StepOutcome.returned(
        {
            "ok": True,
            "diagnostics": [
                {
                    "severity": "error",
                    "code": "schema-invalid",
                    "message": "x",
                    "fixture": "theme:a",
                    "fieldPath": "name",
                }
            ],
        }
    )
    detail = compare_invalid_paths(outcome, {"invalidPaths": ["theme:a#name"]})
    assert detail is not None
    assert "$.ok" in detail


def test_invalid_paths_rejects_a_raise() -> None:
    detail = compare_invalid_paths(StepOutcome.raised("boom"), {"invalidPaths": []})
    assert detail is not None
    assert "boom" in detail


def test_an_op_before_configure_is_a_clear_failure() -> None:
    target: Any = conformance_target("memory", InMemoryStore())
    with pytest.raises(RuntimeError):
        target.load("theme:a")


def test_a_store_source_scenario_runs_against_a_sqlite_file(tmp_path: Path) -> None:
    """The SQLite backend the runner opens is the same handle the store source
    reads through, so a file-backed scenario is a real round trip."""
    database = tmp_path / "conformance.sqlite"
    store = SqliteStore(str(database))
    try:
        target: Any = conformance_target("sqlite", store)
        target.configure(
            {
                "types": [{"type": "theme", "directory": "themes"}],
                "sources": [
                    {
                        "kind": "store",
                        "name": "st",
                        "priority": 0,
                        "collection": "fx",
                        "pathPrefix": "themes",
                        "extension": ".json",
                        "items": [{"id": "dark", "content": '{"name":"Dark"}'}],
                    }
                ],
            }
        )
        target.seedStore({"targets": {"theme": "seeded"}})
    finally:
        store.close()

    verifier = SqliteStore(str(database))
    try:
        assert verifier.getById("seeded", "dark") == {"id": "dark", "value": {"name": "Dark"}}
    finally:
        verifier.close()


def test_an_unknown_source_kind_is_rejected(backend: Any) -> None:
    name, store = backend
    target: Any = conformance_target(name, store)
    with pytest.raises(ValueError):
        target.configure({"types": [], "sources": [{"kind": "nope", "name": "x", "priority": 0}]})


def test_a_duplicate_type_in_a_spec_is_the_registry_error(backend: Any) -> None:
    name, store = backend
    target: Any = conformance_target(name, store)
    with pytest.raises(FixtureError) as info:
        target.configure(
            {
                "types": [
                    {"type": "theme", "directory": "a"},
                    {"type": "theme", "directory": "b"},
                ],
                "sources": [],
            }
        )
    assert str(info.value) == 'Fixture type "theme" is already registered.'


# ── Wire-shape rules the corpus fixes ────────────────────────────────────


def test_a_store_item_without_an_extension_gets_json(backend: Any) -> None:
    """Parsers are JSON only in the corpus. Without a default, the derived
    path would end in the text "undefined", which is what TypeScript builds
    from a missing extension."""
    spec: dict[str, Any] = {
        "types": [{"type": "theme", "directory": "themes"}],
        "sources": [
            {
                "kind": "store",
                "name": "db",
                "priority": 0,
                "collection": "fixture_docs",
                "pathPrefix": "themes",
                "items": [{"id": "derived", "content": '{"name":"Derived"}'}],
            }
        ],
    }
    target = configured(backend, spec)
    assert target.list() == ["theme:derived"]
    assert target.load("theme:derived") == {"name": "Derived"}


def test_graph_nodes_are_sorted_by_ref_and_field_paths_are_text(backend: Any) -> None:
    """A JavaScript `Map` has no JSON form, so nodes go on the wire sorted by
    ref, and an array index travels as `"0"` rather than `0`."""
    spec: dict[str, Any] = {
        "types": [
            {"type": "theme", "directory": "themes"},
            {"type": "page", "directory": "pages"},
        ],
        "sources": [
            {
                "kind": "memory",
                "name": "pack",
                "priority": 0,
                "files": {
                    "themes/dark.json": '{"name":"Dark"}',
                    "pages/home.json": (
                        '{"themes":[{"$ref":"theme:dark"}],"broken":{"$ref":"not a ref"}}'
                    ),
                },
            }
        ],
    }
    graph = configured(backend, spec).referenceGraph()
    assert [node["ref"] for node in graph["nodes"]] == [
        "not a ref",
        "page:home",
        "theme:dark",
    ]
    assert graph["nodes"][0]["type"] == "<malformed>"
    # Edges sort by from, to, then the joined field path, so the malformed
    # target sorts ahead of theme:dark rather than staying in walk order.
    assert [edge["to"] for edge in graph["edges"]] == ["not a ref", "theme:dark"]
    assert [edge["fieldPath"] for edge in graph["edges"]] == [["broken"], ["themes", "0"]]


def test_configure_twice_is_refused(backend: Any) -> None:
    """One target, one scenario, one loader: a second `configure` would make
    the earlier steps' state ambiguous."""
    target = configured(backend)
    with pytest.raises(RuntimeError):
        target.configure(SPEC)


def test_an_explicit_null_json_schema_declares_no_contract(backend: Any) -> None:
    """A scenario reaches the registry's `missing-schema` rejection by
    declaring `jsonSchema: null`; omitting the key means the document `true`."""
    name, store = backend
    target: Any = conformance_target(name, store)
    with pytest.raises(FixtureError) as info:
        target.configure(
            {"types": [{"type": "theme", "directory": "themes", "jsonSchema": None}], "sources": []}
        )
    assert info.value.diagnostic["code"] == "missing-schema"


def test_validate_diagnostics_returns_the_array_alone(backend: Any) -> None:
    """`parse-failed` wraps the host parser's own words, which no two languages
    share. The corpus pins such a diagnostic through this op with the `values`
    form and `ignoreFields: ["message"]`, so no host text ever reaches it."""
    spec: dict[str, Any] = {
        "types": [{"type": "theme", "directory": "themes"}],
        "sources": [
            {
                "kind": "memory",
                "name": "pack",
                "priority": 0,
                "files": {
                    "themes/bad.json": "{ not json",
                    "themes/good.json": '{"name":"Good"}',
                },
            }
        ],
    }
    target = configured(backend, spec)
    diagnostics = target.validateDiagnostics()
    assert [
        {key: value for key, value in row.items() if key != "message"} for row in diagnostics
    ] == [
        {
            "severity": "error",
            "code": "parse-failed",
            "fixture": "theme",
            "source": "pack",
            "path": "themes/bad.json",
        }
    ]
    assert diagnostics[0]["message"].startswith("Parse error: ")


def test_list_aborts_on_a_parse_error_where_validate_degrades(backend: Any) -> None:
    """The other half of the same behaviour, language-local because the message
    is the host parser's."""
    spec: dict[str, Any] = {
        "types": [{"type": "theme", "directory": "themes"}],
        "sources": [
            {
                "kind": "memory",
                "name": "pack",
                "priority": 0,
                "files": {
                    "themes/bad.json": "{ not json",
                    "themes/good.json": '{"name":"Good"}',
                },
            }
        ],
    }
    target = configured(backend, spec)
    outcome = run_step(target, "list", [])
    assert outcome.ok is False
    assert outcome.message is not None
    assert outcome.message.startswith("Parse error: ")
    assert target.validate()["ok"] is False
