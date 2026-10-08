from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, cast

import pytest

from mirk.store_markdown import MarkdownStore, MarkdownStoreCorruptionError, MarkdownStoreError


def test_kv_collections_filters_and_code_point_order(tmp_path: Path) -> None:
    store = MarkdownStore(tmp_path)
    store.set("settings/theme", {"mode": "dark"})
    assert store.get("settings/theme") == {"mode": "dark"}
    assert store.keys("settings/") == ["settings/theme"]
    for item in [
        {"id": "a", "group": "a", "rank": 3},
        {"id": "B", "group": "a", "rank": 1},
        {"id": "é", "group": "b", "rank": 2},
    ]:
        store.put("things", item)
    assert [item["id"] for item in store.list("things")] == ["B", "a", "é"]
    assert store.list("things", {"where": {"group": "a"}, "sortBy": "rank"})[0]["id"] == "B"
    assert store.count("things", {"where": {"group": "a"}}) == 2
    assert store.remove("things", "é") is True
    assert store.remove("things", "é") is False


def _story_store(root: Path, git: bool = False) -> MarkdownStore:
    return MarkdownStore(
        root,
        git=git,
        collections={
            "stories": {
                "directory": "stories",
                "frontmatterFields": ["title", "status"],
                "fileName": lambda item: f"{str(item['title']).lower().replace(' ', '-')}.md",
                "body": {
                    "preambleField": "intent",
                    "sections": {
                        "acceptanceCriteria": {
                            "heading": "Acceptance criteria",
                            "parse": lambda text: [
                                line[6:] for line in text.splitlines() if line.startswith("- [ ] ")
                            ],
                            "stringify": lambda values: "\n".join(
                                f"- [ ] {value}" for value in cast(list[Any], values or [])
                            ),
                        }
                    },
                },
                "index": {
                    "heading": "Roadmap",
                    "renderLine": lambda item: (
                        f"- {item['id']} · {item['title']} · {item['status']}"
                    ),
                },
            }
        },
    )


def test_round_trip_preserves_unknown_frontmatter_sections_and_sticky_filename(
    tmp_path: Path,
) -> None:
    store = _story_store(tmp_path)
    store.put(
        "stories",
        {
            "id": "DOC-101",
            "title": "Markdown Store",
            "status": "todo",
            "intent": "Canonical persistence.",
            "acceptanceCriteria": ["Files remain editable"],
        },
    )
    path = tmp_path / "stories" / "markdown-store.md"
    raw = path.read_text()
    path.write_text(
        raw.replace("status: todo", "status: in-progress\nexternalOwner: reviewer").replace(
            "Canonical persistence.", "Edited by hand."
        )
        + "\n## Operator notes\n\nKeep this exact prose.\n"
    )
    assert store.getById("stories", "DOC-101")["externalOwner"] == "reviewer"
    store.put(
        "stories",
        {
            "id": "DOC-101",
            "title": "Renamed title",
            "status": "done",
            "intent": "Edited by hand.",
            "acceptanceCriteria": ["Still lossless"],
        },
    )
    assert path.exists()
    updated = path.read_text()
    assert "externalOwner: reviewer" in updated
    assert "## Operator notes\n\nKeep this exact prose." in updated
    assert "- [ ] Still lossless" in updated
    assert "DOC-101 · Renamed title · done" in (tmp_path / "stories" / "INDEX.md").read_text()


def test_yaml_12_and_live_disk_reads(tmp_path: Path) -> None:
    store = MarkdownStore(tmp_path)
    path = tmp_path / "things" / "one.md"
    path.parent.mkdir()
    path.write_text("---\nid: one\nyes: yes\ntruth: true\n---\n")
    assert store.getById("things", "one")["yes"] == "yes"
    assert store.getById("things", "one")["truth"] is True
    path.write_text("---\nid: one\nyes: changed\ntruth: false\n---\n")
    assert store.getById("things", "one")["yes"] == "changed"


def test_yaml_scalars_and_empty_keys_match_typescript_rules(tmp_path: Path) -> None:
    store = MarkdownStore(tmp_path)
    path = tmp_path / "things" / "one.md"
    path.parent.mkdir()
    path.write_text("---\nid: one\ndate: 2024-01-02\ncount: 1_000\ntruth: true\n---\n")
    item = store.getById("things", "one")
    assert item["date"] == "2024-01-02"
    assert item["count"] == "1_000"
    assert item["truth"] is True
    with pytest.raises(MarkdownStoreError) as caught:
        store.set("", "invalid")
    assert caught.value.code == "invalid-record-id"
    path.write_bytes(b"---\r\nid: one\r\n---\r\n")
    with pytest.raises(MarkdownStoreError) as crlf:
        store.getById("things", "one")
    assert crlf.value.code == "missing-frontmatter-open"


def test_corruption_is_aggregated_and_filename_collisions_are_safe(tmp_path: Path) -> None:
    store = _story_store(tmp_path)
    store.put(
        "stories",
        {
            "id": "DOC-101",
            "title": "Same",
            "status": "todo",
            "intent": "x",
            "acceptanceCriteria": [],
        },
    )
    (tmp_path / "stories" / "broken.md").write_text("not frontmatter\n")
    (tmp_path / "stories" / "also-broken.md").write_text("---\nid: [\n---\n")
    with pytest.raises(MarkdownStoreCorruptionError) as caught:
        store.list("stories")
    assert len(caught.value.errors) == 2
    (tmp_path / "stories" / "broken.md").unlink()
    (tmp_path / "stories" / "also-broken.md").unlink()
    with pytest.raises(MarkdownStoreError) as collision:
        store.put(
            "stories",
            {
                "id": "DOC-102",
                "title": "Same",
                "status": "todo",
                "intent": "x",
                "acceptanceCriteria": [],
            },
        )
    assert collision.value.code == "filename-collision"


