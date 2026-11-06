"""SQLite format admission, migration policy and consistent snapshots."""

from __future__ import annotations

import os
import re
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Literal, NotRequired, TypedDict

SqliteAdapterErrorCode = Literal[
    "unsupported-schema-version",
    "invalid-busy-timeout",
    "malformed-schema",
    "migration-required",
    "migration-refused",
    "unsupported-backup",
    "backup-failed",
]


class SqliteAdapterError(ValueError):
    """Raised when a SQLite file or adapter option cannot be used."""

    def __init__(self, code: SqliteAdapterErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: SqliteAdapterErrorCode = code


REGISTRY_TABLE = "_mirk_tables"
META_TABLE = "_mirk_meta"
SCHEMA_VERSION = 4

_REGISTRY_DDL = (
    f"""CREATE TABLE IF NOT EXISTS {META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS {REGISTRY_TABLE} (
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      table_name TEXT NOT NULL UNIQUE,
      PRIMARY KEY (kind, name)
    )""",
)


@contextmanager
def _registry_write(connection: sqlite3.Connection) -> Generator[sqlite3.Connection]:
    nested = connection.in_transaction
    connection.execute("SAVEPOINT mirk_format_migration" if nested else "BEGIN IMMEDIATE")
    try:
        yield connection
    except BaseException:
        if nested:
            connection.execute("ROLLBACK TO SAVEPOINT mirk_format_migration")
            connection.execute("RELEASE SAVEPOINT mirk_format_migration")
        else:
            connection.execute("ROLLBACK")
        raise
    else:
        connection.execute("RELEASE SAVEPOINT mirk_format_migration" if nested else "COMMIT")


def table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _stored_schema_version(connection: sqlite3.Connection) -> str | None:
    row = connection.execute(
        f"SELECT value FROM {META_TABLE} WHERE key = 'schema_version'"
    ).fetchone()
    return None if row is None else str(row[0])


class SqliteMigrationResult(TypedDict):
    fromVersion: int | None
    toVersion: int
    changed: bool
    backupPath: NotRequired[str]


def ensure_registry(
    connection: sqlite3.Connection,
    *,
    migration: str = "auto",
    backup_path: str | None = None,
    legacy_vector_space: str = "default",
    _explicit_invocation: bool = False,
) -> SqliteMigrationResult:
    """Validate before writes, then recheck and migrate under the writer lock."""

    if migration not in ("auto", "explicit", "refuse"):
        raise ValueError("Invalid migration policy")
    if not legacy_vector_space:
        raise ValueError("legacy_vector_space must be nonempty")
    if backup_path is not None and not backup_path:
        raise ValueError("backup_path must be nonempty")

    def older(found: int | None) -> bool:
        if found is not None:
            return True
        names = [
            str(row[0])
            for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
        ]
        return any(
            name in ("_kv", "vectors", "_vec_meta")
            or (name.startswith("_mirk_") and not name.startswith("_mirk_coordination_"))
            for name in names
        )

    def enforce(is_older: bool) -> None:
        if (
            is_older
            and migration != "auto"
            and not (migration == "explicit" and _explicit_invocation)
        ):
            raise SqliteAdapterError(
                "migration-refused" if migration == "refuse" else "migration-required",
                "Mirk SQLite file requires a format migration",
            )

    def version() -> int | None:
        if not table_exists(connection, META_TABLE):
            return None
        found = _stored_schema_version(connection)
        if found is None or not re.fullmatch(r"[1-9][0-9]*", found):
            raise SqliteAdapterError("malformed-schema", "Malformed Mirk schema version")
        parsed = int(found)
        if parsed > SCHEMA_VERSION:
            raise SqliteAdapterError(
                "unsupported-schema-version",
                f"Mirk SQLite file schema version {found} is newer than this"
                f" adapter understands ({SCHEMA_VERSION}).",
            )
        return parsed

    def validate_current() -> None:
        tables = {
            "_mirk_log": ("stream", "sequence", "record"),
            "_mirk_log_streams": ("stream", "generation"),
            "_mirk_log_generation": ("id", "value"),
            REGISTRY_TABLE: ("kind", "name", "table_name"),
            "_mirk_vector_spaces": ("namespace", "name", "dimensions", "metric", "encoding"),
            "_mirk_vector_documents": ("namespace", "collection", "id", "metadata"),
            "_mirk_vector_values": ("namespace", "collection", "id", "space", "vec"),
        }
        for table, expected in tables.items():
            if not table_exists(connection, table):
                raise SqliteAdapterError("malformed-schema", f"Missing Mirk table {table}")
            columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
            if not set(expected).issubset(columns):
                raise SqliteAdapterError("malformed-schema", f"Malformed Mirk table {table}")

        if table_exists(connection, "_mirk_atomic_receipts"):
            actual = connection.execute("PRAGMA table_info(_mirk_atomic_receipts)").fetchall()
            if not {"idempotency_key", "request_digest", "result_json", "created_at"}.issubset(
                {row[1] for row in actual}
            ) or not any(
                row[1] == "created_at" and str(row[2]).upper() == "INTEGER" for row in actual
            ):
                raise SqliteAdapterError(
                    "malformed-schema", "Malformed Mirk table _mirk_atomic_receipts"
                )

    entered_in_transaction = connection.in_transaction
    initial = version()
    if initial == SCHEMA_VERSION:
        validate_current()
        return {"fromVersion": initial, "toVersion": SCHEMA_VERSION, "changed": False}
    enforce(older(initial))
    try:
        with _registry_write(connection):
            found = version()
            if found == SCHEMA_VERSION:
                validate_current()
                return {"fromVersion": found, "toVersion": SCHEMA_VERSION, "changed": False}
            is_older = older(found)
            enforce(is_older)
            names = [
                row[0]
                for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")
            ]
            if found is None:
                legacy = {
                    REGISTRY_TABLE: ("kind", "name", "table_name"),
                    "_mirk_atomic_versions": ("kind", "collection", "target_key", "version"),
                    "_mirk_atomic_sequence": ("id", "value"),
                    "_mirk_atomic_identity": ("id", "value"),
                    "_mirk_atomic_receipts": ("idempotency_key", "request_digest", "result_json"),
                    "_mirk_log": ("stream", "sequence", "record"),
                    "_mirk_search_schema": ("collection", "fields_json"),
                }
                for name in names:
                    if not name.startswith("_mirk_") or name.startswith("_mirk_coordination_"):
                        continue
                    expected = legacy.get(name)
                    if expected is None:
                        raise SqliteAdapterError(
                            "malformed-schema", "Unrecognized unversioned Mirk layout"
                        )
                    actual = {row[1] for row in connection.execute(f'PRAGMA table_info("{name}")')}
                    if not set(expected).issubset(actual):
                        raise SqliteAdapterError(
                            "malformed-schema", "Unrecognized unversioned Mirk layout"
                        )
            if found not in (None, 1, 2, 3):
                raise SqliteAdapterError("malformed-schema", "Unsupported legacy Mirk format")
            if is_older and backup_path is not None:
                if entered_in_transaction:
                    raise SqliteAdapterError(
                        "unsupported-backup",
                        "Commit caller transactions before requesting a migration backup",
                    )
                owned = next(
                    (
                        name
                        for name in names
                        if name in ("vectors", "_vec_meta", "_kv")
                        or (
                            name.startswith("_mirk_") and not name.startswith("_mirk_coordination_")
                        )
                    ),
                    None,
                )
                if owned:
                    column = connection.execute(f'PRAGMA table_info("{owned}")').fetchone()[1]
                    quoted_name = owned.replace('"', '""')
                    quoted_column = str(column).replace('"', '""')
                    connection.execute(
                        f'UPDATE "{quoted_name}" SET "{quoted_column}"="{quoted_column}" WHERE 0'
                    )
                snapshot(connection, backup_path)
            for statement in _REGISTRY_DDL:
                connection.execute(statement)
            from .sqlite_format import migrate_vectors

            try:
                migrate_vectors(connection, legacy_vector_space)
            except ValueError as error:
                raise SqliteAdapterError("malformed-schema", str(error)) from error
            if table_exists(connection, "_mirk_atomic_receipts"):
                columns = {
                    row[1] for row in connection.execute("PRAGMA table_info(_mirk_atomic_receipts)")
                }
                if "created_at" not in columns:
                    connection.execute(
                        "ALTER TABLE _mirk_atomic_receipts ADD COLUMN created_at INTEGER"
                    )
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS _mirk_atomic_receipts_created_at "
                    "ON _mirk_atomic_receipts (created_at)"
                )
            from .sqlite_log_format import migrate_log_generations

            migrate_log_generations(connection)
            connection.execute(
                "INSERT INTO _mirk_meta(key,value) VALUES('schema_version',?) ON "
                "CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(SCHEMA_VERSION),),
            )
        result: SqliteMigrationResult = {
            "fromVersion": found,
            "toVersion": SCHEMA_VERSION,
            "changed": True,
        }
        if is_older and backup_path is not None:
            result["backupPath"] = backup_path
        return result
    except sqlite3.OperationalError as error:
        if getattr(error, "sqlite_errorname", "").startswith("SQLITE_READONLY"):
            raise SqliteAdapterError(
                "migration-required", "Mirk SQLite file requires a writable format migration"
            ) from error
        raise


