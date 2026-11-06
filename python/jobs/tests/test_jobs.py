from __future__ import annotations

from typing import Any

import pytest
from mirk.store.log import InMemoryLogStore
from mirk.store.memory import InMemoryStore
from mirk.store.sqlite import SqliteStore
from mirk.store.sqlite_log import SqliteLogFacet
from mirk.store.transaction import SqliteTransactions, create_memory_transactions

from mirk.jobs import JobsError, JobsStore


@pytest.fixture(params=["memory", "sqlite"])
def fixture(request: Any) -> Any:
    store = InMemoryStore() if request.param == "memory" else SqliteStore(":memory:")
    if isinstance(store, InMemoryStore):
        log = InMemoryLogStore()
        tx = create_memory_transactions(kv=store, log=log)
    else:
        log = SqliteLogFacet(store)
        tx = SqliteTransactions(store)
    clock = [100]
    jobs = JobsStore(
        store=store,
        transactions=tx,
        log=log,
        deleteHistoryOnRemove=True,
        now=lambda: clock[0],
        token=lambda: "owner",
    )
    yield jobs, tx, clock
    if isinstance(store, SqliteStore):
        store.close()


def test_stable_claim_and_receipts(fixture: Any) -> None:
    jobs, _, clock = fixture
    input = {"id": "job", "queue": "q", "payload": {"input": "asset"}}
    first = jobs.enqueue(input, {"key": "e"})
    clock[0] = 101
    assert jobs.enqueue(input, {"key": "e"}) == first
    with pytest.raises(JobsError, match="idempotency-conflict"):
        jobs.enqueue({**input, "payload": None}, {"key": "e"})
    claim = jobs.claim("job", {"key": "c", "leaseMs": 10})
    jobs.renew(claim, 20, {"key": "r"})
    jobs.checkpoint(claim, {"providerId": "remote"}, {"key": "p"})
    done = jobs.complete(claim, "ok", {"key": "done"})
    jobs.removeTerminal("job", done["version"], {"key": "remove"})
    assert jobs.complete(claim, "ok", {"key": "done"}) == done
    assert jobs.enqueue(input, {"key": "e"}) == first
    assert jobs.get("job") is None


def test_cancellation_expiry_and_reconciliation(fixture: Any) -> None:
    jobs, _, clock = fixture
    jobs.enqueue({"id": "job", "queue": "q", "payload": None}, {"key": "e"})
    claim = jobs.claim("job", {"key": "c", "leaseMs": 10})
    jobs.checkpoint(claim, {"providerId": "remote"}, {"key": "p"})
    jobs.requestCancel("job", {"key": "cancel"})
    with pytest.raises(JobsError, match="cancel-requested"):
        jobs.complete(claim, None, {"key": "done"})
    clock[0] = 110
    with pytest.raises(JobsError, match="stale-claim"):
        jobs.complete(claim, None, {"key": "done"})
    blocked = jobs.recoverExpired("job", claim["generation"], {"key": "recover"})
    assert blocked["value"]["checkpoint"] == {"providerId": "remote"}
    assert blocked["value"]["cancellation"] == {"requestedAt": 100, "generation": 1}
    jobs.resolveBlocked("job", blocked["version"], {"state": "cancelled"}, {"key": "resolve"})
    assert jobs.get("job")["value"]["state"] == "cancelled"


def test_order_discovery_and_rollback(fixture: Any) -> None:
    jobs, tx, _ = fixture
    with pytest.raises(ValueError), tx.transaction():
        jobs.enqueue({"id": "rolled", "queue": "q", "payload": None}, {"key": "rolled"})
        raise ValueError("rollback")
    assert jobs.get("rolled") is None
    for id, priority in [("z", 0), ("b", 3), ("a", 3)]:
        jobs.enqueue({"id": id, "queue": "q", "payload": None, "priority": priority}, {"key": id})
    assert jobs.claimNext("q", {"key": "c", "leaseMs": 10})["jobId"] == "a"
    assert jobs.list({"state": "queued", "limit": 1})[0]["value"]["id"] == "b"


def test_admin_retry(fixture: Any) -> None:
    jobs, _, _ = fixture
    queued = jobs.enqueue({"id": "job", "queue": "q", "payload": None}, {"key": "e"})
    updated = jobs.updateQueued("job", queued["version"], {"priority": 9}, {"key": "priority"})
    assert updated["value"]["priority"] == 9
    claim = jobs.claim("job", {"key": "c", "leaseMs": 10})
    failed = jobs.fail(claim, "bad", {"key": "failed"})
    again = jobs.requeueTerminal("job", failed["version"], {}, {"key": "requeue"})
    assert again["value"]["generation"] == 2
    assert again["value"]["error"] is None
    assert jobs.requeueTerminal("job", failed["version"], {}, {"key": "requeue"}) == again
    next_claim = jobs.claim("job", {"key": "c2", "leaseMs": 10})
    assert next_claim["generation"] == 3
    with pytest.raises(JobsError, match="stale-claim"):
        jobs.complete(claim, "stale", {"key": "stale"})
