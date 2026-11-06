"""Log cursor types, validation, and JSON record encoding."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal, Protocol, TypedDict, cast

from .canonical import canonical_json
from .filter import dumps_json

MAX_SAFE_INTEGER = 2**53 - 1

LogInputErrorCode = Literal[
    "invalid-stream",
    "invalid-sequence",
    "invalid-cursor",
    "invalid-limit",
    "invalid-record",
    "stale-cursor",
    "generation-exhausted",
]


class LogInputError(ValueError):
    """Raised when a log call's arguments are unusable. Nothing is written."""

    def __init__(self, code: LogInputErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: LogInputErrorCode = code


class LogTransactionError(RuntimeError):
    """Raised when a call reaches an in-memory log whose transaction another
    task or thread holds open."""


class LogCursor(TypedDict):
    """A sequence position within one stream incarnation."""

    generation: int
    sequence: int


class LogEntry(LogCursor):
    """One committed record and the sequence it was given."""

    sequence: int
    record: Any


class LogListOptions(TypedDict, total=False):
    """``after`` resumes an incarnation cursor; omission starts at the first entry.
    ``limit`` returns at most this many entries; omission has no limit."""

    after: LogCursor
    limit: int


class LogStore(Protocol):
    def append(self, stream: str, record: Any) -> int: ...
    def get(self, stream: str, sequence: int) -> LogEntry | None: ...
    def list(self, stream: str, options: LogListOptions | None = None) -> list[LogEntry]: ...
    def lastSequence(self, stream: str) -> int: ...
    def lastCursor(self, stream: str) -> LogCursor | None: ...
    def deleteStream(self, stream: str) -> bool: ...


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


def list_bounds(options: Mapping[str, Any] | None) -> tuple[LogCursor | None, int | None]:
    given: Mapping[str, Any] = options or {}
    after: LogCursor | None = None
    if "after" in given:
        value = given["after"]
        cursor: Mapping[str, Any] = (
            cast(Mapping[str, Any], value) if isinstance(value, Mapping) else {}
        )
        generation = _safe_integer(cursor.get("generation"))
        sequence = _safe_integer(cursor.get("sequence"))
        if generation is None or generation < 1 or sequence is None or sequence < 0:
            raise LogInputError(
                "invalid-cursor",
                "log after must be a cursor with positive safe generation "
                "and non-negative safe sequence",
            )
        after = {"generation": generation, "sequence": sequence}
    limit = None if "limit" not in given else _safe_integer(given["limit"])
    if "limit" in given and (limit is None or limit < 0):
        raise LogInputError("invalid-limit", "log limit must be a non-negative safe integer")
    return after, limit


def assert_generation(cursor: LogCursor | None, generation: int | None) -> None:
    if cursor is not None and cursor["generation"] != generation:
        raise LogInputError("stale-cursor", "log cursor belongs to a missing or replaced stream")


def encode_record(record: Any) -> str:
    """The stored text of a record: the strict JSON rules atomic writes use, encoded
    the way ``JSON.stringify`` encodes it."""
    try:
        canonical_json(record)
    except (TypeError, ValueError) as error:
        raise LogInputError("invalid-record", f"log record is not JSON-safe: {error}") from error
    return dumps_json(record)
