"""Append-only, per-stream ordered log of JSON records: the port and its memory reference.

Python port of ``@mirk/store/log``. Sequences are per stream, start at 1, and
increase by exactly 1 for each committed append. An append that does not commit
leaves no trace, and its sequence goes to the next append. Records are never
changed or removed through this port.
"""

from __future__ import annotations

import asyncio
import json
import threading
from collections.abc import Callable, Generator
from contextlib import contextmanager
from copy import deepcopy
from typing import Any, cast

from .log_types import (
    MAX_SAFE_INTEGER,
    LogCursor,
    LogEntry,
    LogInputError,
    LogInputErrorCode,
    LogListOptions,
    LogStore,
    LogTransactionError,
    assert_generation,
    assert_sequence,
    assert_stream,
    encode_record,
    list_bounds,
)

__all__ = [
    "MAX_SAFE_INTEGER",
    "InMemoryLogStore",
    "LogCursor",
    "LogEntry",
    "LogInputError",
    "LogInputErrorCode",
    "LogListOptions",
    "LogStore",
    "LogTransactionError",
    "assert_sequence",
    "assert_stream",
    "conformance_target",
    "encode_record",
    "list_bounds",
]


class InMemoryLogStore:
    def __init__(self) -> None:
        self._streams: dict[str, tuple[int, list[str]]] = {}
        self._generation = 0
        self._owner: tuple[int, object] | None = None
        self._depth = 0
        self._transaction_domain: Any = None

    def _transaction_checkpoint(self) -> object:
        return deepcopy((self._generation, self._streams))

    def _transaction_restore(self, state: object) -> None:
        self._generation, self._streams = cast(tuple[int, dict[str, tuple[int, list[str]]]], state)

    def _check_caller(self) -> None:
        if self._transaction_domain is not None:
            self._transaction_domain.check()
        if self._owner is not None and self._owner != _caller():
            raise LogTransactionError(
                "InMemoryLogStore is inside a transaction opened by another task or thread"
            )

    def append(self, stream: str, record: Any) -> int:
        self._check_caller()
        assert_stream(stream)
        text = encode_record(record)
        live = self._streams.get(stream)
        if live is None:
            if self._generation == MAX_SAFE_INTEGER:
                raise LogInputError("generation-exhausted", "log generation counter exhausted")
            self._generation += 1
            entries: list[str] = []
            live = (self._generation, entries)
            self._streams[stream] = live
        live[1].append(text)
        return len(live[1])

    def get(self, stream: str, sequence: int) -> LogEntry | None:
        self._check_caller()
        assert_stream(stream)
        sequence = assert_sequence(sequence)
        live = self._streams.get(stream)
        if live is None or sequence > len(live[1]):
            return None
        return {
            "generation": live[0],
            "sequence": sequence,
            "record": json.loads(live[1][sequence - 1]),
        }

    def list(self, stream: str, options: LogListOptions | None = None) -> list[LogEntry]:
        self._check_caller()
        assert_stream(stream)
        after, limit = list_bounds(options)
        live = self._streams.get(stream)
        assert_generation(after, live[0] if live else None)
        if live is None:
            return []
        start = after["sequence"] if after else 0
        end = len(live[1]) if limit is None else min(len(live[1]), start + limit)
        return [
            {"generation": live[0], "sequence": index + 1, "record": json.loads(live[1][index])}
            for index in range(start, end)
        ]

    def lastCursor(self, stream: str) -> LogCursor | None:
        self._check_caller()
        assert_stream(stream)
        live = self._streams.get(stream)
        return {"generation": live[0], "sequence": len(live[1])} if live else None

    def lastSequence(self, stream: str) -> int:
        cursor = self.lastCursor(stream)
        return cursor["sequence"] if cursor else 0

    def deleteStream(self, stream: str) -> bool:
        self._check_caller()
        assert_stream(stream)
        return self._streams.pop(stream, None) is not None

    @contextmanager
    def transaction(self) -> Generator[None]:
        self._check_caller()
        checkpoint = self._transaction_checkpoint()
        self._owner = _caller()
        self._depth += 1
        try:
            yield
        except BaseException:
            self._transaction_restore(checkpoint)
            raise
        finally:
            self._depth -= 1
            if self._depth == 0:
                self._owner = None


