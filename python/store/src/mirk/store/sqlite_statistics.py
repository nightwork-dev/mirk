"""Keep a SQLite connection's query statistics fresh, by the rule TypeScript uses.

SQLite picks an index from the statistics ``ANALYZE`` stores in ``sqlite_stat1``.
With none, it guesses, and on a filter over two indexed fields it can pick the
one that matches most of the table.

From SQLite 3.46.0 the engine has the rule itself: ``PRAGMA optimize`` checks
every table (mask 0x10000), analyzes a table whose indexes have no statistics or
whose row count changed tenfold, and bounds that ANALYZE
(https://sqlite.org/pragma.html#pragma_optimize). On an older engine this module
runs a bounded ANALYZE on the tables that need it.
"""

from __future__ import annotations

import contextlib
import re
import sqlite3
import time
from collections.abc import Generator
from dataclasses import dataclass
from typing import Any, Literal

__all__ = [
    "DEFAULT_REFRESH_STATISTICS_AFTER_CHANGES",
    "LEGACY_ANALYSIS_LIMIT",
    "SqliteStatistics",
    "StatisticsRefresh",
    "StatisticsRefreshReason",
    "engine_optimize_is_bounded",
    "resolve_refresh_statistics_after_changes",
    "statistics_refresh",
    "tables_from_optimize_plan",
]

StatisticsRefreshReason = Literal["open", "index", "writes", "close", "request"]

DEFAULT_REFRESH_STATISTICS_AFTER_CHANGES = 1_000
"""An automatic refresh is considered after this many changed rows."""

LEGACY_ANALYSIS_LIMIT = 1_000
"""Rows ANALYZE reads per index on an engine older than 3.46.0."""

_ROWS_DESCRIBED_SQL = (
    "SELECT coalesce(sum(n), 0) AS n FROM "
    "(SELECT max(CAST(stat AS INTEGER)) AS n FROM sqlite_stat1 GROUP BY tbl)"
)
_STAT_TABLE_SQL = "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'"
_INDEXED_TABLES_SQL = (
    "SELECT DISTINCT tbl_name AS name FROM sqlite_master "
    "WHERE type = 'index' AND tbl_name NOT LIKE 'sqlite_%'"
)
_UNANALYZED_TABLES_SQL = (
    "SELECT DISTINCT m.tbl_name AS name FROM sqlite_master m WHERE m.type = 'index' "
    "AND m.tbl_name NOT LIKE 'sqlite_%' "
    "AND NOT EXISTS (SELECT 1 FROM sqlite_stat1 s WHERE s.idx = m.name)"
)
_PLAN_LINE = re.compile(r'^ANALYZE\s+"[^"]*(?:""[^"]*)*"\."((?:[^"]|"")*)"')


@dataclass(frozen=True)
class StatisticsRefresh:
    """What one statistics refresh did."""

    reason: StatisticsRefreshReason
    tables: tuple[str, ...]
    duration_ms: float
    skipped: str | None = None


def engine_optimize_is_bounded(version: str) -> bool:
    """True from SQLite 3.46.0, whose ``PRAGMA optimize`` checks every table and bounds itself."""
    parts = [int(part) if part.isdigit() else 0 for part in version.split(".")[:2]]
    major, minor = [*parts, 0, 0][:2]
    return major > 3 or (major == 3 and minor >= 46)


def resolve_refresh_statistics_after_changes(value: int | None) -> int:
    """A whole number of rows; 0 turns automatic refreshes off."""
    if value is None:
        return DEFAULT_REFRESH_STATISTICS_AFTER_CHANGES
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:  # pyright: ignore[reportUnnecessaryIsInstance]
        raise ValueError(
            "refresh_statistics_after_changes must be a whole number of rows, 0 or more."
        )
    return value


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def tables_from_optimize_plan(rows: list[tuple[Any, ...]]) -> list[str]:
    """Table names from ``PRAGMA optimize`` debug rows: ``ANALYZE "main"."t"``."""
    tables: list[str] = []
    for row in rows:
        if row and isinstance(row[0], str):
            match = _PLAN_LINE.match(row[0])
            if match:
                tables.append(match.group(1).replace('""', '"'))
    return tables


