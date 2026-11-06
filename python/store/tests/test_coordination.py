from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from mirk.store.coordination import (
    CoordinationAbortedError,
    CoordinationAbortSignal,
    CoordinationGuard,
    CoordinationOwnershipLostError,
    CoordinationTimeoutError,
)
from mirk.store.coordination_memory import createMemoryCoordinationState, createMemoryCoordinator
from mirk.store.coordination_sqlite import SqliteCoordinator


class ManualClock:
    def __init__(self) -> None:
        self.time = 1000
        self.pending: dict[asyncio.Future[None], int] = {}

    def now(self) -> int:
        return self.time

    async def sleep(self, ms: int, signal: CoordinationAbortSignal | None = None) -> None:
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self.pending[future] = self.time + ms

        def abort() -> None:
            if not future.done():
                future.set_exception(signal.reason if signal and signal.reason else RuntimeError())

        if signal:
            signal.add(abort)
        try:
            await future
        finally:
            self.pending.pop(future, None)
            if signal:
                signal.remove(abort)

    async def advance(self, ms: int) -> None:
        self.time += ms
        for future, at in list(self.pending.items()):
            if at <= self.time and not future.done():
                future.set_result(None)
        for _ in range(10):
            await asyncio.sleep(0)


@pytest.mark.parametrize("kind", ["memory", "sqlite"])
def test_lease_boundaries(kind: str, tmp_path: Path) -> None:
    async def run() -> None:
        clock = ManualClock()
        state = createMemoryCoordinationState()
        a = (
            createMemoryCoordinator(state=state, clock=clock)
            if kind == "memory"
            else SqliteCoordinator(path=str(tmp_path / "leases.db"), clock=clock)
        )
        b = (
            createMemoryCoordinator(state=state, clock=clock)
            if kind == "memory"
            else SqliteCoordinator(path=str(tmp_path / "leases.db"), clock=clock)
        )
        try:
            result = await a.tryAcquire("key", leaseMs=100)
            assert result["status"] == "acquired"
            lease = result["lease"]
            assert not clock.pending
            assert await b.tryAcquire("key") == {"status": "held", "expiresAt": 1100}
            await clock.advance(99)
            lease.assertOwned()
            await clock.advance(1)
            result = await b.tryAcquire("key", leaseMs=100)
            assert result["status"] == "acquired"
            next_lease = result["lease"]
            assert next_lease.fencingGeneration == 2
            assert not await lease.renew(100)
            assert not await lease.release()
            with pytest.raises(CoordinationOwnershipLostError):
                lease.assertOwned()
            next_lease.assertOwned()
            assert await next_lease.release()
            assert not await next_lease.release()
            result = await a.tryAcquire("key")
            assert result["status"] == "acquired"
            assert result["lease"].fencingGeneration == 3
        finally:
            if isinstance(a, SqliteCoordinator):
                a.close()
            if isinstance(b, SqliteCoordinator):
                b.close()

    asyncio.run(run())


@pytest.mark.parametrize("kind", ["memory", "sqlite"])
def test_clock_wait_cancel_and_renew(kind: str, tmp_path: Path) -> None:
    async def run() -> None:
        clock = ManualClock()
        a = (
            createMemoryCoordinator(state=createMemoryCoordinationState(), clock=clock)
            if kind == "memory"
            else SqliteCoordinator(path=str(tmp_path / "lease.db"), clock=clock)
        )
        try:
            entered = False

            async def empty(_guard: CoordinationGuard) -> None:
                nonlocal entered
                entered = True

            await a.runExclusive("free", empty, waitMs=0)
            await a.tryAcquire("held", leaseMs=100)
            waiting = asyncio.create_task(a.runExclusive("held", empty, waitMs=100))
            await clock.advance(0)
            await clock.advance(100)
            with pytest.raises(CoordinationTimeoutError):
                await waiting
            await a.tryAcquire("held")
            abort = CoordinationAbortSignal()
            entered = False
            waiting = asyncio.create_task(a.runExclusive("held", empty, signal=abort))
            await clock.advance(0)
            assert len(clock.pending) == 1
            abort.abort()
            with pytest.raises(CoordinationAbortedError):
                await waiting
            assert not entered
            assert not clock.pending
            finish = asyncio.Event()
            guards: list[CoordinationGuard] = []

            async def held(guard: CoordinationGuard) -> None:
                guards.append(guard)
                await finish.wait()

            running = asyncio.create_task(
                a.runExclusive("renew", held, leaseMs=100, renewEveryMs=30)
            )
            await clock.advance(0)
            await clock.advance(30)
            assert await a.tryAcquire("renew") == {"status": "held", "expiresAt": 1230}
            await clock.advance(100)
            assert guards[0].signal.aborted
            await a.runExclusive("renew", empty, waitMs=0)
            finish.set()
            await running
            assert not clock.pending
        finally:
            if isinstance(a, SqliteCoordinator):
                a.close()

    asyncio.run(run())


