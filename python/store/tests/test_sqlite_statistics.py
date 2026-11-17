"""The SQLite store keeps query statistics fresh, as the TypeScript adapters do."""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from mirk.store import SqliteStore


def _hex(field: str) -> str:
    return field.encode("utf-8").hex()


def _load_links(store: SqliteStore, count: int) -> None:
    for field in ("from", "to", "type"):
        store.ensureIndex("links", field)
    for i in range(count):
        store.put(
            "links",
            {
                "id": f"l{i}",
                "from": f"r{i % 97}",
                "to": f"r{i}",
                "type": ("answers", "changes", "serves")[i % 3],
            },
        )


def _index_for(path: Path) -> str:
    """The index a fresh connection picks for the store's ``{ to, type }`` read."""
    connection = sqlite3.connect(path)
    try:
        (table,) = connection.execute(
            "SELECT table_name FROM _mirk_tables WHERE kind = 'collection' AND name = 'links'"
        ).fetchone()
        plan = connection.execute(
            f"EXPLAIN QUERY PLAN SELECT data FROM {table} WHERE "
            "json_extract(data, '$.\"to\"') = ? AND json_type(data, '$.\"to\"') = 'text' AND "
            "json_extract(data, '$.\"type\"') = ? AND json_type(data, '$.\"type\"') = 'text' "
            "ORDER BY rowid",
            ("r7", "answers"),
        ).fetchall()
        detail = " ".join(str(row[3]) for row in plan)
        if f"_{_hex('to')} " in detail:
            return "to"
        if f"_{_hex('type')} " in detail:
            return "type"
        return detail
    finally:
        connection.close()


def test_refreshes_after_a_bulk_load_so_a_two_field_filter_reads_the_selective_index(
    tmp_path: Path,
) -> None:
    path = tmp_path / "store.db"
    with SqliteStore(str(path)) as store:
        _load_links(store, 3_000)
        assert store.last_statistics_refresh is not None
        assert store.last_statistics_refresh.reason == "writes"
        assert _index_for(path) == "to"
        assert [
            link["id"] for link in store.list("links", {"where": {"to": "r7", "type": "changes"}})
        ] == ["l7"]


def test_refreshes_when_it_opens_a_file_that_has_none(tmp_path: Path) -> None:
    path = tmp_path / "store.db"
    with SqliteStore(str(path), refresh_statistics_after_changes=0) as writer:
        _load_links(writer, 3_000)
    assert _index_for(path) == "type"
    with SqliteStore(str(path)) as reader:
        assert reader.last_statistics_refresh is not None
        assert reader.last_statistics_refresh.reason == "open"
        assert _index_for(path) == "to"


def test_refresh_statistics_rebuilds_them_on_request(tmp_path: Path) -> None:
    path = tmp_path / "store.db"
    with SqliteStore(str(path), refresh_statistics_after_changes=0) as store:
        _load_links(store, 3_000)
        assert _index_for(path) == "type"
        refresh = store.refresh_statistics()
        assert refresh.reason == "request"
        assert any(table.startswith("c_links") for table in refresh.tables)
        assert _index_for(path) == "to"


def test_skips_an_automatic_refresh_without_waiting_while_another_connection_writes(
    tmp_path: Path,
) -> None:
    path = tmp_path / "store.db"
    store = SqliteStore(str(path), busy_timeout_ms=5_000)
    _load_links(store, 300)
    holder = sqlite3.connect(path, isolation_level=None)
    holder.execute("BEGIN IMMEDIATE")
    try:
        started = time.perf_counter()
        store.close()
        assert time.perf_counter() - started < 2
        assert store.last_statistics_refresh is not None
        assert store.last_statistics_refresh.reason == "close"
        assert store.last_statistics_refresh.skipped is not None
        assert "locked" in store.last_statistics_refresh.skipped
    finally:
        holder.execute("ROLLBACK")
        holder.close()


@pytest.mark.parametrize("value", [-1, 1.5, True])
def test_rejects_a_threshold_that_is_not_a_whole_number_of_rows(
    tmp_path: Path, value: object
) -> None:
    with pytest.raises(ValueError):
        SqliteStore(str(tmp_path / "store.db"), refresh_statistics_after_changes=value)  # type: ignore[arg-type]


def test_an_engine_older_than_3_46_gets_a_bounded_analyze_of_the_tables_that_need_it(
    tmp_path: Path,
) -> None:
    from mirk.store.sqlite_statistics import statistics_refresh

    path = tmp_path / "store.db"
    with SqliteStore(str(path), refresh_statistics_after_changes=0) as store:
        _load_links(store, 3_000)
    connection = sqlite3.connect(path, isolation_level=None)
    try:
        plan = statistics_refresh("3.45.1", "open", 0, 0)
        sql = next(plan)
        seen: list[str] = []
        try:
            while True:
                seen.append(sql)
                sql = plan.send(connection.execute(sql).fetchall())
        except StopIteration as done:
            tables, rows_described = done.value
        assert any(table.startswith("c_links") for table in tables)
        assert rows_described >= 3_000
        assert "PRAGMA analysis_limit = 1000" in seen
        assert connection.execute("PRAGMA analysis_limit").fetchone()[0] == 0
    finally:
        connection.close()
    assert _index_for(path) == "to"
