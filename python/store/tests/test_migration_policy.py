"""Migration admission and locked preimage snapshots."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from mirk.store.sqlite import SqliteAdapterError, SqliteStore, migrate_sqlite
from mirk.store.sqlite_registry import ensure_registry
from mirk.store.sqlite_vector import SqliteVectorFacet


def legacy(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, isolation_level=None)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.executescript("""
    CREATE TABLE _mirk_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO _mirk_meta VALUES('schema_version','2');
    CREATE TABLE _mirk_tables(kind TEXT,name TEXT,table_name TEXT UNIQUE,PRIMARY KEY(kind,name));
    CREATE TABLE vectors(collection TEXT,id TEXT,vec BLOB,metadata TEXT,PRIMARY KEY(collection,id));
    INSERT INTO vectors VALUES('assets','a',X'0000803f00000000',NULL);
    CREATE TABLE _vec_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO _vec_meta VALUES('dimensions','2');
    CREATE TABLE app(value TEXT);INSERT INTO app VALUES('WAL preimage');
    CREATE TABLE _mirk_atomic_receipts(idempotency_key TEXT PRIMARY KEY,
      request_digest TEXT,result_json TEXT);
    INSERT INTO _mirk_atomic_receipts VALUES('r','digest','{}');
    """)
    return connection


@pytest.mark.parametrize("policy", ["explicit", "refuse"])
def test_older_refusal_and_empty_file_initialization(tmp_path: Path, policy: str) -> None:
    path = tmp_path / "old.db"
    connection = legacy(path)
    schema = connection.execute("SELECT name,sql FROM sqlite_master ORDER BY name").fetchall()
    with pytest.raises(SqliteAdapterError) as caught:
        SqliteStore(str(path), migration=policy)
    assert caught.value.code == (
        "migration-required" if policy == "explicit" else "migration-refused"
    )
    assert (
        connection.execute("SELECT name,sql FROM sqlite_master ORDER BY name").fetchall() == schema
    )
    assert connection.execute("SELECT value FROM _mirk_meta").fetchone()[0] == "2"
    connection.close()
    empty = tmp_path / "new.db"
    SqliteStore(str(empty), migration=policy).close()
    assert migrate_sqlite(str(empty)) == {"fromVersion": 4, "toVersion": 4, "changed": False}


def test_wal_backup_and_nondefault_space(tmp_path: Path) -> None:
    path, backup = tmp_path / "old.db", tmp_path / "backup.db"
    connection = legacy(path)
    assert Path(str(path) + "-wal").exists()
    assert migrate_sqlite(str(path), backup_path=str(backup), legacy_vector_space="text-v1") == {
        "fromVersion": 2,
        "toVersion": 4,
        "changed": True,
        "backupPath": str(backup),
    }
    snapshot = sqlite3.connect(backup)
    assert snapshot.execute("SELECT value FROM app").fetchone()[0] == "WAL preimage"
    assert snapshot.execute("SELECT value FROM _mirk_meta").fetchone()[0] == "2"
    assert snapshot.execute("SELECT hex(vec) FROM vectors").fetchone()[0] == "0000803F00000000"
    snapshot.close()
    store = SqliteStore(str(path), migration="refuse", legacy_vector_space="ignored")
    facet = SqliteVectorFacet(store.connection)
    assert facet.listSpaces()[0]["name"] == "text-v1"
    assert facet.get("assets", "a") == {"id": "a", "vectors": {"text-v1": [1.0, 0.0]}}
    assert facet.search("assets", {"space": "text-v1", "vector": [1.0, 0.0]})[0]["id"] == "a"
    assert "created_at" in {
        row[1] for row in store.connection.execute("PRAGMA table_info(_mirk_atomic_receipts)")
    }
    store.close()
    assert migrate_sqlite(str(path), backup_path=str(backup))["changed"] is False
    connection.close()


def test_backup_failure_and_existing_destination_do_not_migrate(tmp_path: Path) -> None:
    path, backup = tmp_path / "old.db", tmp_path / "backup.db"
    connection = legacy(path)
    backup.write_text("keep this file")
    for destination in (backup, tmp_path / "missing" / "backup.db"):
        with pytest.raises(SqliteAdapterError) as caught:
            migrate_sqlite(str(path), backup_path=str(destination))
        assert caught.value.code == "backup-failed"
        assert connection.execute("SELECT value FROM _mirk_meta").fetchone()[0] == "2"
    assert backup.read_text() == "keep this file"
    connection.close()


def test_readonly_and_future_files_never_migrate(tmp_path: Path) -> None:
    path, backup = tmp_path / "old.db", tmp_path / "backup.db"
    connection = legacy(path)
    readonly = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, isolation_level=None)
    with pytest.raises(SqliteAdapterError) as caught:
        ensure_registry(readonly, backup_path=str(backup))
    assert caught.value.code == "migration-required"
    assert not backup.exists()
    readonly.close()
    connection.execute("UPDATE _mirk_meta SET value='999'")
    with pytest.raises(SqliteAdapterError) as caught:
        migrate_sqlite(str(path), backup_path=str(backup))
    assert caught.value.code == "unsupported-schema-version"
    assert not backup.exists()
    assert connection.execute("SELECT value FROM _mirk_meta").fetchone()[0] == "999"
    connection.close()


def test_explicit_migration_honors_refusal_pin(tmp_path: Path) -> None:
    path = tmp_path / "old.db"
    legacy(path).close()
    with pytest.raises(SqliteAdapterError) as caught:
        migrate_sqlite(str(path), migration="refuse")
    assert caught.value.code == "migration-refused"
    assert migrate_sqlite(str(path), migration="explicit") == {
        "fromVersion": 2,
        "toVersion": 4,
        "changed": True,
    }


def test_backup_holds_writer_admission(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from mirk.store import sqlite_registry

    path, backup = tmp_path / "old.db", tmp_path / "backup.db"
    legacy(path).close()
    snapshot = sqlite_registry.snapshot

    def competing_writer(connection: sqlite3.Connection, destination: str) -> None:
        contender = sqlite3.connect(path, isolation_level=None, timeout=0)
        try:
            with pytest.raises(sqlite3.OperationalError, match="locked"):
                contender.execute("UPDATE app SET value='raced'")
        finally:
            contender.close()
        snapshot(connection, destination)

    monkeypatch.setattr(sqlite_registry, "snapshot", competing_writer)
    assert migrate_sqlite(str(path), backup_path=str(backup))["changed"]
    copy = sqlite3.connect(backup)
    assert copy.execute("SELECT value FROM app").fetchone()[0] == "WAL preimage"
    copy.close()


def test_current_format_does_not_self_repair_missing_receipt_columns(tmp_path: Path) -> None:
    path = tmp_path / "current.db"
    SqliteStore(str(path)).close()
    connection = sqlite3.connect(path, isolation_level=None)
    connection.execute("DROP INDEX _mirk_atomic_receipts_created_at")
    connection.execute("ALTER TABLE _mirk_atomic_receipts DROP COLUMN created_at")
    with pytest.raises(SqliteAdapterError) as caught:
        SqliteStore(str(path))
    assert caught.value.code == "malformed-schema"
    assert "created_at" not in {
        row[1] for row in connection.execute("PRAGMA table_info(_mirk_atomic_receipts)")
    }
    connection.close()


def test_failed_upgrade_retains_successful_preimage_backup(tmp_path: Path) -> None:
    path, backup = tmp_path / "old.db", tmp_path / "backup.db"
    connection = legacy(path)
    connection.execute("""CREATE TRIGGER reject_version BEFORE UPDATE ON _mirk_meta
      BEGIN SELECT RAISE(ABORT,'migration failed'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="migration failed"):
        migrate_sqlite(str(path), backup_path=str(backup))
    assert connection.execute("SELECT value FROM _mirk_meta").fetchone()[0] == "2"
    assert connection.execute("SELECT COUNT(*) FROM vectors").fetchone()[0] == 1
    copy = sqlite3.connect(backup)
    assert copy.execute("SELECT value FROM _mirk_meta").fetchone()[0] == "2"
    assert copy.execute("SELECT COUNT(*) FROM vectors").fetchone()[0] == 1
    copy.close()
    connection.close()


def test_backup_rejects_an_existing_caller_transaction(tmp_path: Path) -> None:
    path, backup = tmp_path / "old.db", tmp_path / "backup.db"
    connection = legacy(path)
    connection.execute("BEGIN IMMEDIATE")
    connection.execute("UPDATE app SET value='uncommitted'")
    with pytest.raises(SqliteAdapterError) as caught:
        ensure_registry(connection, backup_path=str(backup))
    assert caught.value.code == "unsupported-backup"
    assert not backup.exists()
    assert connection.in_transaction
    assert connection.execute("SELECT value FROM app").fetchone()[0] == "uncommitted"
    connection.execute("ROLLBACK")
    connection.close()