def _caller() -> tuple[int, object]:
    """The thread and the running asyncio task (``None`` outside a loop)."""
    try:
        task: object = asyncio.current_task()
    except RuntimeError:
        task = None
    return (threading.get_ident(), task)


class _RollBackError(Exception):
    pass


class _ConformanceLog:
    """The corpus target: the port's methods, plus ``appendRolledBack``, which
    appends inside the backend's own transaction, rolls it back, and returns the
    sequence the append was given."""

    def __init__(
        self,
        log: LogStore,
        rolled_back: Callable[[Callable[[], int]], int],
        kv: Any = None,
        transactions: Any = None,
    ) -> None:
        self._log = log
        self._rolled_back = rolled_back
        self._kv: Any = kv
        self._transactions: Any = transactions

    def append(self, stream: str, record: Any) -> int:
        return self._log.append(stream, record)

    def get(self, stream: str, sequence: int) -> LogEntry | None:
        return self._log.get(stream, sequence)

    def list(self, stream: str, options: LogListOptions | None = None) -> list[LogEntry]:
        return self._log.list(stream, options)

    def lastSequence(self, stream: str) -> int:
        return self._log.lastSequence(stream)

    def lastCursor(self, stream: str) -> LogCursor | None:
        return self._log.lastCursor(stream)

    def deleteStream(self, stream: str) -> bool:
        return self._log.deleteStream(stream)

    def deleteRolledBack(self, stream: str, *record: Any) -> bool:
        removed = False

        def delete() -> int:
            nonlocal removed
            removed = self._log.deleteStream(stream)
            if record:
                self._log.append(stream, record[0])
            return 0

        self._rolled_back(delete)
        return removed

    def changeRecordHistory(
        self,
        collection: str,
        id: str,
        stream: str,
        value: Any,
        remove: bool = False,
        failAfter: int = 0,
    ) -> dict[str, Any]:
        try:
            with self._transactions.transaction():
                if remove:
                    self._kv.remove(collection, id)
                else:
                    self._kv.put(collection, {"id": id, "value": value})
                if failAfter == 1:
                    raise _RollBackError
                if remove:
                    self._log.deleteStream(stream)
                else:
                    self._log.append(stream, value)
                if failAfter == 2:
                    raise _RollBackError
        except _RollBackError:
            pass
        return {"record": self._kv.getById(collection, id), "history": self._log.list(stream)}

    def appendRolledBack(self, stream: str, record: Any) -> int:
        return self._rolled_back(lambda: self._log.append(stream, record))


def conformance_target(backend: str, connection: object) -> object:
    """Build the log target the corpus runner dispatches ``log/*`` steps onto."""
    if backend == "sqlite":
        from .sqlite import connection_of
        from .sqlite_log import SqliteLogFacet

        db = connection_of(connection)
        facet = SqliteLogFacet(db)

        def sqlite_rolled_back(append: Callable[[], int]) -> int:
            db.execute("BEGIN IMMEDIATE")
            try:
                return append()
            finally:
                db.execute("ROLLBACK")

        from .transaction import SqliteTransactions

        return _ConformanceLog(
            facet, sqlite_rolled_back, connection, SqliteTransactions(connection)
        )

    memory = InMemoryLogStore()

    def memory_rolled_back(append: Callable[[], int]) -> int:
        sequence = 0
        try:
            with memory.transaction():
                sequence = append()
                raise _RollBackError
        except _RollBackError:
            pass
        return sequence

    from .memory import InMemoryStore
    from .transaction import create_memory_transactions

    kv = InMemoryStore(version_identity="conformance")
    return _ConformanceLog(
        memory, memory_rolled_back, kv, create_memory_transactions(kv=kv, log=memory)
    )
