"""SQLite behaviors outside the corpus: persistence, pragmas, table naming."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from mirk.store import SqliteStore, hash_name


def test_hash_name_matches_the_known_typescript_values() -> None:
    assert hash_name("things") == "17yznec"
    assert hash_name("vecs") == "1t7xgde"
    assert hash_name("docs") == "bcq576"


def test_distinct_collections_never_alias_after_sanitizing() -> None:
    store = SqliteStore(":memory:")
    store.put("foo-bar", {"id": "x", "v": 1})
    store.put("foo_bar", {"id": "x", "v": 2})
    assert store.getById("foo-bar", "x")["v"] == 1
    assert store.getById("foo_bar", "x")["v"] == 2
    assert store.count("foo-bar") == 1
    assert store.count("foo_bar") == 1
    store.close()


def test_reopening_a_file_preserves_data(tmp_path: Path) -> None:
    path = str(tmp_path / "store.db")
    first = SqliteStore(path)
    first.set("greeting", {"hello": "world"})
    first.put("things", {"id": "t1", "n": 1})
    first.close()

    second = SqliteStore(path)
    assert second.get("greeting") == {"hello": "world"}
    assert second.list("things") == [{"id": "t1", "n": 1}]
    second.close()


def test_busy_timeout_and_journal_mode_are_set(tmp_path: Path) -> None:
    path = str(tmp_path / "store.db")
    store = SqliteStore(path, busy_timeout_ms=1234)
    connection = sqlite3.connect(path)
    try:
        assert store.busy_timeout_ms == 1234
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    finally:
        connection.close()
        store.close()


def test_writes_maintain_the_atomic_bookkeeping_rows(tmp_path: Path) -> None:
    path = str(tmp_path / "store.db")
    store = SqliteStore(path)
    store.set("k", 1)
    store.put("things", {"id": "t1"})
    store.close()

    connection = sqlite3.connect(path)
    try:
        rows = connection.execute(
            "SELECT kind, collection, target_key, version FROM _mirk_atomic_versions"
            " ORDER BY kind, target_key"
        ).fetchall()
        identity = connection.execute(
            "SELECT value FROM _mirk_atomic_identity WHERE id = 1"
        ).fetchone()[0]
        sequence = connection.execute(
            "SELECT value FROM _mirk_atomic_sequence WHERE id = 1"
        ).fetchone()[0]
    finally:
        connection.close()

    assert sequence == 2
    assert [row[:3] for row in rows] == [("key", "", "k"), ("record", "things", "t1")]
    assert [row[3] for row in rows] == [f"{identity}-v1", f"{identity}-v2"]


def test_removing_clears_the_version_row(tmp_path: Path) -> None:
    path = str(tmp_path / "store.db")
    store = SqliteStore(path)
    store.put("things", {"id": "t1"})
    assert store.remove("things", "t1") is True
    store.close()

    connection = sqlite3.connect(path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM _mirk_atomic_versions").fetchone()[0] == 0
    finally:
        connection.close()


def test_negative_busy_timeout_is_rejected() -> None:
    with pytest.raises(ValueError):
        SqliteStore(":memory:", busy_timeout_ms=-1)


def test_close_releases_the_connection() -> None:
    store = SqliteStore(":memory:")
    store.set("k", 1)
    store.close()
    with pytest.raises(sqlite3.ProgrammingError):
        store.get("k")
