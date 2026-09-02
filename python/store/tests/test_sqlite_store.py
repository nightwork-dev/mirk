"""SQLite behaviors outside the corpus: persistence, pragmas, table naming."""

from __future__ import annotations

import sqlite3
import threading
from pathlib import Path
from typing import Any

import pytest

from mirk.store import SqliteStore, hash_name
from mirk.store.sqlite import (
    REGISTRY_TABLE,
    is_table_registry_conflict,
    legacy_collection_table,
)


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


# ── Regressions from the 2026-09-01 review ───────────────────────────────────


def test_a_supplied_default_connection_can_write() -> None:
    """P1-1: the store takes over transaction semantics on a caller's connection.

    A stdlib connection opened with the default ``isolation_level`` starts an
    implicit transaction on the bootstrap DML, and the first ``BEGIN IMMEDIATE``
    then raised ``cannot start a transaction within a transaction``.
    """
    connection = sqlite3.connect(":memory:")
    try:
        store = SqliteStore(":memory:", connection=connection)
        store.set("k", 1)
        store.put("c", {"id": "a", "v": 2})
        assert store.get("k") == 1
        assert store.getById("c", "a") == {"id": "a", "v": 2}
        assert connection.isolation_level is None
        assert connection.in_transaction is False
    finally:
        connection.close()


def test_a_supplied_connection_keeps_the_callers_pending_work() -> None:
    """P1-1: taking over autocommit commits what the caller had open."""
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute("CREATE TABLE caller (a)")
        connection.execute("INSERT INTO caller VALUES (1)")
        assert connection.in_transaction is True
        SqliteStore(":memory:", connection=connection)
        assert connection.execute("SELECT COUNT(*) FROM caller").fetchone()[0] == 1
    finally:
        connection.close()


def test_the_store_is_thread_affine() -> None:
    """P1-2: one connection per thread; a second thread is refused loudly.

    The adapter used to pass ``check_same_thread=False`` with no mutex, so a
    concurrent writer interleaved with an open ``BEGIN IMMEDIATE`` and lost rows
    instead of raising.
    """
    store = SqliteStore(":memory:")
    failures: list[BaseException] = []

    def write() -> None:
        try:
            store.put("c", {"id": "other-thread"})
        except BaseException as exc:
            failures.append(exc)

    thread = threading.Thread(target=write)
    thread.start()
    thread.join()
    store.close()

    assert len(failures) == 1
    assert isinstance(failures[0], sqlite3.ProgrammingError)
    assert "same thread" in str(failures[0])


# ── Physical table registry (MR-21) ──────────────────────────────────────────
# "%$;**@" and "~,~$(*" sanitize to the same six underscores and share the FNV
# hash "jqoxun", so the pre-registry name aliased them onto one table.
COLLIDING_A = "%$;**@"
COLLIDING_B = "~,~$(*"
COLLIDING_TABLE = "c________jqoxun"


def test_hash_colliding_collections_stay_independent(tmp_path: Path) -> None:
    path = str(tmp_path / "collide.db")
    store = SqliteStore(path)
    try:
        assert legacy_collection_table(COLLIDING_A) == COLLIDING_TABLE
        assert legacy_collection_table(COLLIDING_B) == COLLIDING_TABLE
        store.put(COLLIDING_A, {"id": "x", "which": "a"})
        store.put(COLLIDING_B, {"id": "x", "which": "b"})
        assert store.getById(COLLIDING_A, "x") == {"id": "x", "which": "a"}
        assert store.getById(COLLIDING_B, "x") == {"id": "x", "which": "b"}
        assert store.count(COLLIDING_A) == 1
        assert store.count(COLLIDING_B) == 1
        recorded = dict(
            store.connection.execute(
                "SELECT name, table_name FROM _mirk_tables WHERE kind = 'collection'"
            ).fetchall()
        )
        assert recorded == {
            COLLIDING_A: COLLIDING_TABLE,
            COLLIDING_B: f"{COLLIDING_TABLE}_2",
        }
    finally:
        store.close()


def test_the_registry_survives_a_reopen_in_the_other_order(tmp_path: Path) -> None:
    """Whoever claimed the unsuffixed table keeps it, whatever order the next process uses."""
    path = str(tmp_path / "collide.db")
    first = SqliteStore(path)
    first.put(COLLIDING_A, {"id": "x", "which": "a"})
    first.put(COLLIDING_B, {"id": "x", "which": "b"})
    first.close()

    second = SqliteStore(path)
    try:
        assert second.getById(COLLIDING_B, "x") == {"id": "x", "which": "b"}
        assert second.getById(COLLIDING_A, "x") == {"id": "x", "which": "a"}
        rows = second.connection.execute(
            "SELECT name, table_name FROM _mirk_tables WHERE kind = 'collection' ORDER BY name"
        ).fetchall()
        assert sorted(rows) == sorted(
            [(COLLIDING_A, COLLIDING_TABLE), (COLLIDING_B, f"{COLLIDING_TABLE}_2")]
        )
    finally:
        second.close()