def test_sqlite_busy_and_future_schema(tmp_path: Path) -> None:
    async def run() -> None:
        path = str(tmp_path / "lease.db")
        a = SqliteCoordinator(path=path)
        lock = sqlite3.connect(path, isolation_level=None)
        try:
            lock.execute("BEGIN IMMEDIATE")
            assert await a.tryAcquire("key") == {"status": "unavailable", "retryable": True}
            lock.execute("ROLLBACK")
            assert (await a.tryAcquire("key"))["status"] == "acquired"
            assert (await a.tryAcquire("key"))["status"] == "held"
            lock.execute("UPDATE _mirk_coordination_meta SET schema_version=99")
            before = lock.execute("SELECT * FROM _mirk_coordination_leases").fetchall()
            with pytest.raises(ValueError, match="schema version"):
                SqliteCoordinator(path=path)
            assert lock.execute("SELECT * FROM _mirk_coordination_leases").fetchall() == before
        finally:
            lock.close()
            a.close()

    asyncio.run(run())


def test_legacy_schema_adoption_and_malformed_rejection(tmp_path: Path) -> None:
    path = str(tmp_path / "legacy.db")
    c = SqliteCoordinator(path=path)
    c.db.execute("INSERT INTO _mirk_coordination_generations VALUES ('default', 'old', 7)")
    c.db.execute("DROP TABLE _mirk_coordination_meta")
    c.close()
    c = SqliteCoordinator(path=path)
    assert c.db.execute("SELECT schema_version FROM _mirk_coordination_meta").fetchall() == [(1,)]

    async def run() -> None:
        result = await c.tryAcquire("old")
        assert result["status"] == "acquired"
        assert result["lease"].fencingGeneration == 8

    asyncio.run(run())
    c.close()
    broken = str(tmp_path / "broken.db")
    db = sqlite3.connect(broken, isolation_level=None)
    db.execute("CREATE TABLE _mirk_coordination_generations (namespace TEXT, key TEXT)")
    with pytest.raises(ValueError, match="layout"):
        SqliteCoordinator(path=broken)
    assert (
        db.execute("SELECT name FROM sqlite_master WHERE name='_mirk_coordination_meta'").fetchall()
        == []
    )
    db.close()


def test_busy_renewal_release_use_clock_and_expiry(tmp_path: Path) -> None:
    async def run() -> None:
        clock = ManualClock()
        path = str(tmp_path / "busy.db")
        c = SqliteCoordinator(path=path, clock=clock)
        lock = sqlite3.connect(path, isolation_level=None)
        try:
            result = await c.tryAcquire("key", leaseMs=100)
            assert result["status"] == "acquired"
            lease = result["lease"]
            lock.execute("BEGIN IMMEDIATE")
            renewing = asyncio.create_task(lease.renew(100))
            await clock.advance(0)
            assert len(clock.pending) == 1
            lock.execute("ROLLBACK")
            await clock.advance(5)
            assert await renewing
            assert lease.expiresAt == 1105
            lock.execute("BEGIN IMMEDIATE")
            releasing = asyncio.create_task(lease.release())
            await clock.advance(0)
            await clock.advance(100)
            assert not await releasing
            lock.execute("ROLLBACK")
            assert (await c.tryAcquire("key"))["status"] == "acquired"
            assert not clock.pending
        finally:
            lock.close()
            c.close()

    asyncio.run(run())
