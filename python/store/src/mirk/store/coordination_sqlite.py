"""SQLite lease source using the shared TypeScript/Python coordination format."""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Callable
from typing import Literal

from .coordination import CoordinationClock, Held, SystemClock, Unavailable
from .coordination_engine import Acquisition, LeaseCoordinator, LeaseIdentity


def _busy(error: sqlite3.OperationalError) -> bool:
    return error.sqlite_errorcode & 0xFF in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED)


class _SqliteBackend:
    def __init__(self, db: sqlite3.Connection, namespace: str, clock: CoordinationClock) -> None:
        self.db = db
        self.namespace = namespace
        self.clock = clock

    def acquire(self, key: str, token: str, leaseMs: int) -> Acquisition | Held | Unavailable:
        try:
            self.db.execute("BEGIN IMMEDIATE")
            now = self.clock.now()
            row = self.db.execute(
                "SELECT expires_at_ms FROM _mirk_coordination_leases WHERE namespace=? AND key=?",
                (self.namespace, key),
            ).fetchone()
            if row and row[0] > now:
                self.db.execute("COMMIT")
                return {"status": "held", "expiresAt": row[0]}
            row = self.db.execute(
                "SELECT last_generation FROM _mirk_coordination_generations "
                "WHERE namespace=? AND key=?",
                (self.namespace, key),
            ).fetchone()
            generation = (row[0] if row else 0) + 1
            if generation > 2**53 - 1:
                raise OverflowError("Coordination fencing generation exhausted")
            self.db.execute(
                "INSERT INTO _mirk_coordination_generations VALUES (?, ?, ?) "
                "ON CONFLICT(namespace,key) DO UPDATE SET last_generation=excluded.last_generation",
                (self.namespace, key, generation),
            )
            self.db.execute(
                "INSERT INTO _mirk_coordination_leases VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(namespace,key) DO UPDATE SET owner_token=excluded.owner_token, "
                "fencing_generation=excluded.fencing_generation, "
                "acquired_at_ms=excluded.acquired_at_ms, expires_at_ms=excluded.expires_at_ms, "
                "updated_at_ms=excluded.updated_at_ms",
                (self.namespace, key, token, generation, now, now + leaseMs, now),
            )
            self.db.execute("COMMIT")
            return {"fencingGeneration": generation, "expiresAt": now + leaseMs}
        except Exception as error:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            if isinstance(error, sqlite3.OperationalError) and _busy(error):
                return {"status": "unavailable", "retryable": True}
            raise

    def _renew(self, lease: LeaseIdentity, leaseMs: int) -> int | None:
        now = self.clock.now()
        result = self.db.execute(
            "UPDATE _mirk_coordination_leases SET expires_at_ms=?, updated_at_ms=? "
            "WHERE namespace=? AND key=? AND owner_token=? "
            "AND fencing_generation=? AND expires_at_ms>?",
            (
                now + leaseMs,
                now,
                self.namespace,
                lease.key,
                lease.ownerToken,
                lease.fencingGeneration,
                now,
            ),
        )
        return now + leaseMs if result.rowcount == 1 else None

    def _release(self, lease: LeaseIdentity) -> bool:
        return (
            self.db.execute(
                "DELETE FROM _mirk_coordination_leases WHERE namespace=? AND key=? "
                "AND owner_token=? "
                "AND fencing_generation=? AND expires_at_ms>?",
                (
                    self.namespace,
                    lease.key,
                    lease.ownerToken,
                    lease.fencingGeneration,
                    self.clock.now(),
                ),
            ).rowcount
            == 1
        )

    def renew(self, lease: LeaseIdentity, leaseMs: int) -> int | Literal["unavailable"] | None:
        try:
            return self._renew(lease, leaseMs)
        except sqlite3.OperationalError as error:
            if _busy(error):
                return "unavailable"
            raise

    def release(self, lease: LeaseIdentity) -> bool | Literal["unavailable"]:
        try:
            return self._release(lease)
        except sqlite3.OperationalError as error:
            if _busy(error):
                return "unavailable"
            raise

    def isOwned(self, lease: LeaseIdentity) -> bool:
        row = self.db.execute(
            "SELECT owner_token, fencing_generation, expires_at_ms FROM _mirk_coordination_leases "
            "WHERE namespace=? AND key=?",
            (self.namespace, lease.key),
        ).fetchone()
        return bool(
            row
            and row[0] == lease.ownerToken
            and row[1] == lease.fencingGeneration
            and row[2] > self.clock.now()
        )


