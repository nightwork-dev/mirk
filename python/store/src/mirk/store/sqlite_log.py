"""SQLite log facet: the ``_mirk_log`` table over an open store connection.

Reads and writes the same table the TypeScript ``SqliteAdapter.log`` facet uses:
one row per entry, keyed by ``(stream, sequence)``, with the record as
``JSON.stringify`` text. An append is one ``INSERT ... SELECT`` statement that
derives the sequence from the stream's own rows, so the number and the record
commit together or not at all.
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from .atomic import AtomicMutationBackendError
from .log import (
    LogEntry,
    LogListOptions,
    assert_sequence,
    assert_stream,
    encode_record,
    list_bounds,
)
from .sqlite import connection_of, ensure_registry

__all__ = ["LOG_TABLE", "SqliteLogFacet"]

LOG_TABLE = "_mirk_log"

_LOG_DDL = f"""CREATE TABLE IF NOT EXISTS {LOG_TABLE} (
  stream TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  record TEXT NOT NULL,
  PRIMARY KEY (stream, sequence)
) WITHOUT ROWID"""


class SqliteLogFacet:
    """An append-only log sharing one connection with the rest of the store.

    An append joins a transaction already open on the connection and rolls back
    with it; otherwise it runs in its own ``BEGIN IMMEDIATE`` transaction.
    """

    def __init__(self, handle: object) -> None:
        self._db: sqlite3.Connection = connection_of(handle)
        ensure_registry(self._db)
        self._db.execute(_LOG_DDL)

    def append(self, stream: str, record: Any) -> int:
        assert_stream(stream)
        text = encode_record(record)
        statement = (
            f"INSERT INTO {LOG_TABLE} (stream, sequence, record)"
            f" SELECT ?, COALESCE(MAX(sequence), 0) + 1, ? FROM {LOG_TABLE} WHERE stream = ?"
            " RETURNING sequence"
        )
        try:
            if self._db.in_transaction:
                return int(self._db.execute(statement, (stream, text, stream)).fetchone()[0])
            self._db.execute("BEGIN IMMEDIATE")
            try:
                sequence = int(self._db.execute(statement, (stream, text, stream)).fetchone()[0])
            except BaseException:
                self._db.execute("ROLLBACK")
                raise
            self._db.execute("COMMIT")
            return sequence
        except sqlite3.OperationalError as error:
            # Another writer held the lock past the busy timeout, or committed
            # after a deferred transaction's first read. Nothing was appended.
            if (error.sqlite_errorcode & 0xFF) in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                raise AtomicMutationBackendError(
                    "unavailable", True, "SQLite is busy or locked."
                ) from error
            raise

    def get(self, stream: str, sequence: int) -> LogEntry | None:
        assert_stream(stream)
        sequence = assert_sequence(sequence)
        row = self._db.execute(
            f"SELECT record FROM {LOG_TABLE} WHERE stream = ? AND sequence = ?",
            (stream, sequence),
        ).fetchone()
        if row is None:
            return None
        return {"sequence": sequence, "record": json.loads(row[0])}

    def list(self, stream: str, options: LogListOptions | None = None) -> list[LogEntry]:
        assert_stream(stream)
        after, limit = list_bounds(options)
        rows = self._db.execute(
            f"SELECT sequence, record FROM {LOG_TABLE}"
            " WHERE stream = ? AND sequence > ? ORDER BY sequence LIMIT ?",
            (stream, after, -1 if limit is None else limit),
        ).fetchall()
        return [{"sequence": int(row[0]), "record": json.loads(row[1])} for row in rows]

    def lastSequence(self, stream: str) -> int:
        assert_stream(stream)
        row = self._db.execute(
            f"SELECT COALESCE(MAX(sequence), 0) FROM {LOG_TABLE} WHERE stream = ?",
            (stream,),
        ).fetchone()
        return int(row[0])
