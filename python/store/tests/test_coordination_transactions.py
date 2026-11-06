from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path

import pytest

from mirk.store.coordination import CoordinationLease, CoordinationOwnershipLostError
from mirk.store.coordination_memory import createMemoryCoordinationState, createMemoryCoordinator
from mirk.store.coordination_sqlite import SqliteCoordinator
from mirk.store.log import InMemoryLogStore
from mirk.store.memory import InMemoryStore
from mirk.store.transaction import TransactionScopeError, create_memory_transactions
from test_coordination import ManualClock


class Fixture:
    def __init__(self, enlist: bool = True) -> None:
        self.kv = InMemoryStore()
        self.log = InMemoryLogStore()
        self.state = createMemoryCoordinationState()
        self.clock = ManualClock()
        self.coordinator = createMemoryCoordinator(
            state=self.state, clock=self.clock, ownerTokenFactory=lambda: "same-token"
        )
        self.tx = create_memory_transactions(
            kv=self.kv, log=self.log, coordination=self.state if enlist else None
        )

    async def acquire(self, key: str = "key", leaseMs: int = 100) -> CoordinationLease:
        result = await self.coordinator.tryAcquire(key, leaseMs=leaseMs)
        assert result["status"] == "acquired"
        return result["lease"]


def test_acquisition_rollback_invalidates_escaped_handle_and_consumes_generation() -> None:
    async def run() -> None:
        s = Fixture()
        escaped: list[CoordinationLease] = []
        with pytest.raises(RuntimeError, match="rollback"), s.tx.transaction():
            escaped.append(await s.acquire())
            s.kv.set("private", True)
            s.log.append("private", True)
            raise RuntimeError("rollback")
        lease = escaped[0]
        assert not s.kv.has("private")
        assert s.log.list("private") == []
        assert lease.signal.aborted
        next_lease = await s.acquire()
        assert lease.ownerToken == next_lease.ownerToken
        assert lease.fencingGeneration < next_lease.fencingGeneration
        assert not await lease.renew(100)
        assert not await lease.release()
        with pytest.raises(CoordinationOwnershipLostError):
            lease.assertOwned()
        next_lease.assertOwned()

    asyncio.run(run())


def test_prior_lease_release_renew_and_failed_assertion_roll_back_without_signal_abort() -> None:
    async def run() -> None:
        s = Fixture()
        lease = await s.acquire()
        with pytest.raises(RuntimeError, match="rollback"), s.tx.transaction():
            assert await lease.renew(500)
            assert lease.expiresAt == 1500
            assert await lease.release()
            assert not lease.signal.aborted
            with pytest.raises(CoordinationOwnershipLostError):
                lease.assertOwned()
            assert not await lease.renew(500)
            assert not lease.signal.aborted
            raise RuntimeError("rollback")
        assert lease.expiresAt == 1100
        assert not lease.signal.aborted
        lease.assertOwned()
        with s.tx.transaction():
            assert await lease.release()
            assert not lease.signal.aborted
        assert lease.signal.aborted

    asyncio.run(run())


def test_nested_rollback_restores_cache_and_outer_rollback_invalidates_committed_children() -> None:
    async def run() -> None:
        s = Fixture()
        lease = await s.acquire()
        inner: list[CoordinationLease] = []
        children: list[CoordinationLease] = []
        with pytest.raises(RuntimeError, match="outer"), s.tx.transaction():
            await lease.renew(500)
            with pytest.raises(RuntimeError, match="inner"), s.tx.transaction():
                await lease.renew(1000)
                await lease.release()
                inner.append(await s.acquire())
                raise RuntimeError("inner")
            assert lease.expiresAt == 1500
            lease.assertOwned()
            assert not lease.signal.aborted
            assert inner[0].signal.aborted
            with s.tx.transaction():
                children.append(await s.acquire("other"))
            assert not children[0].signal.aborted
            raise RuntimeError("outer")
        assert lease.expiresAt == 1100
        lease.assertOwned()
        assert children[0].signal.aborted
        assert (await s.acquire("other")).fencingGeneration > children[0].fencingGeneration

    asyncio.run(run())


def test_foreign_async_calls_queue_and_sync_handles_refuse_uncommitted_state() -> None:
    async def run() -> None:
        s = Fixture()
        lease = await s.acquire()
        entered = asyncio.Event()
        gate = asyncio.Event()

        async def transaction() -> None:
            async with s.tx.transaction():
                await lease.renew(500)
                entered.set()
                await gate.wait()

        running = asyncio.create_task(transaction())
        await entered.wait()
        with pytest.raises(TransactionScopeError):
            lease.assertOwned()
        with pytest.raises(TransactionScopeError):
            _ = lease.expiresAt
        acquiring = asyncio.create_task(s.acquire("other"))
        renewing = asyncio.create_task(lease.renew(100))
        releasing = asyncio.create_task(lease.release())
        await asyncio.sleep(0.005)
        assert not any(task.done() for task in (acquiring, renewing, releasing))
        gate.set()
        await running
        assert await renewing
        assert await releasing
        (await acquiring).assertOwned()

    asyncio.run(run())


def test_unenlisted_coordination_is_independent_and_state_cannot_be_registered_twice() -> None:
    async def run() -> None:
        s = Fixture(False)
        leases: list[CoordinationLease] = []
        with pytest.raises(RuntimeError), s.tx.transaction():
            leases.append(await s.acquire())
            raise RuntimeError()
        leases[0].assertOwned()
        enlisted = Fixture()
        with pytest.raises(ValueError, match="already belongs"):
            create_memory_transactions(
                kv=InMemoryStore(), log=InMemoryLogStore(), coordination=enlisted.state
            )

    asyncio.run(run())


def test_uncertain_sqlite_ownership_read_does_not_abort_handle(tmp_path: Path) -> None:
    async def run() -> None:
        path = str(tmp_path / "leases.db")
        coordinator = SqliteCoordinator(path=path)
        lock = sqlite3.connect(path, isolation_level=None)
        try:
            result = await coordinator.tryAcquire("key")
            assert result["status"] == "acquired"
            lease = result["lease"]
            lock.execute("BEGIN EXCLUSIVE")
            with pytest.raises(sqlite3.OperationalError):
                lease.assertOwned()
            assert not lease.signal.aborted
            lock.execute("ROLLBACK")
            lease.assertOwned()
            await lease.release()
        finally:
            lock.close()
            coordinator.close()

    asyncio.run(run())
