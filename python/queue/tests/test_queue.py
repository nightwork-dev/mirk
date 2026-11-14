from __future__ import annotations

from typing import Any

import pytest
from mirk.store.log import InMemoryLogStore, LogInputError
from mirk.store.memory import InMemoryStore
from mirk.store.sqlite import SqliteStore
from mirk.store.sqlite_log import SqliteLogFacet
from mirk.store.transaction import SqliteTransactions, create_memory_transactions

from mirk.queue import QueueError, QueueStore


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
    queue = QueueStore(
        store=store,
        transactions=tx,
        log=log,
        deleteHistoryOnRemove=True,
        now=lambda: clock[0],
        token=lambda: "owner",
    )
    yield queue, tx, clock
    if isinstance(store, SqliteStore):
        store.close()


def test_stable_claim_and_receipts(fixture: Any) -> None:
    queue, _, clock = fixture
    input = {"id": "item", "queue": "q", "payload": {"input": "asset"}}
    first = queue.enqueue(input, {"key": "e"})
    clock[0] = 101
    assert queue.enqueue(input, {"key": "e"}) == first
    with pytest.raises(QueueError, match="idempotency-conflict"):
        queue.enqueue({**input, "payload": None}, {"key": "e"})
    claim = queue.claim("item", {"key": "c", "leaseMs": 10})
    queue.renew(claim, 20, {"key": "r"})
    queue.checkpoint(claim, {"providerId": "remote"}, {"key": "p"})
    done = queue.complete(claim, "ok", {"key": "done"})
    queue.removeTerminal("item", done["version"], {"key": "remove"})
    assert queue.complete(claim, "ok", {"key": "done"}) == done
    assert queue.enqueue(input, {"key": "e"}) == first
    assert queue.get("item") is None


def test_cancellation_expiry_and_reconciliation(fixture: Any) -> None:
    queue, _, clock = fixture
    queue.enqueue({"id": "item", "queue": "q", "payload": None}, {"key": "e"})
    claim = queue.claim("item", {"key": "c", "leaseMs": 10})
    queue.checkpoint(claim, {"providerId": "remote"}, {"key": "p"})
    queue.requestCancel("item", {"key": "cancel"})
    with pytest.raises(QueueError, match="cancel-requested"):
        queue.complete(claim, None, {"key": "done"})
    clock[0] = 110
    with pytest.raises(QueueError, match="stale-claim"):
        queue.complete(claim, None, {"key": "done"})
    blocked = queue.recoverExpired("item", claim["generation"], {"key": "recover"})
    assert blocked["value"]["checkpoint"] == {"providerId": "remote"}
    assert blocked["value"]["cancellation"] == {"requestedAt": 100, "generation": 1}
    queue.resolveBlocked("item", blocked["version"], {"state": "cancelled"}, {"key": "resolve"})
    assert queue.get("item")["value"]["state"] == "cancelled"


def test_order_discovery_and_rollback(fixture: Any) -> None:
    queue, tx, _ = fixture
    with pytest.raises(ValueError), tx.transaction():
        queue.enqueue({"id": "rolled", "queue": "q", "payload": None}, {"key": "rolled"})
        raise ValueError("rollback")
    assert queue.get("rolled") is None
    for id, priority in [("z", 0), ("b", 3), ("a", 3)]:
        queue.enqueue({"id": id, "queue": "q", "payload": None, "priority": priority}, {"key": id})
    assert queue.claimNext("q", {"key": "c", "leaseMs": 10})["itemId"] == "a"
    assert (
        queue.list({"state": "queued", "sortBy": "priority", "limit": 1})[0]["value"]["id"] == "b"
    )


def test_admin_retry(fixture: Any) -> None:
    queue, _, _ = fixture
    queued = queue.enqueue({"id": "item", "queue": "q", "payload": None}, {"key": "e"})
    updated = queue.updateQueued("item", queued["version"], {"priority": 9}, {"key": "priority"})
    assert updated["value"]["priority"] == 9
    claim = queue.claim("item", {"key": "c", "leaseMs": 10})
    failed = queue.fail(claim, "bad", {"key": "failed"})
    again = queue.requeueTerminal("item", failed["version"], {}, {"key": "requeue"})
    assert again["value"]["generation"] == 2
    assert again["value"]["error"] is None
    assert queue.requeueTerminal("item", failed["version"], {}, {"key": "requeue"}) == again
    next_claim = queue.claim("item", {"key": "c2", "leaseMs": 10})
    assert next_claim["generation"] == 3
    with pytest.raises(QueueError, match="stale-claim"):
        queue.complete(claim, "stale", {"key": "stale"})


