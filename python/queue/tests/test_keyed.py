from typing import Any

import pytest
from mirk.store.sqlite import connection_of

from mirk.queue import QueueError
from test_queue import fixture as fixture

INPUT = {
    "key": "dedupe",
    "queue": "renders",
    "payload": {"asset": 17},
    "subject": "asset/17",
    "kind": "thumbnail",
}
SLOT = 'mirk-queue-active:["mirk-queue","renders","dedupe"]'


def test_key_lifetime_and_historical_replay(fixture: Any) -> None:
    queue, _, clock = fixture
    first = queue.start({**INPUT, "id": "first"}, {"key": "first"})
    second = queue.start({**INPUT, "id": "ignored", "payload": "other"}, {"key": "second"})
    assert first["started"] and not second["started"]
    assert second["item"]["value"]["id"] == "first"
    claim = queue.claim("first", {"key": "claim", "leaseMs": 10})
    queue.requestCancel("first", {"key": "cancel"})
    assert not queue.start(INPUT, {"key": "pending"})["started"]
    clock[0] = 110
    blocked = queue.recoverExpired("first", claim["generation"], {"key": "recover"})
    assert queue.start(INPUT, {"key": "blocked"})["item"]["value"]["state"] == "blocked"
    queue.resolveBlocked("first", blocked["version"], {"state": "cancelled"}, {"key": "resolve"})
    assert queue.start({**INPUT, "id": "next"}, {"key": "next"})["started"]
    assert queue.start({**INPUT, "id": "first"}, {"key": "first"}) == first
    prior = queue.get("first")
    with pytest.raises(QueueError, match="conflict"):
        queue.requeueTerminal("first", prior["version"], {}, {"key": "conflicting-requeue"})
    assert queue.store.get(SLOT) == "next"


def test_terminal_paths_stale_pointer_repair_and_rollback(fixture: Any) -> None:
    queue, tx, _ = fixture
    for route in (
        "complete",
        "fail",
        "acknowledgeCancel",
        "queuedCancel",
        "blockedCancel",
        "resolveSuccess",
        "resolveFail",
        "resolveCancel",
    ):
        assert queue.start({**INPUT, "id": route}, {"key": f"start-{route}"})["started"]
        if route == "queuedCancel":
            queue.requestCancel(route, {"key": f"end-{route}"})
        else:
            claim = queue.claim(route, {"key": f"claim-{route}", "leaseMs": 100})
            if route in {"complete", "fail"}:
                getattr(queue, route)(claim, None, {"key": f"end-{route}"})
            elif route == "acknowledgeCancel":
                queue.requestCancel(route, {"key": f"cancel-{route}"})
                queue.acknowledgeCancel(claim, {"key": f"end-{route}"})
            else:
                blocked = queue.block(claim, None, {"key": f"block-{route}"})
                if route == "blockedCancel":
                    queue.requestCancel(route, {"key": f"end-{route}"})
                else:
                    decision = (
                        {"state": "succeeded", "result": None}
                        if route == "resolveSuccess"
                        else {"state": "failed", "error": None}
                        if route == "resolveFail"
                        else {"state": "cancelled"}
                    )
                    queue.resolveBlocked(
                        route, blocked["version"], decision, {"key": f"end-{route}"}
                    )
        assert queue.store.get(SLOT) is None
    queue.store.set(SLOT, "missing-item")
    assert queue.start({**INPUT, "id": "repaired"}, {"key": "repair-missing"})["started"]
    queue.requestCancel("repaired", {"key": "cancel-repaired"})
    queue.store.set(SLOT, "repaired")
    assert queue.start({**INPUT, "id": "next"}, {"key": "repair-terminal"})["started"]
    with pytest.raises(ValueError), tx.transaction():
        queue.start({**INPUT, "key": "rollback", "id": "rollback"}, {"key": "rollback"})
        raise ValueError("rollback")
    assert queue.get("rollback") is None
    assert queue.start({**INPUT, "key": "rollback", "id": "rollback"}, {"key": "rollback"})[
        "started"
    ]


def test_indexed_list_and_legacy_upgrade(fixture: Any) -> None:
    queue, _, clock = fixture
    for id, timestamp, subject in [
        ("z", 100, "one"),
        ("b", 101, "one"),
        ("a", 101, "one"),
        ("other", 101, "two"),
    ]:
        clock[0] = timestamp
        queue.enqueue(
            {"id": id, "queue": "q", "payload": None, "subject": subject, "kind": "render"},
            {"key": id},
        )
    traces: list[str] = []
    connection = None
    if queue.store.meta.backend == "sqlite":
        connection = connection_of(queue.store)
        connection.set_trace_callback(traces.append)
    result = queue.list({"subject": "one", "kind": "render", "state": "queued", "limit": 2})
    assert [j["value"]["id"] for j in result] == ["b", "a"]
    if connection:
        query = next(q for q in traces if q.startswith("SELECT data FROM") and " LIMIT 2" in q)
        assert "ORDER BY" in query and "updatedAt" in query
        plan = connection.execute("EXPLAIN QUERY PLAN " + query).fetchall()
        assert any("USING INDEX" in str(row[3]) for row in plan)
        connection.set_trace_callback(None)
    value = queue.get("z")["value"]
    legacy = {k: v for k, v in value.items() if k not in {"activeKey", "subject", "kind"}}
    queue.store.put(queue.collection, {**legacy, "schemaVersion": 1})
    target = {"kind": "record", "collection": queue.collection, "id": "z"}
    before = queue.store.getVersioned(target)
    assert queue.get("z")["value"]["subject"] is None
    assert queue.store.getVersioned(target) == before
    queue.claim("z", {"key": "legacy-claim", "leaseMs": 10})
    assert queue.store.getById(queue.collection, "z")["schemaVersion"] == 2