def _write_legacy_file(path: str) -> None:
    """A pre-MR-21 file: the bootstrap tables and a hashed collection table, no registry."""
    connection = sqlite3.connect(path, isolation_level=None)
    try:
        connection.executescript(
            """
            CREATE TABLE _kv (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              created_at TEXT DEFAULT (datetime('now')),
              updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE _mirk_atomic_versions (
              kind TEXT NOT NULL, collection TEXT NOT NULL, target_key TEXT NOT NULL,
              version TEXT NOT NULL, PRIMARY KEY (kind, collection, target_key)
            );
            CREATE TABLE _mirk_atomic_sequence (
              id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL
            );
            CREATE TABLE _mirk_atomic_receipts (
              idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
              result_json TEXT NOT NULL
            );
            CREATE TABLE _mirk_atomic_identity (
              id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL
            );
            CREATE TABLE c_things_17yznec (
              id TEXT PRIMARY KEY,
              data JSON NOT NULL,
              created_at TEXT DEFAULT (datetime('now')),
              updated_at TEXT DEFAULT (datetime('now'))
            );
            INSERT INTO _mirk_atomic_sequence (id, value) VALUES (1, 1);
            INSERT INTO _mirk_atomic_identity (id, value) VALUES (1, 'legacy-identity');
            INSERT INTO _kv (key, value) VALUES ('greeting', '{"hello":"legacy"}');
            INSERT INTO c_things_17yznec (id, data)
              VALUES ('t1', '{"id":"t1","n":1}'), ('t2', '{"id":"t2","n":2}');
            """
        )
    finally:
        connection.close()


def test_a_legacy_file_is_read_and_its_table_adopted(tmp_path: Path) -> None:
    path = str(tmp_path / "legacy.db")
    _write_legacy_file(path)

    store = SqliteStore(path)
    try:
        assert store.get("greeting") == {"hello": "legacy"}
        assert store.list("things") == [{"id": "t1", "n": 1}, {"id": "t2", "n": 2}]
        row = store.connection.execute(
            "SELECT table_name FROM _mirk_tables WHERE kind = 'collection' AND name = 'things'"
        ).fetchone()
        assert row is not None and row[0] == "c_things_17yznec"
        # Adoption is a rename-free upgrade: no second physical table appeared.
        tables = [
            name
            for (name,) in store.connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'c_things%'"
            )
        ]
        assert tables == ["c_things_17yznec"]
        store.put("things", {"id": "t3", "n": 3})
        assert store.count("things") == 3
    finally:
        store.close()


def test_a_legacy_file_stamps_the_current_schema_version(tmp_path: Path) -> None:
    path = str(tmp_path / "legacy.db")
    _write_legacy_file(path)
    store = SqliteStore(path)
    try:
        row = store.connection.execute(
            "SELECT value FROM _mirk_meta WHERE key = 'schema_version'"
        ).fetchone()
        assert row is not None and row[0] == "2"
    finally:
        store.close()


def test_a_file_from_a_newer_adapter_is_refused(tmp_path: Path) -> None:
    path = str(tmp_path / "future.db")
    SqliteStore(path).close()
    connection = sqlite3.connect(path, isolation_level=None)
    connection.execute("UPDATE _mirk_meta SET value = '3' WHERE key = 'schema_version'")
    connection.close()

    with pytest.raises(ValueError) as caught:
        SqliteStore(path)
    assert str(caught.value) == (
        "Mirk SQLite file schema version 3 is newer than this adapter understands (2)."
    )


def test_an_unclaimed_table_on_a_suffixed_candidate_is_skipped(tmp_path: Path) -> None:
    """Only the exact legacy name is ever adopted; a suffixed candidate must be free.

    A stray table sitting on ``<legacy>_2`` would otherwise be picked up by
    ``CREATE TABLE IF NOT EXISTS`` and read as the second collection's rows.
    """
    path = str(tmp_path / "occupied.db")
    first = SqliteStore(path)
    first.put(COLLIDING_A, {"id": "x", "which": "a"})
    first.close()

    squatter = f"{COLLIDING_TABLE}_2"
    connection = sqlite3.connect(path, isolation_level=None)
    # The same shape a collection table has, so a wrong resolution reads as data
    # rather than as a missing column.
    connection.execute(
        f"""CREATE TABLE {squatter} (
          id TEXT PRIMARY KEY,
          data JSON NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )"""
    )
    connection.execute(
        f"INSERT INTO {squatter} (id, data) VALUES ('foreign', '{{\"id\":\"foreign\"}}')"
    )
    connection.close()

    store = SqliteStore(path)
    try:
        store.put(COLLIDING_B, {"id": "x", "which": "b"})
        assert store.getById(COLLIDING_A, "x") == {"id": "x", "which": "a"}
        assert store.getById(COLLIDING_B, "x") == {"id": "x", "which": "b"}
        assert store.count(COLLIDING_B) == 1
        row = store.connection.execute(
            "SELECT table_name FROM _mirk_tables WHERE kind = 'collection' AND name = ?",
            (COLLIDING_B,),
        ).fetchone()
        assert row is not None and row[0] == f"{COLLIDING_TABLE}_3"
        # The squatter kept its own row and gained none.
        assert store.connection.execute(f"SELECT id FROM {squatter}").fetchall() == [("foreign",)]
    finally:
        store.close()