def test_index_filename_is_safe_and_reserved_before_record_writes(tmp_path: Path) -> None:
    invalid = MarkdownStore(
        tmp_path / "invalid",
        collections={
            "things": {"index": {"fileName": "../outside.md", "renderLine": lambda item: ""}}
        },
    )
    with pytest.raises(MarkdownStoreError) as escaped:
        invalid.put("things", {"id": "one"})
    assert escaped.value.code == "unsafe-filename"
    assert not (tmp_path / "invalid" / "things").exists()

    store = MarkdownStore(
        tmp_path / "reserved",
        collections={
            "things": {"index": {"fileName": "catalog.md", "renderLine": lambda item: ""}}
        },
    )
    with pytest.raises(MarkdownStoreError) as reserved:
        store.put("things", {"id": "catalog"})
    assert reserved.value.code == "unsafe-filename"
    store.put("things", {"id": "one"})
    before = (tmp_path / "reserved" / "things" / "catalog.md").read_text()
    with pytest.raises(MarkdownStoreError):
        store.put("things", {"id": "catalog"})
    assert (tmp_path / "reserved" / "things" / "catalog.md").read_text() == before


def test_existing_record_at_new_index_destination_is_not_overwritten(tmp_path: Path) -> None:
    MarkdownStore(tmp_path).put("things", {"id": "catalog", "value": "original"})
    path = tmp_path / "things" / "catalog.md"
    before = path.read_bytes()
    reopened = MarkdownStore(
        tmp_path,
        collections={
            "things": {"index": {"fileName": "catalog.md", "renderLine": lambda item: ""}}
        },
    )
    with pytest.raises(MarkdownStoreError) as caught:
        reopened.put("things", {"id": "new", "value": "replacement"})
    assert caught.value.code == "filename-collision"
    assert path.read_bytes() == before
    assert reopened.getById("things", "new") is None


def test_directory_listing_skips_symlinked_markdown(tmp_path: Path) -> None:
    store = MarkdownStore(tmp_path)
    outside = tmp_path.parent / f"markdown-outside-{tmp_path.name}"
    outside.mkdir()
    (outside / "valid.md").write_text("---\nid: outside\n---\n")
    directory = tmp_path / "things"
    directory.mkdir()
    (directory / "link.md").symlink_to(outside / "valid.md")
    assert store.list("things") == []


def test_filter_objects_use_identity_like_typescript_strict_equality(tmp_path: Path) -> None:
    store = MarkdownStore(tmp_path)
    store.put("things", {"id": "one", "value": {"nested": True}})
    assert store.list("things", {"where": {"value": {"nested": True}}}) == []


def test_filename_aliases_are_reserved_conservatively(tmp_path: Path) -> None:
    store = MarkdownStore(
        tmp_path,
        collections={"things": {"fileName": lambda item: f"{item['name']}.md"}},
    )
    for first, second in [("Catalog", "catalog"), ("ß", "ss"), ("e\u0301", "é")]:
        store.put("things", {"id": first, "name": first})
        with pytest.raises(MarkdownStoreError) as caught:
            store.put("things", {"id": second, "name": second})
        assert caught.value.code == "filename-collision"
    kv = MarkdownStore(tmp_path / "kv")
    kv.set("Catalog", "first")
    with pytest.raises(MarkdownStoreError) as caught:
        kv.set("catalog", "second")
    assert caught.value.code == "filename-collision"


def test_atomic_write_rejects_symlink_escape_and_body_type_errors(tmp_path: Path) -> None:
    store = MarkdownStore(tmp_path)
    outside = tmp_path.parent / f"outside-{tmp_path.name}"
    outside.mkdir()
    (tmp_path / "escape").symlink_to(outside, target_is_directory=True)
    with pytest.raises(MarkdownStoreError) as caught:
        store.put("escape", {"id": "one", "value": "x"})
    assert caught.value.code == "path-escapes-root"
    body_store = MarkdownStore(tmp_path / "body", collections={"docs": {"body": {"field": "body"}}})
    with pytest.raises(MarkdownStoreError) as body_error:
        body_store.put("docs", {"id": "one", "body": 42})
    assert body_error.value.code == "non-string-body"


def test_git_history_is_optional_and_mutation_failure_is_non_fatal(tmp_path: Path) -> None:
    store = MarkdownStore(tmp_path, git=True)
    store.put("things", {"id": "one", "value": "a"})
    store.put("things", {"id": "one", "value": "b"})
    count = subprocess.check_output(
        ["git", "-C", str(tmp_path), "rev-list", "--count", "HEAD"], text=True
    ).strip()
    assert count == "2"
    assert "value: a" in subprocess.check_output(
        ["git", "-C", str(tmp_path), "show", "HEAD~1:things/one.md"], text=True
    )


def test_git_commit_only_preserves_unrelated_staged_work(tmp_path: Path) -> None:
    subprocess.run(["git", "-C", str(tmp_path), "init"], check=True, capture_output=True)
    (tmp_path / "unrelated.txt").write_text("keep staged")
    subprocess.run(["git", "-C", str(tmp_path), "add", "--", "unrelated.txt"], check=True)
    store = MarkdownStore(tmp_path, git=True)
    store.set("key", "value")
    status = subprocess.check_output(["git", "-C", str(tmp_path), "status", "--short"], text=True)
    assert "A  unrelated.txt" in status
    committed = subprocess.check_output(
        ["git", "-C", str(tmp_path), "show", "--name-only", "--format=", "HEAD"], text=True
    )
    assert ".mirk-kv/key.md" in committed
    assert "unrelated.txt" not in committed
