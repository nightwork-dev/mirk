import asyncio
from pathlib import Path
from typing import Any

import pytest

from mirk.store.log import InMemoryLogStore
from mirk.store.memory import InMemoryStore
from mirk.store.sqlite import SqliteStore
from mirk.store.sqlite_log import SqliteLogFacet
from mirk.store.transaction import (
    SqliteTransactions,
    TransactionScopeError,
    create_memory_transactions,
)


@pytest.fixture(params=["memory", "sqlite"])
def domain(request: pytest.FixtureRequest, tmp_path: Path) -> Any:
    if request.param == "memory":
        kv = InMemoryStore()
        log = InMemoryLogStore()
        yield kv, log, create_memory_transactions(kv=kv, log=log)
    else:
        kv = SqliteStore(str(tmp_path / "transaction.db"))
        log = SqliteLogFacet(kv)
        yield kv, log, SqliteTransactions(kv)
        kv.close()


def test_record_history_rollback_and_nested_notifications(domain: Any) -> None:
    kv, log, tx = domain
    notifications: list[str] = []
    with tx.transaction():
        kv.put("jobs", {"id": "a", "state": "queued"})
        log.append("a", {"state": "queued"})
    original = kv.getVersioned({"kind": "record", "collection": "jobs", "id": "a"})
    with pytest.raises(ValueError), tx.transaction():
        kv.remove("jobs", "a")
        assert log.deleteStream("a")
        assert log.append("a", "replacement") == 1
        raise ValueError()
    assert kv.getVersioned({"kind": "record", "collection": "jobs", "id": "a"}) == original
    assert log.list("a") == [{"sequence": 1, "record": {"state": "queued"}}]
    with tx.transaction():
        tx.after_commit(lambda: notifications.append("first"))
        with pytest.raises(ValueError), tx.transaction():
            kv.set("inner", True)
            log.deleteStream("a")
            tx.after_commit(lambda: notifications.append("discarded"))
            raise ValueError()
        assert not kv.has("inner")
        assert log.lastSequence("a") == 1
        with tx.transaction():
            tx.after_commit(lambda: notifications.append("last"))
        assert notifications == []
    assert notifications == ["first", "last"]


def test_foreign_async_tasks_cannot_read_or_write(domain: Any) -> None:
    kv, log, tx = domain

    async def main() -> None:
        entered = asyncio.Event()
        release = asyncio.Event()

        async def owner() -> None:
            async with tx.transaction():
                kv.set("private", 1)
                entered.set()
                await release.wait()
                log.append("a", "committed")

        async def foreign() -> None:
            await entered.wait()
            with pytest.raises(TransactionScopeError):
                kv.get("private")
            with pytest.raises(TransactionScopeError):
                log.deleteStream("a")
            release.set()
            async with tx.transaction():
                assert kv.get("private") == 1
                log.append("a", "foreign")

        await asyncio.gather(owner(), foreign())

    asyncio.run(main())
    assert log.lastSequence("a") == 2


def test_delete_stream_lifecycle_and_standalone_rollback() -> None:
    log = InMemoryLogStore()
    assert not log.deleteStream("absent")
    log.append("a", "old")
    with pytest.raises(ValueError), log.transaction():
        log.deleteStream("a")
        assert log.append("a", "new") == 1
        raise ValueError()
    assert log.get("a", 1) == {"sequence": 1, "record": "old"}
    assert log.deleteStream("a")
    assert log.lastSequence("a") == 0
    assert log.append("a", "new") == 1


def test_rollback_restores_atomic_receipts_and_versions(domain: Any) -> None:
    kv, log, tx = domain
    request = {
        "operations": [{"op": "set", "key": "receipt-value", "value": 1}],
        "idempotency": {"key": "command"},
    }
    with pytest.raises(ValueError), tx.transaction():
        assert kv.mutateAtomically(request)["status"] == "applied"
        log.append("receipt", "tentative")
        raise ValueError()
    assert kv.getVersioned({"kind": "key", "key": "receipt-value"}) is None
    assert log.lastSequence("receipt") == 0
    with tx.transaction():
        assert kv.mutateAtomically(request)["status"] == "applied"
    original = kv.getVersioned({"kind": "key", "key": "receipt-value"})
    with pytest.raises(ValueError), tx.transaction():
        kv.delete("receipt-value")
        raise ValueError()
    assert kv.getVersioned({"kind": "key", "key": "receipt-value"}) == original
    assert kv.mutateAtomically(request)["status"] == "replayed"
