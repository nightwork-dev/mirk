from __future__ import annotations

import json
import sqlite3
import subprocess
from pathlib import Path
from typing import Any

import pytest

from mirk.store import SqliteStore
from mirk.store.log import InMemoryLogStore, LogInputError, LogStore
from mirk.store.sqlite_log import SqliteLogFacet
from mirk.store.sqlite_log_format import migrate_log_generations


@pytest.fixture(params=["memory", "sqlite"])
def log(request: pytest.FixtureRequest, tmp_path: Path) -> Any:
    if request.param == "memory":
        yield InMemoryLogStore()
    else:
        with SqliteStore(str(tmp_path / "log.db")) as store:
            yield SqliteLogFacet(store)


def test_cursor_pages_are_bound_to_one_incarnation(log: LogStore) -> None:
    assert log.lastCursor("s") is None
    assert log.list("s") == []
    log.append("s", "one")
    log.append("s", "two")
    first = log.list("s", {"limit": 1})[0]
    assert first == {"generation": 1, "sequence": 1, "record": "one"}
    assert log.list("s", {"after": first}) == [{"generation": 1, "sequence": 2, "record": "two"}]
    log.append("other", "independent")
    assert log.lastCursor("other") == {"generation": 2, "sequence": 1}
    log.deleteStream("s")
    with pytest.raises(LogInputError) as deleted:
        log.list("s", {"after": first, "limit": 0})
    assert deleted.value.code == "stale-cursor"
    assert log.append("s", "replacement") == 1
    assert log.lastCursor("s") == {"generation": 3, "sequence": 1}
    for stream in ("s", "other", "missing"):
        with pytest.raises(LogInputError) as stale:
            log.list(stream, {"after": first})
        assert stale.value.code == "stale-cursor"
    invalid: Any = {"after": 1}
    with pytest.raises(LogInputError) as unsafe:
        log.list("s", invalid)
    assert unsafe.value.code == "invalid-cursor"


def test_memory_checkpoint_restores_epoch_and_stream_contents() -> None:
    log = InMemoryLogStore()
    log.append("s", "original")
    cursor = log.lastCursor("s")
    assert cursor is not None
    with pytest.raises(ValueError), log.transaction():
        log.deleteStream("s")
        log.append("s", "uncommitted replacement")
        log.append("new", "also uncommitted")
        raise ValueError()
    assert log.lastCursor("s") == cursor
    assert log.lastCursor("new") is None
    assert log.list("s", {"after": {**cursor, "sequence": 0}}) == [{**cursor, "record": "original"}]
    log.deleteStream("s")
    log.append("s", "committed replacement")
    with pytest.raises(LogInputError):
        log.list("s", {"after": cursor})


def test_sqlite_epoch_and_entries_use_the_same_snapshot(tmp_path: Path) -> None:
    path = str(tmp_path / "race.db")
    with SqliteStore(path) as first, SqliteStore(path) as second:
        reader, writer = SqliteLogFacet(first), SqliteLogFacet(second)
        reader.append("s", "original")
        cursor = reader.lastCursor("s")
        assert cursor is not None
        first.connection.execute("BEGIN")
        assert reader.lastCursor("s") == cursor
        replaced = False

        def replace_during_read() -> int:
            nonlocal replaced
            if not replaced:
                replaced = True
                writer.deleteStream("s")
                writer.append("s", "replacement")
            return 0

        first.connection.set_progress_handler(replace_during_read, 1)
        try:
            assert reader.list("s", {"after": {**cursor, "sequence": 0}}) == [
                {**cursor, "record": "original"}
            ]
        finally:
            first.connection.set_progress_handler(None, 0)
            first.connection.execute("ROLLBACK")
        assert replaced
        with pytest.raises(LogInputError):
            reader.list("s", {"after": cursor})


def test_format_fragment_assigns_binary_order_without_changing_records() -> None:
    db = sqlite3.connect(":memory:", isolation_level=None)
    try:
        db.execute(
            "CREATE TABLE _mirk_log (stream TEXT, sequence INTEGER, record TEXT, "
            "PRIMARY KEY(stream, sequence)) WITHOUT ROWID"
        )
        db.executemany(
            "INSERT INTO _mirk_log VALUES (?, ?, ?)",
            [("β", 1, '"greek"'), ("a", 1, '"lower"'), ("A", 1, '"upper"'), ("A", 2, '"second"')],
        )
        before = db.execute("SELECT * FROM _mirk_log ORDER BY stream, sequence").fetchall()
        db.execute("BEGIN IMMEDIATE")
        migrate_log_generations(db)
        db.execute("COMMIT")
        assert db.execute("SELECT * FROM _mirk_log ORDER BY stream, sequence").fetchall() == before
        assert db.execute("SELECT * FROM _mirk_log_streams ORDER BY stream").fetchall() == [
            ("A", 1),
            ("a", 2),
            ("β", 3),
        ]
        assert db.execute("SELECT value FROM _mirk_log_generation").fetchone()[0] == 3
    finally:
        db.close()


def test_typescript_and_python_continue_generations_in_one_file(tmp_path: Path) -> None:
    path = str(tmp_path / "exchange.db")
    with SqliteStore(path) as store:
        log = SqliteLogFacet(store)
        log.append("s", "python original")
        log.append("other", "independent")
        cursor = log.lastCursor("s")
    module = (
        Path(__file__).resolve().parents[3] / "packages/store/dist/adapters/node-sqlite.js"
    ).as_uri()
    script = f"""import {{NodeSqliteAdapter}} from {json.dumps(module)};
const db=new NodeSqliteAdapter({{path:process.argv[1]}});
const prior=db.log.lastCursor('s');
db.log.deleteStream('s');db.log.append('s','typescript replacement');
let stale;try{{db.log.list('s',{{after:prior}})}}catch(error){{stale=error.code}}
console.log(JSON.stringify({{cursor:db.log.lastCursor('s'),stale}}));db.close();"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script, path],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(result.stdout) == {
        "cursor": {"generation": 3, "sequence": 1},
        "stale": "stale-cursor",
    }
    with SqliteStore(path) as store:
        log = SqliteLogFacet(store)
        assert log.lastCursor("s") == {"generation": 3, "sequence": 1}
        assert log.get("s", 1) == {
            "generation": 3,
            "sequence": 1,
            "record": "typescript replacement",
        }
        assert cursor is not None
        with pytest.raises(LogInputError):
            log.list("s", {"after": cursor})
        log.deleteStream("s")
        log.append("s", "python successor")
    read = f"""import {{NodeSqliteAdapter}} from {json.dumps(module)};
const db=new NodeSqliteAdapter({{path:process.argv[1]}});
console.log(JSON.stringify(db.log.get('s',1)));db.close();"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", read, path],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(result.stdout) == {
        "generation": 4,
        "sequence": 1,
        "record": "python successor",
    }