def statistics_refresh(
    engine_version: str,
    reason: StatisticsRefreshReason,
    changes_since_refresh: int,
    rows_described: int,
) -> Generator[str, list[tuple[Any, ...]], tuple[list[str], int]]:
    """Yield the statements that refresh statistics; return the tables and rows described."""
    if engine_optimize_is_bounded(engine_version):
        mask = 0xFFFE if reason == "close" else 0x10002
        planned = tables_from_optimize_plan((yield f"PRAGMA optimize({mask | 1})"))
        if planned:
            yield f"PRAGMA optimize({mask})"
        return planned, rows_described

    has_stats = len((yield _STAT_TABLE_SQL)) > 0
    every_table = (
        reason == "request"
        or not has_stats
        or (reason == "writes" and changes_since_refresh >= rows_described)
    )
    found = yield _INDEXED_TABLES_SQL if every_table else _UNANALYZED_TABLES_SQL
    tables: list[str] = []
    for table, *_rest in found:
        if isinstance(table, str) and (yield f"SELECT 1 AS ok FROM {_quote(table)} LIMIT 1"):
            tables.append(table)
    if not tables:
        return tables, rows_described
    previous_rows = yield "PRAGMA analysis_limit"
    previous = int(previous_rows[0][0]) if previous_rows else 0
    yield f"PRAGMA analysis_limit = {LEGACY_ANALYSIS_LIMIT}"
    for table in tables:
        yield f"ANALYZE {_quote(table)}"
    yield f"PRAGMA analysis_limit = {max(previous, 0)}"
    described = yield _ROWS_DESCRIBED_SQL
    return tables, int(described[0][0] or 0) if described else 0


class SqliteStatistics:
    """Keeps one connection's statistics fresh: on open, after ``ensureIndex``,
    after ``after_changes`` changed rows, and at close. Automatic refreshes wait
    for no other writer and never raise; a failure is reported in ``last``."""

    def __init__(self, db: sqlite3.Connection, after_changes: int, busy_timeout_ms: int) -> None:
        self._db = db
        self._after_changes = after_changes
        self._busy_timeout_ms = busy_timeout_ms
        self._engine_version = str(db.execute("SELECT sqlite_version()").fetchone()[0])
        self._changes_at_refresh = 0
        self._rows_described = 0
        self._pending: StatisticsRefreshReason | None = None
        self.last: StatisticsRefresh | None = None

    def refresh(self) -> StatisticsRefresh:
        """Refresh now. Waits for the write lock like any write; raises on failure."""
        return self._run("request")

    def auto(self, reason: StatisticsRefreshReason) -> None:
        if self._after_changes == 0:
            return
        if self._db.in_transaction:
            self._pending = self._pending or reason
            return
        self._pending = None
        started = time.perf_counter()
        failure: sqlite3.Error | None = None
        try:
            self._db.execute("PRAGMA busy_timeout = 0")
            self._run(reason)
        except sqlite3.Error as error:
            failure = error
        try:
            self._db.execute(f"PRAGMA busy_timeout = {self._busy_timeout_ms}")
        except sqlite3.Error as error:
            failure = failure or error
        if failure is not None:
            # Wait for another after_changes rows before trying again.
            with contextlib.suppress(sqlite3.Error):
                self._changes_at_refresh = self._db.total_changes
            elapsed = (time.perf_counter() - started) * 1000
            self.last = StatisticsRefresh(reason, (), elapsed, str(failure))

    def after_write(self) -> None:
        if self._after_changes == 0 or self._db.in_transaction:
            return
        if self._pending is not None:
            self.auto(self._pending)
        elif self._db.total_changes - self._changes_at_refresh >= self._after_changes:
            self.auto("writes")

    def _run(self, reason: StatisticsRefreshReason) -> StatisticsRefresh:
        started = time.perf_counter()
        plan = statistics_refresh(
            self._engine_version,
            reason,
            self._db.total_changes - self._changes_at_refresh,
            self._rows_described,
        )
        try:
            sql = next(plan)
            while True:
                sql = plan.send(self._db.execute(sql).fetchall())
        except StopIteration as done:
            tables, self._rows_described = done.value
        self._changes_at_refresh = self._db.total_changes
        self.last = StatisticsRefresh(reason, tuple(tables), (time.perf_counter() - started) * 1000)
        return self.last