def _initialize(db: sqlite3.Connection) -> None:
    db.execute("BEGIN IMMEDIATE")
    try:
        meta = db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='_mirk_coordination_meta'"
        ).fetchone()
        if meta:
            columns = db.execute("PRAGMA table_info(_mirk_coordination_meta)").fetchall()
            if (
                len(columns) != 1
                or columns[0][1] != "schema_version"
                or columns[0][2].upper() != "INTEGER"
                or columns[0][3] != 1
                or columns[0][5] != 0
            ):
                raise ValueError("Malformed coordination schema metadata")
            versions = db.execute("SELECT schema_version FROM _mirk_coordination_meta").fetchall()
            if versions != [(1,)]:
                raise ValueError("Unsupported coordination schema version")
        layouts = {
            "_mirk_coordination_generations": ["namespace", "key", "last_generation"],
            "_mirk_coordination_leases": [
                "namespace",
                "key",
                "owner_token",
                "fencing_generation",
                "acquired_at_ms",
                "expires_at_ms",
                "updated_at_ms",
            ],
        }
        present = 0
        for table, names in layouts.items():
            columns = db.execute(f"PRAGMA table_info({table})").fetchall()
            if not columns:
                continue
            present += 1
            if len(columns) != len(names) or any(
                column[1] != names[i]
                or column[3] != 1
                or column[2].upper()
                != ("TEXT" if i < 2 or column[1] == "owner_token" else "INTEGER")
                or column[5] != (i + 1 if i < 2 else 0)
                for i, column in enumerate(columns)
            ):
                raise ValueError("Unrecognized coordination schema layout")
        if present == 1:
            raise ValueError("Incomplete coordination schema layout")
        if present == 2:
            invalid = db.execute(
                "SELECT 1 FROM _mirk_coordination_leases l LEFT JOIN "
                "_mirk_coordination_generations g ON g.namespace=l.namespace AND g.key=l.key "
                "WHERE g.last_generation IS NULL OR g.last_generation < l.fencing_generation "
                "OR l.fencing_generation < 1 LIMIT 1"
            ).fetchone()
            invalid_generation = db.execute(
                "SELECT 1 FROM _mirk_coordination_generations WHERE "
                "typeof(last_generation) != 'integer' OR last_generation < 1 "
                "OR last_generation > 9007199254740991 LIMIT 1"
            ).fetchone()
            if invalid or invalid_generation:
                raise ValueError("Invalid coordination generation history")
        db.execute(
            "CREATE TABLE IF NOT EXISTS _mirk_coordination_meta (schema_version INTEGER NOT NULL)"
        )
        db.execute(
            "CREATE TABLE IF NOT EXISTS _mirk_coordination_generations "
            "(namespace TEXT NOT NULL, key TEXT NOT NULL, last_generation INTEGER NOT NULL, "
            "PRIMARY KEY(namespace,key))"
        )
        db.execute(
            "CREATE TABLE IF NOT EXISTS _mirk_coordination_leases "
            "(namespace TEXT NOT NULL, key TEXT NOT NULL, owner_token TEXT NOT NULL, "
            "fencing_generation INTEGER NOT NULL, acquired_at_ms INTEGER NOT NULL, "
            "expires_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, "
            "PRIMARY KEY(namespace,key))"
        )
        if not meta:
            db.execute("INSERT INTO _mirk_coordination_meta VALUES (1)")
        db.execute("COMMIT")
    except BaseException:
        db.execute("ROLLBACK")
        raise


class SqliteCoordinator(LeaseCoordinator):
    def __init__(
        self,
        *,
        path: str,
        namespace: str = "default",
        busyTimeoutMs: int = 30000,
        clock: CoordinationClock | None = None,
        ownerTokenFactory: Callable[[], str] | None = None,
    ) -> None:
        if not path:
            raise ValueError("SqliteCoordinator requires a database path")
        if type(busyTimeoutMs) is not int or not 0 <= busyTimeoutMs <= 2**53 - 1:
            raise ValueError("busyTimeoutMs must be a non-negative safe integer")
        clock = clock or SystemClock()
        self.db = sqlite3.connect(path, timeout=0, isolation_level=None)
        deadline = time.monotonic() + busyTimeoutMs / 1000
        try:
            while True:
                try:
                    _initialize(self.db)
                    break
                except sqlite3.OperationalError as error:
                    if not _busy(error) or time.monotonic() >= deadline:
                        raise
                    time.sleep(min(0.05, max(0, deadline - time.monotonic())))
        except BaseException:
            self.db.close()
            raise
        super().__init__(
            _SqliteBackend(self.db, namespace, clock),
            namespace=namespace,
            clock=clock,
            ownerTokenFactory=ownerTokenFactory,
        )

    def close(self) -> None:
        self.db.close()


def createSqliteCoordinator(
    *,
    path: str,
    namespace: str = "default",
    busyTimeoutMs: int = 30000,
    clock: CoordinationClock | None = None,
    ownerTokenFactory: Callable[[], str] | None = None,
) -> SqliteCoordinator:
    return SqliteCoordinator(
        path=path,
        namespace=namespace,
        busyTimeoutMs=busyTimeoutMs,
        clock=clock,
        ownerTokenFactory=ownerTokenFactory,
    )


def conformance_coordinator(connection: object, clock: CoordinationClock) -> LeaseCoordinator:
    from .sqlite import connection_of

    db = connection_of(connection)
    _initialize(db)
    db.execute("PRAGMA busy_timeout=0")
    return LeaseCoordinator(_SqliteBackend(db, "default", clock), clock=clock)
