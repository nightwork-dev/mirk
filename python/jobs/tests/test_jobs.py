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


def test_reused_id_and_retained_receipts(fixture: Any) -> None:
    original, _, _ = fixture
    jobs = JobsStore(
        store=original.store,
        transactions=original.transactions,
        now=original.now,
        token=lambda: "repeated",
        log=original.log,
    )
    input = {"id": "job", "queue": "q", "payload": None}
    first = jobs.enqueue(input, {"key": "e"})
    stale = jobs.claim("job", {"key": "c", "leaseMs": 10})
    assert stale is not None
    done = jobs.complete(stale, "ok", {"key": "done"})
    jobs.removeTerminal("job", done["version"], {"key": "remove"})
    jobs.enqueue({**input, "payload": "replacement"}, {"key": "replacement"})
    next_claim = jobs.claim("job", {"key": "next", "leaseMs": 10})
    assert next_claim is not None
    assert next_claim["ownerToken"] == stale["ownerToken"]
    assert next_claim["generation"] > stale["generation"]
    with pytest.raises(JobsError, match="stale-claim"):
        jobs.complete(stale, "stale", {"key": "stale"})
    assert jobs.enqueue(input, {"key": "e"}) == first
    current = jobs.get("job")
    assert current is not None
    assert current["value"]["payload"] == "replacement"
    assert jobs.log is not None
    assert len(jobs.log.list('["mirk-jobs","job",0]')) == 3
    assert len(jobs.log.list('["mirk-jobs","job",2]')) == 2


def test_runtime_input_and_corrupt_record(fixture: Any) -> None:
    jobs, _, _ = fixture
    input = {"id": "job", "queue": "q", "payload": None}
    with pytest.raises(JobsError, match="Malformed jobs data"):
        jobs.enqueue({**input, "state": "succeeded"}, {"key": "smuggled"})
    queued = jobs.enqueue(input, {"key": "e"})
    jobs.store.put(jobs.collection, {**queued["value"], "state": "leased", "ownerToken": None})
    with pytest.raises(JobsError, match="Malformed jobs data"):
        jobs.get("job")
    with pytest.raises(JobsError, match="Malformed jobs data"):
        jobs.claimNext("q", {"key": "c", "leaseMs": 10})


def test_log_cleanup_failure_rolls_back(fixture: Any) -> None:
    jobs, _, _ = fixture
    jobs.enqueue({"id": "job", "queue": "q", "payload": None}, {"key": "e"})
    claim = jobs.claim("job", {"key": "c", "leaseMs": 10})
    done = jobs.complete(claim, "ok", {"key": "done"})
    log = jobs.log
    stream = '["mirk-jobs","job",0]'
    before = log.list(stream)

    class FailingLog:
        def deleteStream(self, stream: str) -> None:
            log.deleteStream(stream)
            raise ValueError("log failure")

    jobs.log = FailingLog()
    with pytest.raises(ValueError, match="log failure"):
        jobs.removeTerminal("job", done["version"], {"key": "remove"})
    assert jobs.get("job") == done
    assert log.list(stream) == before
    jobs.log = log
    assert jobs.removeTerminal("job", done["version"], {"key": "remove"})
    assert log.list(stream) == []
    jobs.enqueue({"id": "job", "queue": "q", "payload": "new incarnation"}, {"key": "replacement"})
    fresh = log.list('["mirk-jobs","job",2]')
    assert len(fresh) == 1
    assert fresh[0]["sequence"] == 1
    assert log.list(stream, {"after": before[-1]["sequence"]}) == []


def test_cancel_after_expiry(fixture: Any) -> None:
    jobs, _, clock = fixture
    jobs.enqueue({"id": "job", "queue": "q", "payload": None}, {"key": "e"})
    claim = jobs.claim("job", {"key": "c", "leaseMs": 10})
    clock[0] = 110
    jobs.requestCancel("job", {"key": "cancel"})
    blocked = jobs.recoverExpired("job", claim["generation"], {"key": "recover"})
    assert blocked["value"]["cancellation"] == {
        "requestedAt": 110,
        "generation": claim["generation"],
    }
