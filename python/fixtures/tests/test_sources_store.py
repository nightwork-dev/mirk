"""The store source and the seeding sink, over a real `mirk.store` backend.

Every expectation here was produced by running the TypeScript package on the
same inputs and diffing; the two implementations agree exactly.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from mirk.store import InMemoryStore, SqliteStore

from helpers import loader, passthrough, registry
from mirk.fixtures import FixtureError
from mirk.fixtures.sources.store import StoreFixtureSource, seed_store_from_fixtures

THEME: dict[str, Any] = {"type": "theme", "directory": "themes", "schema": passthrough}
TEMPLATE: dict[str, Any] = {"type": "template", "directory": "templates", "schema": passthrough}


def stocked(*items: dict[str, Any]) -> InMemoryStore:
    store = InMemoryStore()
    for item in items:
        store.put("fx", item)
    return store


def test_a_locator_is_opaque_and_never_parsed_as_a_path() -> None:
    store = stocked(
        {
            "id": "item.with.dots/and/slash",
            "content": '{"n":1}',
            "extension": ".json",
            "relativePath": "themes/store-theme.json",
        }
    )
    source = StoreFixtureSource("st", store, "fx")
    assert loader(registry(THEME), [source]).load("theme:store-theme") == {"n": 1}


def test_an_explicit_relative_path_ignores_the_path_prefix() -> None:
    store = stocked(
        {"id": "a", "content": "{}", "extension": ".json", "relativePath": "themes/explicit.json"},
        {"id": "b", "content": "{}", "extension": ".json"},
    )
    source = StoreFixtureSource("st", store, "fx", path_prefix="themes")
    assert [entry["relativePath"] for entry in source.list()] == [
        "themes/b.json",
        "themes/explicit.json",
    ]


def test_entries_sort_by_relative_path_then_id() -> None:
    store = stocked(
        {"id": "z", "content": "{}", "extension": ".json"},
        {"id": "a", "content": "{}", "extension": ".json"},
        {"id": "m", "content": "{}", "extension": ".json"},
    )
    source = StoreFixtureSource("st", store, "fx")
    assert [entry["locator"] for entry in source.list()] == ["a", "m", "z"]


def test_read_refuses_a_locator_and_path_pair_the_source_did_not_list() -> None:
    store = stocked(
        {"id": "a", "content": "{}", "extension": ".json"},
        {"id": "b", "content": "{}", "extension": ".json"},
    )
    source = StoreFixtureSource("st", store, "fx")
    source.list()
    with pytest.raises(FixtureError) as info:
        source.read({"relativePath": "a.json", "locator": "b"})
    assert str(info.value) == 'Store source "st" has no listed entry "a.json".'
    assert info.value.diagnostic["code"] == "source-read-failed"


def test_the_listing_is_cached_until_invalidate() -> None:
    store = stocked({"id": "a", "content": "{}", "extension": ".json"})
    source = StoreFixtureSource("st", store, "fx")
    assert len(source.list()) == 1
    store.put("fx", {"id": "b", "content": "{}", "extension": ".json"})
    assert len(source.list()) == 1
    source.invalidate()
    assert len(source.list()) == 2


def test_a_relative_path_that_escapes_is_rejected_at_list_time() -> None:
    store = stocked(
        {"id": "x", "content": "{}", "extension": ".json", "relativePath": "../escape.json"}
    )
    with pytest.raises(FixtureError) as info:
        StoreFixtureSource("st", store, "fx").list()
    assert str(info.value) == (
        'Store fixture relativePath "../escape.json" is not a safe source-relative path.'
    )
    assert info.value.diagnostic["code"] == "unsafe-relative-path"


def test_two_rows_producing_one_path_are_rejected_at_list_time() -> None:
    store = stocked(
        {"id": "x", "content": "{}", "extension": ".json", "relativePath": "a.json"},
        {"id": "y", "content": "{}", "extension": ".json", "relativePath": "a.json"},
    )
    with pytest.raises(FixtureError) as info:
        StoreFixtureSource("st", store, "fx").list()
    assert str(info.value) == 'Store source "st" produced duplicate relative path "a.json".'


# ── Seeding ──────────────────────────────────────────────────────────────


def seeding_loader(template_body: str) -> Any:
    store = stocked(
        {
            "id": "dark",
            "content": '{"name":"Dark"}',
            "extension": ".json",
            "relativePath": "themes/dark.json",
        },
        {
            "id": "page",
            "content": template_body,
            "extension": ".json",
            "relativePath": "templates/page.json",
        },
    )
    return loader(registry(THEME, TEMPLATE), [StoreFixtureSource("st", store, "fx")])


def test_seeding_writes_each_type_into_its_collection_with_provenance() -> None:
    sink = InMemoryStore()
    result = seed_store_from_fixtures(
        seeding_loader('{"theme":{"$ref":"theme:dark"}}'),
        sink,
        {"theme": "themes", "template": "templates"},
        include_provenance=True,
    )
    assert [row["ref"] for row in result["written"]] == ["theme:dark", "template:page"]
    stored: Any = sink.getById("themes", "dark")
    assert stored["value"] == {"name": "Dark"}
    assert stored["provenance"]["finalRef"] == "theme:dark"


def test_seeding_omits_provenance_by_default() -> None:
    sink = InMemoryStore()
    seed_store_from_fixtures(
        seeding_loader('{"theme":{"$ref":"theme:dark"}}'), sink, {"theme": "themes"}
    )
    assert "provenance" not in sink.getById("themes", "dark")


def test_insert_only_skips_an_existing_row() -> None:
    sink = InMemoryStore()
    fixtures = seeding_loader('{"theme":{"$ref":"theme:dark"}}')
    seed_store_from_fixtures(fixtures, sink, {"theme": "themes"})
    result = seed_store_from_fixtures(fixtures, sink, {"theme": "themes"}, mode="insert-only")
    assert result["written"] == []
    assert [row["reason"] for row in result["skipped"]] == ["exists"]


def test_a_later_failure_leaves_an_earlier_valid_fixture_unwritten() -> None:
    """Collection happens fully before any write, so a broken `template` keeps
    the valid `theme` out of the store too."""
    sink = InMemoryStore()
    with pytest.raises(FixtureError) as info:
        seed_store_from_fixtures(
            seeding_loader('{"theme":{"$ref":"theme:missing"}}'),
            sink,
            {"theme": "themes", "template": "templates"},
        )
    assert str(info.value) == 'Fixture "template:page" failed validation before store seeding.'
    assert info.value.diagnostic["code"] == "seed-validation-failed"
    assert sink.list("themes") == []


def test_validation_can_be_turned_off_before_writing() -> None:
    sink = InMemoryStore()
    result = seed_store_from_fixtures(
        seeding_loader('{"theme":{"$ref":"theme:missing"}}'),
        sink,
        {"template": "templates"},
        validate_before_write=False,
    )
    assert [row["ref"] for row in result["written"]] == ["template:page"]


# ── A real file, two processes' worth of store handles ───────────────────


def test_fixtures_written_to_a_sqlite_file_load_from_a_second_handle(tmp_path: Path) -> None:
    """The thinnest real path: one `SqliteStore` writes the documents, a
    separate `SqliteStore` opened on the same file backs the fixture source."""
    database = tmp_path / "fixtures.sqlite"

    writer = SqliteStore(str(database))
    writer.put(
        "fx",
        {
            "id": "dark",
            "content": '{"name":"Dark","palette":{"bg":"#000"}}',
            "extension": ".json",
            "relativePath": "themes/dark.json",
        },
    )
    writer.close()

    reader = SqliteStore(str(database))
    try:
        source = StoreFixtureSource("st", reader, "fx")
        fixtures = loader(registry(THEME), [source])
        assert fixtures.list() == ["theme:dark"]
        assert fixtures.load("theme:dark") == {"name": "Dark", "palette": {"bg": "#000"}}

        sink = SqliteStore(str(database))
        try:
            seed_store_from_fixtures(fixtures, sink, {"theme": "themes"})
        finally:
            sink.close()
    finally:
        reader.close()

    verifier = SqliteStore(str(database))
    try:
        assert verifier.getById("themes", "dark") == {
            "id": "dark",
            "value": {"name": "Dark", "palette": {"bg": "#000"}},
        }
    finally:
        verifier.close()