def test_reused_id_and_retained_receipts(fixture: Any) -> None:
    original, _, _ = fixture
    queue = QueueStore(
        store=original.store,
        transactions=original.transactions,
        now=original.now,
        token=lambda: "repeated",
        log=original.log,
    )
    input = {"id": "item", "queue": "q", "payload": None}
    first = queue.enqueue(input, {"key": "e"})
    stale = queue.claim("item", {"key": "c", "leaseMs": 10})
    assert stale is not None
    done = queue.complete(stale, "ok", {"key": "done"})
    queue.removeTerminal("item", done["version"], {"key": "remove"})
    queue.enqueue({**input, "payload": "replacement"}, {"key": "replacement"})
    next_claim = queue.claim("item", {"key": "next", "leaseMs": 10})
    assert next_claim is not None
    assert next_claim["ownerToken"] == stale["ownerToken"]
    assert next_claim["generation"] > stale["generation"]
    with pytest.raises(QueueError, match="stale-claim"):
        queue.complete(stale, "stale", {"key": "stale"})
    assert queue.enqueue(input, {"key": "e"}) == first
    current = queue.get("item")
    assert current is not None
    assert current["value"]["payload"] == "replacement"
    assert queue.log is not None
    assert len(queue.log.list('["mirk-queue","item",0]')) == 3
    assert len(queue.log.list('["mirk-queue","item",2]')) == 2


def test_runtime_input_and_corrupt_record(fixture: Any) -> None:
    queue, _, _ = fixture
    input = {"id": "item", "queue": "q", "payload": None}
    with pytest.raises(QueueError, match="Malformed queue data"):
        queue.enqueue({**input, "state": "succeeded"}, {"key": "smuggled"})
    queued = queue.enqueue(input, {"key": "e"})
    queue.store.put(queue.collection, {**queued["value"], "state": "leased", "ownerToken": None})
    with pytest.raises(QueueError, match="Malformed queue data"):
        queue.get("item")
    with pytest.raises(QueueError, match="Malformed queue data"):
        queue.claimNext("q", {"key": "c", "leaseMs": 10})


def test_log_cleanup_failure_rolls_back(fixture: Any) -> None:
    queue, _, _ = fixture
    queue.enqueue({"id": "item", "queue": "q", "payload": None}, {"key": "e"})
    claim = queue.claim("item", {"key": "c", "leaseMs": 10})
    done = queue.complete(claim, "ok", {"key": "done"})
    log = queue.log
    stream = '["mirk-queue","item",0]'
    before = log.list(stream)

    class FailingLog:
        def deleteStream(self, stream: str) -> None:
            log.deleteStream(stream)
            raise ValueError("log failure")

    queue.log = FailingLog()
    with pytest.raises(ValueError, match="log failure"):
        queue.removeTerminal("item", done["version"], {"key": "remove"})
    assert queue.get("item") == done
    assert log.list(stream) == before
    queue.log = log
    assert queue.removeTerminal("item", done["version"], {"key": "remove"})
    assert log.list(stream) == []
    queue.enqueue(
        {"id": "item", "queue": "q", "payload": "new incarnation"}, {"key": "replacement"}
    )
    fresh = log.list('["mirk-queue","item",2]')
    assert len(fresh) == 1
    assert fresh[0]["sequence"] == 1
    with pytest.raises(LogInputError) as stale:
        log.list(
            stream,
            {
                "after": {
                    "generation": before[-1]["generation"],
                    "sequence": before[-1]["sequence"],
                }
            },
        )
    assert stale.value.code == "stale-cursor"


def test_cancel_after_expiry(fixture: Any) -> None:
    queue, _, clock = fixture
    queue.enqueue({"id": "item", "queue": "q", "payload": None}, {"key": "e"})
    claim = queue.claim("item", {"key": "c", "leaseMs": 10})
    clock[0] = 110
    queue.requestCancel("item", {"key": "cancel"})
    blocked = queue.recoverExpired("item", claim["generation"], {"key": "recover"})
    assert blocked["value"]["cancellation"] == {
        "requestedAt": 110,
        "generation": claim["generation"],
    }


def test_malformed_blocked_decision_precedes_used_key_lookup(fixture: Any) -> None:
    queue, _, _ = fixture
    queue.enqueue({"id": "item", "queue": "q", "payload": None}, {"key": "e"})
    claim = queue.claim("item", {"key": "c", "leaseMs": 10})
    blocked = queue.block(claim, None, {"key": "block"})
    decision = {"state": "cancelled"}
    resolved = queue.resolveBlocked("item", blocked["version"], decision, {"key": "resolve"})
    assert (
        queue.resolveBlocked("item", blocked["version"], decision, {"key": "resolve"}) == resolved
    )
    for malformed in ({"state": "cancelled", "result": "unexpected"}, {}):
        with pytest.raises(QueueError) as error:
            queue.resolveBlocked("item", blocked["version"], malformed, {"key": "resolve"})
        assert error.value.code == "invalid-input"
    assert queue.get("item") == resolved