def test_losing_the_race_to_register_re_reads_the_registry_and_uses_the_winners_table(
    tmp_path: Path,
) -> None:
    """Two connections resolving the same NEW logical name at once: both miss the
    registry, both pick the same candidate, one INSERT wins and the other violates
    the primary key. The loser must not surface that from an ordinary ``put`` —
    it restarts resolution, finds the winner's row as a registry hit, and adopts
    the winner's table.

    The interleaving is forced: the loser's connection is a ``sqlite3.Connection``
    subclass whose FIRST ``INSERT INTO _mirk_tables`` is preceded by the winner's
    insert, table creation, and row, committed from a separate connection on the
    same file — the same seam the TypeScript race test uses.
    """
    name = "race"
    legacy = legacy_collection_table(name)
    path = str(tmp_path / "race.db")
    SqliteStore(path).close()

    insert_sql = f"INSERT INTO {REGISTRY_TABLE} (kind, name, table_name) VALUES (?, ?, ?)"
    winner = sqlite3.connect(path, isolation_level=None)
    fired = False

    class InterceptingConnection(sqlite3.Connection):
        def execute(self, sql: str, parameters: Any = (), /) -> sqlite3.Cursor:
            nonlocal fired
            if not fired and sql == insert_sql:
                fired = True
                winner.execute(insert_sql, ("collection", name, legacy))
                winner.execute(
                    f"""CREATE TABLE IF NOT EXISTS {legacy} (
                      id TEXT PRIMARY KEY,
                      data JSON NOT NULL,
                      created_at TEXT DEFAULT (datetime('now')),
                      updated_at TEXT DEFAULT (datetime('now')))"""
                )
                winner.execute(
                    f"INSERT INTO {legacy} (id, data) VALUES (?, ?)",
                    ("w1", '{"id":"w1","tag":"winner"}'),
                )
            return super().execute(sql, parameters)

    loser_connection = sqlite3.connect(path, isolation_level=None, factory=InterceptingConnection)
    loser = SqliteStore(path, connection=loser_connection)
    try:
        loser.put(name, {"id": "l1", "tag": "loser"})
        assert fired is True
        assert loser.getById(name, "w1") == {"id": "w1", "tag": "winner"}
        assert loser.getById(name, "l1") == {"id": "l1", "tag": "loser"}
        rows = loser_connection.execute(
            "SELECT table_name FROM _mirk_tables WHERE kind = 'collection' AND name = ?",
            (name,),
        ).fetchall()
        # Exactly one row for the name, and it is the winner's table — the loser
        # recorded no row of its own.
        assert rows == [(legacy,)]
    finally:
        loser.close()
        winner.close()


def test_is_table_registry_conflict_matches_real_constraint_errors(tmp_path: Path) -> None:
    """The predicate fires on both shapes of ``_mirk_tables`` constraint violation
    and stays False for an unrelated locking error.
    """
    connection = sqlite3.connect(":memory:")
    try:
        connection.execute(
            f"""CREATE TABLE {REGISTRY_TABLE} (
              kind TEXT NOT NULL,
              name TEXT NOT NULL,
              table_name TEXT NOT NULL UNIQUE,
              PRIMARY KEY (kind, name)
            )"""
        )
        connection.execute(
            f"INSERT INTO {REGISTRY_TABLE} (kind, name, table_name) VALUES (?, ?, ?)",
            ("collection", "a", "t1"),
        )
        with pytest.raises(sqlite3.IntegrityError) as pk_violation:
            connection.execute(
                f"INSERT INTO {REGISTRY_TABLE} (kind, name, table_name) VALUES (?, ?, ?)",
                ("collection", "a", "t2"),
            )
        assert is_table_registry_conflict(pk_violation.value) is True

        with pytest.raises(sqlite3.IntegrityError) as unique_violation:
            connection.execute(
                f"INSERT INTO {REGISTRY_TABLE} (kind, name, table_name) VALUES (?, ?, ?)",
                ("collection", "b", "t1"),
            )
        assert is_table_registry_conflict(unique_violation.value) is True
    finally:
        connection.close()

    locked_path = str(tmp_path / "locked.db")
    holder = sqlite3.connect(locked_path, isolation_level=None)
    holder.execute("CREATE TABLE t (a)")
    holder.execute("BEGIN IMMEDIATE")
    holder.execute("INSERT INTO t VALUES (1)")
    contender = sqlite3.connect(locked_path, isolation_level=None, timeout=0)
    try:
        with pytest.raises(sqlite3.OperationalError) as locked:
            contender.execute("BEGIN IMMEDIATE")
            contender.execute("INSERT INTO t VALUES (2)")
        assert "database is locked" in str(locked.value)
        assert is_table_registry_conflict(locked.value) is False
    finally:
        holder.execute("ROLLBACK")
        holder.close()
        contender.close()
