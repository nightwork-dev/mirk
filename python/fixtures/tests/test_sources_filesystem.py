"""The filesystem source, against real directories and real symlinks.

The rules port; the Node code does not. Ordering is the one deliberate change:
the TypeScript source sorted with `localeCompare`, which is ICU collation and
varies by runtime build, so the contract is Unicode code point order in both
languages and this suite pins it with names the two comparators disagree about.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from helpers import loader, passthrough, registry
from mirk.fixtures import FixtureError
from mirk.fixtures.sources.filesystem import FilesystemFixtureSource

THEME: dict[str, Any] = {"type": "theme", "directory": "themes", "schema": passthrough}


def write(root: Path, relative: str, content: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def test_nested_directories_are_walked_and_listed_in_path_order(tmp_path: Path) -> None:
    write(tmp_path, "themes/z.json", '{"v":"z"}')
    write(tmp_path, "themes/a.json", '{"v":"a"}')
    write(tmp_path, "themes/nested/ignored.json", "{}")

    source = FilesystemFixtureSource("fs", tmp_path)
    entries = source.list()
    assert [entry["relativePath"] for entry in entries] == [
        "themes/a.json",
        "themes/nested/ignored.json",
        "themes/z.json",
    ]
    assert source.read(entries[0]) == '{"v":"a"}'


def test_listing_order_is_code_point_not_locale_collation(tmp_path: Path) -> None:
    """`localeCompare` orders `a` before `Z`; code point order puts every
    uppercase name first. The port pins code point order. The names avoid a
    case-only pair because macOS filesystems are case-insensitive by default."""
    for name in ("a.json", "Z.json", "M.json", "_.json"):
        write(tmp_path, f"themes/{name}", "{}")
    entries = FilesystemFixtureSource("fs", tmp_path).list()
    assert [entry["relativePath"] for entry in entries] == [
        "themes/M.json",
        "themes/Z.json",
        "themes/_.json",
        "themes/a.json",
    ]


def test_reading_with_a_locator_the_source_did_not_issue_fails(tmp_path: Path) -> None:
    write(tmp_path, "themes/a.json", "{}")
    source = FilesystemFixtureSource("fs", tmp_path)
    source.list()
    with pytest.raises(FixtureError) as info:
        source.read({"relativePath": "themes/a.json", "locator": "entry:99"})
    assert str(info.value) == 'Filesystem source "fs" has no listed entry "themes/a.json".'
    assert info.value.diagnostic["code"] == "source-read-failed"


def test_a_locator_rebound_to_another_path_fails_closed(tmp_path: Path) -> None:
    write(tmp_path, "themes/a.json", '{"v":"a"}')
    write(tmp_path, "themes/b.json", '{"v":"b"}')
    source = FilesystemFixtureSource("fs", tmp_path)
    entries = source.list()
    with pytest.raises(FixtureError) as info:
        source.read({"relativePath": entries[1]["relativePath"], "locator": entries[0]["locator"]})
    assert info.value.diagnostic["code"] == "source-read-failed"


def test_a_symlink_pointing_outside_the_root_is_an_escape(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.json").write_text('{"secret":true}', encoding="utf-8")
    root = tmp_path / "root"
    (root / "themes").mkdir(parents=True)
    os.symlink(outside / "secret.json", root / "themes" / "leak.json")

    with pytest.raises(FixtureError) as info:
        FilesystemFixtureSource("fs", root).list()
    assert info.value.diagnostic["code"] == "source-path-escape"
    assert info.value.diagnostic.get("path") == "themes/leak.json"


def test_a_dangling_symlink_is_a_read_failure_wherever_it_points(tmp_path: Path) -> None:
    """Node's `realpathSync` throws before the root check runs, so a broken link
    is `source-read-failed` there even when it points outside the root. The
    existence check stands in that same place here."""
    root = tmp_path / "root"
    (root / "themes").mkdir(parents=True)
    os.symlink(tmp_path / "outside" / "gone.json", root / "themes" / "dangling.json")

    with pytest.raises(FixtureError) as info:
        FilesystemFixtureSource("fs", root).list()
    assert info.value.diagnostic["code"] == "source-read-failed"
    assert info.value.diagnostic.get("path") == "themes/dangling.json"


def test_bytes_that_are_not_utf8_become_replacement_characters(tmp_path: Path) -> None:
    """`readFileSync(path, "utf8")` substitutes U+FFFD rather than failing, so a
    file of invalid bytes must reach the parser here too."""
    theme = tmp_path / "themes"
    theme.mkdir(parents=True)
    (theme / "bad.json").write_bytes(b"{\xff}")

    source = FilesystemFixtureSource("fs", tmp_path)
    entries = source.list()
    assert source.read(entries[0]) == "{\ufffd}"


def test_a_symlinked_directory_is_not_descended_into(tmp_path: Path) -> None:
    real = tmp_path / "root" / "themes"
    real.mkdir(parents=True)
    (real / "a.json").write_text("{}", encoding="utf-8")
    inner = real / "inner"
    inner.mkdir()
    (inner / "b.json").write_text("{}", encoding="utf-8")
    os.symlink(inner, real / "linked")

    entries = FilesystemFixtureSource("fs", tmp_path / "root").list()
    assert [entry["relativePath"] for entry in entries] == [
        "themes/a.json",
        "themes/inner/b.json",
    ]


def test_an_unavailable_root_reports_without_naming_the_path(tmp_path: Path) -> None:
    missing = tmp_path / "not-there"
    with pytest.raises(FixtureError) as info:
        FilesystemFixtureSource("fs", missing)
    assert str(info.value) == ('Filesystem source "fs" root is unavailable or is not a directory.')
    assert str(missing) not in str(info.value)
    assert info.value.diagnostic["code"] == "source-root-unavailable"


def test_a_file_root_is_not_a_directory(tmp_path: Path) -> None:
    plain = tmp_path / "file.txt"
    plain.write_text("x", encoding="utf-8")
    with pytest.raises(FixtureError) as info:
        FilesystemFixtureSource("fs", plain)
    assert info.value.diagnostic["code"] == "source-root-unavailable"


def test_a_broken_symlink_is_an_error_not_a_silent_skip(tmp_path: Path) -> None:
    root = tmp_path / "root"
    (root / "themes").mkdir(parents=True)
    # Inside the root, so the containment check passes and the dangling
    # target is what fails.
    os.symlink(root / "themes" / "gone.json", root / "themes" / "dangling.json")
    with pytest.raises(FixtureError) as info:
        FilesystemFixtureSource("fs", root).list()
    assert info.value.diagnostic["code"] == "source-read-failed"
    assert "could not resolve entry" in str(info.value)


def test_the_loader_reads_fixtures_off_a_real_directory(tmp_path: Path) -> None:
    write(tmp_path, "themes/dark.json", '{"name":"Dark"}')
    write(tmp_path, "themes/light.json", '{"name":"Light"}')
    fixtures = loader(registry(THEME), [FilesystemFixtureSource("fs", tmp_path)])
    assert fixtures.list() == ["theme:dark", "theme:light"]
    assert fixtures.load("theme:dark") == {"name": "Dark"}


def test_a_file_replaced_between_list_and_read_fails_closed(tmp_path: Path) -> None:
    target = write(tmp_path, "themes/a.json", '{"v":1}')
    source = FilesystemFixtureSource("fs", tmp_path)
    entry = source.list()[0]
    target.unlink()
    with pytest.raises(FixtureError) as info:
        source.read(entry)
    assert info.value.diagnostic["code"] == "source-read-failed"
