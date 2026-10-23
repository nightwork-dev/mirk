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
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from typing import Any, Literal, Protocol, TypedDict

from .canonical import canonical_json
from .filter import dumps_json

__all__ = [
    "MAX_SAFE_INTEGER",
    "InMemoryLogStore",
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

MAX_SAFE_INTEGER = 2**53 - 1

LogInputErrorCode = Literal[
    "invalid-stream", "invalid-sequence", "invalid-after", "invalid-limit", "invalid-record"
]


class LogInputError(ValueError):
    """Raised when a log call's arguments are unusable. Nothing is written."""

    def __init__(self, code: LogInputErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: LogInputErrorCode = code


class LogTransactionError(RuntimeError):
    """Raised when a call reaches an in-memory log whose transaction another
    task or thread holds open."""


class LogEntry(TypedDict):
    """One committed record and the sequence it was given."""

    sequence: int
    record: Any


class LogListOptions(TypedDict, total=False):
    """``after``: return entries whose sequence is greater (default 0).
    ``limit``: return at most this many (default: no limit)."""

    after: int
    limit: int


class LogStore(Protocol):
    def append(self, stream: str, record: Any) -> int: ...
    def get(self, stream: str, sequence: int) -> LogEntry | None: ...
    def list(self, stream: str, options: LogListOptions | None = None) -> list[LogEntry]: ...
    def lastSequence(self, stream: str) -> int: ...


def _safe_integer(value: object) -> int | None:
    """``value`` as an ``int`` when ``Number.isSafeInteger`` would accept it, else
    ``None``. An integral float such as ``2.0`` counts, as it does in TypeScript;
    a bool never does."""
    if isinstance(value, bool):
        return None
    if isinstance(value, float):
        if not value.is_integer():
            return None
        value = int(value)
    if isinstance(value, int) and -MAX_SAFE_INTEGER <= value <= MAX_SAFE_INTEGER:
        return value
    return None


def assert_stream(stream: object) -> str:
    if not isinstance(stream, str) or len(stream) == 0:
        raise LogInputError("invalid-stream", "log stream must be a non-empty string")
    return stream


def assert_sequence(sequence: object) -> int:
    value = _safe_integer(sequence)
    if value is None or value < 1:
        raise LogInputError("invalid-sequence", "log sequence must be a positive safe integer")
    return value


def list_bounds(options: Mapping[str, Any] | None) -> tuple[int, int | None]:
    """The validated ``after`` and ``limit``; ``limit`` is ``None`` for no limit.

    A key that is present with ``None`` is refused, as TypeScript refuses ``null``.
    """
    given: Mapping[str, Any] = options or {}
    after = _safe_integer(given.get("after", 0))
    if after is None or after < 0:
        raise LogInputError("invalid-after", "log after must be a non-negative safe integer")
    if "limit" not in given:
        return (after, None)
    limit = _safe_integer(given["limit"])
    if limit is None or limit < 0:
        raise LogInputError("invalid-limit", "log limit must be a non-negative safe integer")
    return (after, limit)


def encode_record(record: Any) -> str:
    """The stored text of a record: the strict JSON rules atomic writes use, encoded
    the way ``JSON.stringify`` encodes it."""
    try:
        canonical_json(record)
    except (TypeError, ValueError) as error:
        raise LogInputError("invalid-record", f"log record is not JSON-safe: {error}") from error
    return dumps_json(record)


class InMemoryLogStore:
    """The in-memory reference log. Records are kept as their JSON text, so a
    read returns a fresh copy, exactly as the SQLite facet does."""

    def __init__(self) -> None:
        self._streams: dict[str, list[str]] = {}
        self._owner: tuple[int, object] | None = None
        self._depth = 0

    def _check_caller(self) -> None:
        if self._owner is not None and self._owner != _caller():
            raise LogTransactionError(
                "InMemoryLogStore is inside a transaction opened by another task or thread"
            )

    def append(self, stream: str, record: Any) -> int:
        self._check_caller()
        assert_stream(stream)
        text = encode_record(record)
        entries = self._streams.setdefault(stream, [])
        entries.append(text)
        return len(entries)

    def get(self, stream: str, sequence: int) -> LogEntry | None:
        self._check_caller()
        assert_stream(stream)
        sequence = assert_sequence(sequence)
        entries = self._streams.get(stream, [])
        if sequence > len(entries):
            return None
        return {"sequence": sequence, "record": json.loads(entries[sequence - 1])}

    def list(self, stream: str, options: LogListOptions | None = None) -> list[LogEntry]:
        self._check_caller()
        assert_stream(stream)
        after, limit = list_bounds(options)
        entries = self._streams.get(stream, [])
        end = len(entries) if limit is None else min(len(entries), after + limit)
        return [
            {"sequence": index + 1, "record": json.loads(entries[index])}
            for index in range(after, end)
        ]

    def lastSequence(self, stream: str) -> int:
        self._check_caller()
        assert_stream(stream)
        return len(self._streams.get(stream, []))

    @contextmanager
    def transaction(self) -> Generator[None]:
        """Undo every append made inside the block if it raises, the in-memory
        counterpart of a SQLite transaction. A rolled-back append's sequence goes
        to the next append.

        The block belongs to the asyncio task (or, outside a loop, the thread)
        that opened it. While it is open, a call from any other task or thread
        raises `LogTransactionError`, so an ``await`` inside the block can never
        let another task's append be rolled back with it. Blocks nest within
        their own task."""
        self._check_caller()
        lengths = {stream: len(entries) for stream, entries in self._streams.items()}
        self._owner = _caller()
        self._depth += 1
        try:
            yield
        except BaseException:
            for stream in list(self._streams):
                if stream in lengths:
                    del self._streams[stream][lengths[stream] :]
                else:
                    del self._streams[stream]
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
    ) -> None:
        self._log = log
        self._rolled_back = rolled_back

    def append(self, stream: str, record: Any) -> int:
        return self._log.append(stream, record)

    def get(self, stream: str, sequence: int) -> LogEntry | None:
        return self._log.get(stream, sequence)

    def list(self, stream: str, options: LogListOptions | None = None) -> list[LogEntry]:
        return self._log.list(stream, options)

    def lastSequence(self, stream: str) -> int:
        return self._log.lastSequence(stream)

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

        return _ConformanceLog(facet, sqlite_rolled_back)

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

    return _ConformanceLog(memory, memory_rolled_back)
