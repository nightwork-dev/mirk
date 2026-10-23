"""The log port in Python: JSON rules, atomicity, and rollback.

The exchange with TypeScript-written files lives in ``test_sqlite_compat.py``.
"""

from __future__ import annotations

import math
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from mirk.store import SqliteStore
from mirk.store.log import InMemoryLogStore, LogInputError, LogStore
from mirk.store.sqlite_log import SqliteLogFacet


def _expect_contiguous(log: LogStore, stream: str) -> None:
    last = log.lastSequence(stream)
    entries = log.list(stream)
    assert [entry["sequence"] for entry in entries] == list(range(1, last + 1))
    for entry in entries:
        assert log.get(stream, entry["sequence"]) == entry


@pytest.fixture(params=["memory", "sqlite"])
def log(request: pytest.FixtureRequest, tmp_path: Path) -> Any:
    if request.param == "memory":
        yield InMemoryLogStore()
        return
    store = SqliteStore(str(tmp_path / "log.sqlite"))
    yield SqliteLogFacet(store)
    store.close()


def test_records_json_cannot_carry_are_refused_and_consume_no_sequence(log: LogStore) -> None:
    log.append("s", {"ok": 1})
    for bad in (math.nan, (1, 2), {1: "int key"}, b"bytes", {"when": object()}):
        with pytest.raises(LogInputError) as raised:
            log.append("s", bad)
        assert raised.value.code == "invalid-record"
    with pytest.raises(LogInputError) as non_finite:
        log.append("s", math.inf)
    assert str(non_finite.value) == (
        "log record is not JSON-safe: non-finite numbers are not JSON-safe"
    )
    assert log.append("s", {"ok": 2}) == 2
    _expect_contiguous(log, "s")


def test_integral_floats_read_back_as_typescript_writes_them(log: LogStore) -> None:
    log.append("n", {"whole": 2.0, "half": 0.5})
    assert log.get("n", 1) == {"sequence": 1, "record": {"whole": 2, "half": 0.5}}


def test_a_failed_record_write_consumes_no_sequence(tmp_path: Path) -> None:
    with SqliteStore(str(tmp_path / "log.sqlite")) as store:
        log = SqliteLogFacet(store)
        store.connection.execute(
            """CREATE TRIGGER fail_record BEFORE INSERT ON _mirk_log
               WHEN NEW.record = '"boom"'
               BEGIN SELECT RAISE(ABORT, 'injected record failure'); END"""
        )
        assert log.append("s", "a") == 1
        with pytest.raises(sqlite3.IntegrityError, match="injected record failure"):
            log.append("s", "boom")
        assert log.lastSequence("s") == 1
        assert log.append("s", "b") == 2
        assert log.get("s", 2) == {"sequence": 2, "record": "b"}
        _expect_contiguous(log, "s")


def test_an_append_joins_an_open_transaction_and_its_sequence_is_reused(tmp_path: Path) -> None:
    with SqliteStore(str(tmp_path / "log.sqlite")) as store:
        log = SqliteLogFacet(store)
        log.append("s", "first")
        store.connection.execute("BEGIN IMMEDIATE")
        assert log.append("s", "rolled back") == 2
        store.connection.execute("ROLLBACK")
        assert log.lastSequence("s") == 1
        assert log.append("s", "second") == 2
        assert [entry["record"] for entry in log.list("s")] == ["first", "second"]


def test_memory_transaction_undoes_appends() -> None:
    log = InMemoryLogStore()
    log.append("s", "first")
    with pytest.raises(RuntimeError), log.transaction():
        assert log.append("s", "rolled back") == 2
        assert log.append("new", "rolled back") == 1
        raise RuntimeError("abort")
    assert log.lastSequence("s") == 1
    assert log.lastSequence("new") == 0
    assert log.append("s", "second") == 2
    with log.transaction():
        assert log.append("s", "kept") == 3
    _expect_contiguous(log, "s")


def test_two_connections_interleave_without_a_gap(tmp_path: Path) -> None:
    path = str(tmp_path / "log.sqlite")
    with SqliteStore(path) as first, SqliteStore(path) as second:
        logs = (SqliteLogFacet(first), SqliteLogFacet(second))
        given = [logs[index % 2].append("s", index) for index in range(50)]
        assert given == list(range(1, 51))
        _expect_contiguous(logs[0], "s")
