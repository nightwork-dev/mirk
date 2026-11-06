from typing import Any

import pytest
from mirk.store.sqlite import connection_of

from mirk.jobs import JobsError
from test_jobs import fixture as fixture

INPUT = {
    "key": "dedupe",
    "queue": "renders",
    "payload": {"asset": 17},
    "subject": "asset/17",
    "kind": "thumbnail",
}
SLOT = 'mirk-jobs-active:["mirk-jobs","renders","dedupe"]'


def test_key_lifetime_and_historical_replay(fixture: Any) -> None:
    jobs, _, clock = fixture
    first = jobs.start({**INPUT, "id": "first"}, {"key": "first"})
    second = jobs.start({**INPUT, "id": "ignored", "payload": "other"}, {"key": "second"})
    assert first["started"] and not second["started"]
    assert second["job"]["value"]["id"] == "first"
    claim = jobs.claim("first", {"key": "claim", "leaseMs": 10})
    jobs.requestCancel("first", {"key": "cancel"})
    assert not jobs.start(INPUT, {"key": "pending"})["started"]
    clock[0] = 110
    blocked = jobs.recoverExpired("first", claim["generation"], {"key": "recover"})
    assert jobs.start(INPUT, {"key": "blocked"})["job"]["value"]["state"] == "blocked"
    jobs.resolveBlocked("first", blocked["version"], {"state": "cancelled"}, {"key": "resolve"})
    assert jobs.start({**INPUT, "id": "next"}, {"key": "next"})["started"]
    assert jobs.start({**INPUT, "id": "first"}, {"key": "first"}) == first
    prior = jobs.get("first")
    with pytest.raises(JobsError, match="conflict"):
        jobs.requeueTerminal("first", prior["version"], {}, {"key": "conflicting-requeue"})
    assert jobs.store.get(SLOT) == "next"


def test_terminal_paths_stale_pointer_repair_and_rollback(fixture: Any) -> None:
    jobs, tx, _ = fixture
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
        assert jobs.start({**INPUT, "id": route}, {"key": f"start-{route}"})["started"]
        if route == "queuedCancel":
            jobs.requestCancel(route, {"key": f"end-{route}"})
        else:
            claim = jobs.claim(route, {"key": f"claim-{route}", "leaseMs": 100})
            if route in {"complete", "fail"}:
                getattr(jobs, route)(claim, None, {"key": f"end-{route}"})
            elif route == "acknowledgeCancel":
                jobs.requestCancel(route, {"key": f"cancel-{route}"})
                jobs.acknowledgeCancel(claim, {"key": f"end-{route}"})
            else:
                blocked = jobs.block(claim, None, {"key": f"block-{route}"})
                if route == "blockedCancel":
                    jobs.requestCancel(route, {"key": f"end-{route}"})
                else:
                    decision = (
                        {"state": "succeeded", "result": None}
                        if route == "resolveSuccess"
                        else {"state": "failed", "error": None}
                        if route == "resolveFail"
                        else {"state": "cancelled"}
                    )
                    jobs.resolveBlocked(
                        route, blocked["version"], decision, {"key": f"end-{route}"}
                    )
        assert jobs.store.get(SLOT) is None
    jobs.store.set(SLOT, "missing-job")
    assert jobs.start({**INPUT, "id": "repaired"}, {"key": "repair-missing"})["started"]
    jobs.requestCancel("repaired", {"key": "cancel-repaired"})
    jobs.store.set(SLOT, "repaired")
    assert jobs.start({**INPUT, "id": "next"}, {"key": "repair-terminal"})["started"]
    with pytest.raises(ValueError), tx.transaction():
        jobs.start({**INPUT, "key": "rollback", "id": "rollback"}, {"key": "rollback"})
        raise ValueError("rollback")
    assert jobs.get("rollback") is None
    assert jobs.start({**INPUT, "key": "rollback", "id": "rollback"}, {"key": "rollback"})[
        "started"
    ]


def test_indexed_list_and_legacy_upgrade(fixture: Any) -> None:
    jobs, _, clock = fixture
    for id, timestamp, subject in [
        ("z", 100, "one"),
        ("b", 101, "one"),
        ("a", 101, "one"),
        ("other", 101, "two"),
    ]:
        clock[0] = timestamp
        jobs.enqueue(
            {"id": id, "queue": "q", "payload": None, "subject": subject, "kind": "render"},
            {"key": id},
        )
    traces: list[str] = []
    connection = None
    if jobs.store.meta.backend == "sqlite":
        connection = connection_of(jobs.store)
        connection.set_trace_callback(traces.append)
    result = jobs.list({"subject": "one", "kind": "render", "state": "queued", "limit": 2})
    assert [j["value"]["id"] for j in result] == ["b", "a"]
    if connection:
        query = next(q for q in traces if q.startswith("SELECT data FROM") and " LIMIT 2" in q)
        assert "ORDER BY" in query and "updatedAt" in query
        plan = connection.execute("EXPLAIN QUERY PLAN " + query).fetchall()
        assert any("USING INDEX" in str(row[3]) for row in plan)
        connection.set_trace_callback(None)
    value = jobs.get("z")["value"]
    legacy = {k: v for k, v in value.items() if k not in {"activeKey", "subject", "kind"}}
    jobs.store.put(jobs.collection, {**legacy, "schemaVersion": 1})
    target = {"kind": "record", "collection": jobs.collection, "id": "z"}
    before = jobs.store.getVersioned(target)
    assert jobs.get("z")["value"]["subject"] is None
    assert jobs.store.getVersioned(target) == before
    jobs.claim("z", {"key": "legacy-claim", "leaseMs": 10})
    assert jobs.store.getById(jobs.collection, "z")["schemaVersion"] == 2