def snapshot(connection: sqlite3.Connection, destination: str) -> None:
    databases = connection.execute("PRAGMA database_list").fetchall()
    source = next((str(row[2]) for row in databases if row[1] == "main"), "")
    if not source:
        raise SqliteAdapterError(
            "unsupported-backup", "Migration backups require a local file database"
        )
    reserved = False
    try:
        descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        reserved = True
        reader = sqlite3.connect(Path(source).as_uri() + "?mode=ro", uri=True, isolation_level=None)
        try:
            reader.execute("VACUUM main INTO ?", (destination,))
        finally:
            reader.close()
    except (OSError, sqlite3.Error) as error:
        if reserved:
            with suppress(OSError):
                os.unlink(destination)
        raise SqliteAdapterError(
            "backup-failed", f"Cannot create migration backup: {error}"
        ) from error


def migrate_sqlite(
    path: str,
    *,
    migration: str = "explicit",
    backup_path: str | None = None,
    legacy_vector_space: str = "default",
) -> SqliteMigrationResult:
    connection = sqlite3.connect(path, isolation_level=None)
    try:
        return ensure_registry(
            connection,
            migration=migration,
            backup_path=backup_path,
            legacy_vector_space=legacy_vector_space,
            _explicit_invocation=True,
        )
    finally:
        connection.close()
