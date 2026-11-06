"""Generation-aware log facet over the store's existing SQLite connection."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable
from typing import Any, TypeVar

from .atomic import AtomicMutationBackendError
from .log import LogCursor, LogEntry, LogInputError, LogListOptions
from .log_types import assert_generation, assert_sequence, assert_stream, encode_record, list_bounds
from .sqlite import connection_of, ensure_registry

__all__ = ["LOG_TABLE", "SqliteLogFacet"]
LOG_TABLE = "_mirk_log"
_T = TypeVar("_T")


class SqliteLogFacet:
    def __init__(self, handle: object) -> None:
        self._db = connection_of(handle)
        ensure_registry(self._db)
        self._db.execute("SELECT generation FROM _mirk_log_streams LIMIT 0")
        self._db.execute("SELECT value FROM _mirk_log_generation WHERE id = 1")

    def _check(self) -> None:
        from .transaction import check_sqlite_caller

        check_sqlite_caller(self._db)

    def _write(self, work: Callable[[], _T]) -> _T:
        own = not self._db.in_transaction
        try:
            self._db.execute("BEGIN IMMEDIATE" if own else "SAVEPOINT mirk_log_write")
            try:
                result = work()
            except BaseException:
                self._db.execute("ROLLBACK" if own else "ROLLBACK TO SAVEPOINT mirk_log_write")
                if not own:
                    self._db.execute("RELEASE SAVEPOINT mirk_log_write")
                raise
            self._db.execute("COMMIT" if own else "RELEASE SAVEPOINT mirk_log_write")
            return result
        except sqlite3.OperationalError as error:
            if (error.sqlite_errorcode & 0xFF) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                raise AtomicMutationBackendError(
                    "unavailable", True, "SQLite is busy or locked."
                ) from error
            raise

    def append(self, stream: str, record: Any) -> int:
        self._check()
        assert_stream(stream)
        text = encode_record(record)

        def append() -> int:
            live = self._db.execute(
                "SELECT generation FROM _mirk_log_streams WHERE stream = ?", (stream,)
            ).fetchone()
            if live is None:
                allocated = self._db.execute(
                    "UPDATE _mirk_log_generation SET value = value + 1 "
                    "WHERE id = 1 AND value < 9007199254740991 RETURNING value"
                ).fetchone()
                if allocated is None:
                    raise LogInputError("generation-exhausted", "log generation counter exhausted")
                self._db.execute(
                    "INSERT INTO _mirk_log_streams (stream, generation) VALUES (?, ?)",
                    (stream, allocated[0]),
                )
            row = self._db.execute(
                "INSERT INTO _mirk_log (stream, sequence, record) "
                "SELECT ?, COALESCE(MAX(sequence), 0) + 1, ? FROM _mirk_log "
                "WHERE stream = ? RETURNING sequence",
                (stream, text, stream),
            ).fetchone()
            return int(row[0])

        return self._write(append)

    def get(self, stream: str, sequence: int) -> LogEntry | None:
        self._check()
        assert_stream(stream)
        sequence = assert_sequence(sequence)
        row = self._db.execute(
            "SELECT s.generation, l.record FROM _mirk_log_streams s "
            "JOIN _mirk_log l USING(stream) WHERE s.stream = ? AND l.sequence = ?",
            (stream, sequence),
        ).fetchone()
        return (
            {"generation": row[0], "sequence": sequence, "record": json.loads(row[1])}
            if row
            else None
        )

    def list(self, stream: str, options: LogListOptions | None = None) -> list[LogEntry]:
        self._check()
        assert_stream(stream)
        after, limit = list_bounds(options)
        rows = self._db.execute(
            """SELECT s.generation, e.sequence, e.record FROM (SELECT 1) anchor
            LEFT JOIN _mirk_log_streams s ON s.stream = ?
            LEFT JOIN (SELECT sequence, record FROM _mirk_log
                       WHERE stream = ? AND sequence > ? ORDER BY sequence LIMIT ?) e
              ON s.generation IS NOT NULL ORDER BY e.sequence""",
            (stream, stream, after["sequence"] if after else 0, limit if limit is not None else -1),
        ).fetchall()
        generation = rows[0][0] if rows else None
        assert_generation(after, generation)
        return [
            {"generation": row[0], "sequence": row[1], "record": json.loads(row[2])}
            for row in rows
            if row[1] is not None
        ]

    def deleteStream(self, stream: str) -> bool:
        self._check()
        assert_stream(stream)

        def delete() -> bool:
            self._db.execute("DELETE FROM _mirk_log WHERE stream = ?", (stream,))
            return (
                self._db.execute(
                    "DELETE FROM _mirk_log_streams WHERE stream = ?", (stream,)
                ).rowcount
                > 0
            )

        return self._write(delete)

    def lastCursor(self, stream: str) -> LogCursor | None:
        self._check()
        assert_stream(stream)
        row = self._db.execute(
            "SELECT s.generation, MAX(l.sequence) FROM _mirk_log_streams s "
            "JOIN _mirk_log l USING(stream) WHERE s.stream = ? GROUP BY s.generation",
            (stream,),
        ).fetchone()
        return {"generation": row[0], "sequence": row[1]} if row else None

    def lastSequence(self, stream: str) -> int:
        cursor = self.lastCursor(stream)
        return cursor["sequence"] if cursor else 0
