"""The atomic mutation contract, on both backends.

Ported from ``packages/store/src/atomic.test.ts``. Every case runs against the
in-memory reference and against a real SQLite file, because the two are required
to decide identically; the SQLite store here is file-backed rather than
``:memory:`` so the transaction really commits to disk.

The digests asserted here are Python's own. The cross-language pinning against
the real TypeScript ``validateAtomicRequest`` lives in ``test_sqlite_compat.py``,
which builds and runs the bundle under Node.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

from mirk.store.atomic import (
    DEFAULT_ATOMIC_LIMITS,
    IN_PROCESS_ATOMIC_LIMITS,
    MAX_ATOMIC_OUTCOME_BYTES,
    AtomicMutationLimits,
    AtomicMutationRejectedError,
    compare_targets,
    resolve_atomic_limits,
    target_key,
    validate_atomic_request,
)
from mirk.store.memory import InMemoryStore
from mirk.store.sqlite import SqliteStore

AtomicStore = InMemoryStore | SqliteStore
MakeStore = Callable[..., AtomicStore]


@pytest.fixture(params=["memory", "sqlite"])
def make_store(request: pytest.FixtureRequest, tmp_path: Path) -> Iterator[MakeStore]:
    """A factory for one backend, closing whatever it hands out."""
    opened: list[SqliteStore] = []
    counter = {"n": 0}

    def build(**options: Any) -> AtomicStore:
        if request.param == "memory":
            return InMemoryStore(**options)
        counter["n"] += 1
        store = SqliteStore(str(tmp_path / f"atomic-{counter['n']}.db"), **options)
        opened.append(store)
        return store

    yield build
    for store in opened:
        store.close()


def test_conditions_and_fresh_versions(make_store: MakeStore) -> None:
    store = make_store()
    created = store.mutateAtomically(
        {
            "conditions": [{"target": {"kind": "key", "key": "counter"}, "expected": "missing"}],
            "operations": [{"op": "set", "key": "counter", "value": 1}],
        }
    )
    assert created["status"] == "applied"
    version = created["versions"][0]["version"]
    assert store.getVersioned({"kind": "key", "key": "counter"}) == {
        "value": 1,
        "version": version,
    }

    updated = store.mutateAtomically(
        {
            "conditions": [
                {
                    "target": {"kind": "key", "key": "counter"},
                    "expected": "version",
                    "version": version,
                }
            ],
            "operations": [{"op": "set", "key": "counter", "value": 2}],
        }
    )
    assert updated["status"] == "applied"
    assert updated["versions"][0]["version"] != version

    stale = store.mutateAtomically(
        {
            "conditions": [
                {
                    "target": {"kind": "key", "key": "counter"},
                    "expected": "version",
                    "version": version,
                }
            ],
            "operations": [{"op": "set", "key": "counter", "value": 3}],
        }
    )
    assert stale["status"] == "conflict"
    assert stale["observed"] == updated["versions"][0]["version"]
    assert store.get("counter") == 2


def test_missing_target_reads_as_none(make_store: MakeStore) -> None:
    store = make_store()
    assert store.getVersioned({"kind": "key", "key": "absent"}) is None
    assert store.getVersioned({"kind": "record", "collection": "none", "id": "x"}) is None


def test_first_conflict_is_the_sorted_one_and_nothing_is_written(make_store: MakeStore) -> None:
    store = make_store()
    store.set("z", "old")
    conflict = store.mutateAtomically(
        {
            "conditions": [
                {"target": {"kind": "key", "key": "z"}, "expected": "missing"},
                {"target": {"kind": "key", "key": "a"}, "expected": "present"},
            ],
            "operations": [{"op": "set", "key": "should-not-write", "value": True}],
        }
    )
    # Conditions are sorted by target before evaluation, so "a" is checked first
    # even though the caller listed "z" first.
    assert conflict == {
        "status": "conflict",
        "condition": {"target": {"kind": "key", "key": "a"}, "expected": "present"},
        "observed": "missing",
    }
    assert store.get("should-not-write") is None


def test_operations_apply_in_request_order(make_store: MakeStore) -> None:
    store = make_store()
    applied = store.mutateAtomically(
        {
            "operations": [
                {"op": "set", "key": "one", "value": 1},
                {"op": "put", "collection": "records", "item": {"id": "r1", "ok": True}},
            ]
        }
    )
    assert applied["status"] == "applied"
    assert [entry["target"] for entry in applied["versions"]] == [
        {"kind": "key", "key": "one"},
        {"kind": "record", "collection": "records", "id": "r1"},
    ]
    assert store.get("one") == 1
    assert store.getById("records", "r1") == {"id": "r1", "ok": True}


def test_delete_and_remove_report_a_null_version(make_store: MakeStore) -> None:
    store = make_store()
    store.set("gone", 1)
    store.put("things", {"id": "t1"})
    applied = store.mutateAtomically(
        {
            "operations": [
                {"op": "delete", "key": "gone"},
                {"op": "remove", "collection": "things", "id": "t1"},
            ]
        }
    )
    assert [entry["version"] for entry in applied["versions"]] == [None, None]
    assert store.getVersioned({"kind": "key", "key": "gone"}) is None
    assert store.getVersioned({"kind": "record", "collection": "things", "id": "t1"}) is None


def test_separators_in_collection_names_and_ids_stay_distinct(make_store: MakeStore) -> None:
    store = make_store()
    applied = store.mutateAtomically(
        {
            "operations": [
                {"op": "put", "collection": "a:b", "item": {"id": "c", "value": 1}},
                {"op": "put", "collection": "a", "item": {"id": "b:c", "value": 2}},
            ]
        }
    )
    assert applied["status"] == "applied"
    assert applied["versions"][0]["target"] != applied["versions"][1]["target"]
    assert store.getById("a:b", "c") == {"id": "c", "value": 1}
    assert store.getById("a", "b:c") == {"id": "b:c", "value": 2}


def test_wide_batch_above_the_old_fixed_limit(make_store: MakeStore) -> None:
    store = make_store()
    assert store.atomic_limits.maxOperations >= 4096
    operations = [{"op": "set", "key": f"wide:{index}", "value": index} for index in range(200)]
    applied = store.mutateAtomically({"operations": operations})
    assert applied["status"] == "applied"
    assert len(applied["versions"]) == 200
    assert store.get("wide:0") == 0
    assert store.get("wide:199") == 199


def test_operation_limit_override_names_the_limit(make_store: MakeStore) -> None:
    store = make_store(atomic_limits={"maxOperations": 10})
    assert store.atomic_limits.maxOperations == 10
    operations = [{"op": "set", "key": f"narrow:{index}", "value": index} for index in range(11)]
    with pytest.raises(AtomicMutationRejectedError) as caught:
        store.mutateAtomically({"operations": operations})
    assert caught.value.code == "operation-limit-exceeded"
    assert str(caught.value) == ("request has 11 operations; this store's maxOperations is 10")
    assert store.get("narrow:0") is None
    # Ten is still accepted, so the boundary is the override and not an
    # off-by-one around it.
    assert store.mutateAtomically({"operations": operations[:10]})["status"] == "applied"


def test_condition_limit_override_names_the_limit(make_store: MakeStore) -> None:
    store = make_store(atomic_limits={"maxConditions": 2})
    conditions = [
        {"target": {"kind": "key", "key": f"cond:{index}"}, "expected": "missing"}
        for index in range(3)
    ]
    with pytest.raises(AtomicMutationRejectedError) as caught:
        store.mutateAtomically(
            {"conditions": conditions, "operations": [{"op": "set", "key": "cond:out", "value": 1}]}
        )
    assert caught.value.code == "condition-limit-exceeded"
    assert str(caught.value) == "request has 3 conditions; this store's maxConditions is 2"
    assert store.get("cond:out") is None


def test_idempotency_key_counts_toward_the_request_limit(make_store: MakeStore) -> None:
    store = make_store(atomic_limits={"maxRequestBytes": 4096})
    with pytest.raises(AtomicMutationRejectedError) as caught:
        store.mutateAtomically(
            {
                "operations": [{"op": "set", "key": "bounded", "value": True}],
                "idempotency": {"key": "k" * 8192},
            }
        )
    assert caught.value.code == "request-size-exceeded"
    assert store.get("bounded") is None


def test_outcome_cap_is_fixed_however_limits_are_raised(make_store: MakeStore) -> None:
    store = make_store(
        atomic_limits={
            "maxOperations": 4096,
            "maxConditions": 4096,
            "maxRequestBytes": 64 * 1024 * 1024,
        }
    )
    with pytest.raises(AtomicMutationRejectedError) as caught:
        store.mutateAtomically(
            {
                "operations": [{"op": "set", "key": "capped", "value": 1}],
                "idempotency": {"key": "capped", "outcome": {"note": "o" * (64 * 1024)}},
            }
        )
    assert caught.value.code == "outcome-size-exceeded"
    assert str(MAX_ATOMIC_OUTCOME_BYTES) in str(caught.value)
    assert store.get("capped") is None
    # Just under the cap is accepted, so the failure above is the cap and not a
    # malformed payload.
    assert (
        store.mutateAtomically(
            {
                "operations": [{"op": "set", "key": "capped", "value": 1}],
                "idempotency": {"key": "capped", "outcome": {"note": "o" * (60 * 1024)}},
            }
        )["status"]
        == "applied"
    )


def test_replay_and_idempotency_conflict(make_store: MakeStore) -> None:
    store = make_store()
    request: dict[str, Any] = {
        "operations": [{"op": "set", "key": "once", "value": {"count": 1}}],
        "idempotency": {"key": "same", "outcome": {"accepted": True}},
    }
    first = store.mutateAtomically(request)
    replay = store.mutateAtomically(request)
    assert first["status"] == "applied"
    assert replay["status"] == "replayed"
    assert replay["requestDigest"] == first["requestDigest"]
    assert replay["outcome"] == {"accepted": True}
    assert replay["versions"] == first["versions"]
    assert store.get("once") == {"count": 1}

    changed = store.mutateAtomically(
        {
            "operations": [{"op": "set", "key": "once", "value": {"count": 2}}],
            "idempotency": {"key": "same", "outcome": {"accepted": True}},
        }
    )
    assert changed["status"] == "idempotency-conflict"
    assert changed["key"] == "same"
    assert changed["expectedRequestDigest"] == first["requestDigest"]
    assert changed["receivedRequestDigest"] != first["requestDigest"]
    assert store.get("once") == {"count": 1}


def test_replay_returns_the_original_versions_after_a_later_write(make_store: MakeStore) -> None:
    """A receipt is a record of what happened, not a re-read of the store."""
    store = make_store()
    request: dict[str, Any] = {
        "operations": [{"op": "set", "key": "moving", "value": 1}],
        "idempotency": {"key": "receipt"},
    }
    applied = store.mutateAtomically(request)
    original = applied["versions"][0]["version"]
    store.set("moving", 2)
    current = store.getVersioned({"kind": "key", "key": "moving"})
    assert current is not None and current["version"] != original
    replay = store.mutateAtomically(request)
    assert replay["status"] == "replayed"
    assert replay["versions"][0]["version"] == original
    # The replay wrote nothing: the later plain value survives.
    assert store.get("moving") == 2


def test_outcome_is_omitted_rather_than_null_when_absent(make_store: MakeStore) -> None:
    store = make_store()
    applied = store.mutateAtomically(
        {"operations": [{"op": "set", "key": "bare", "value": 1}], "idempotency": {"key": "bare"}}
    )
    assert "outcome" not in applied
    assert "outcome" not in store.mutateAtomically(
        {"operations": [{"op": "set", "key": "bare", "value": 1}], "idempotency": {"key": "bare"}}
    )


def test_a_null_outcome_is_carried_and_replayed(make_store: MakeStore) -> None:
    store = make_store()
    request: dict[str, Any] = {
        "operations": [{"op": "set", "key": "nulled", "value": 1}],
        "idempotency": {"key": "nulled", "outcome": None},
    }
    applied = store.mutateAtomically(request)
    assert applied["outcome"] is None
    replay = store.mutateAtomically(request)
    assert replay["status"] == "replayed"
    assert "outcome" in replay
    assert replay["outcome"] is None


def test_a_rejected_request_writes_nothing(make_store: MakeStore) -> None:
    store = make_store()
    with pytest.raises(AtomicMutationRejectedError):
        store.mutateAtomically(
            {"operations": [{"op": "set", "key": "x", "value": 1}, {"op": "delete", "key": "x"}]}
        )
    with pytest.raises(AtomicMutationRejectedError) as caught:
        store.mutateAtomically({"operations": [{"op": "set", "key": "x", "value": math.nan}]})
    assert "JSON-safe" in str(caught.value)
    assert store.get("x") is None


def test_sqlite_versions_and_receipts_survive_a_reopen(tmp_path: Path) -> None:
    path = str(tmp_path / "persisted.db")
    request: dict[str, Any] = {
        "operations": [{"op": "set", "key": "persisted", "value": "yes"}],
        "idempotency": {"key": "persist", "outcome": {"n": 1}},
    }
    first = SqliteStore(path, version_identity="first")
    applied = first.mutateAtomically(request)
    version = first.getVersioned({"kind": "key", "key": "persisted"})
    assert version is not None
    first.close()

    # A file's persisted identity wins over the one this constructor offers.
    reopened = SqliteStore(path, version_identity="second")
    assert reopened.getVersioned({"kind": "key", "key": "persisted"}) == version
    replay = reopened.mutateAtomically(request)
    assert replay["status"] == "replayed"
    assert replay["requestDigest"] == applied["requestDigest"]
    assert replay["versions"] == applied["versions"]
    assert replay["outcome"] == {"n": 1}
    next_applied = reopened.mutateAtomically(
        {"operations": [{"op": "set", "key": "later", "value": 1}]}
    )
    assert next_applied["versions"][0]["version"].startswith("first-v")
    reopened.close()


def test_sqlite_rolls_a_failed_batch_back(tmp_path: Path) -> None:
    """A failing condition undoes the whole batch, not the operations after it."""
    path = str(tmp_path / "rollback.db")
    store = SqliteStore(path)
    wide = [{"op": "set", "key": f"wide:{index}", "value": index} for index in range(200)]
    assert store.mutateAtomically({"operations": wide})["status"] == "applied"
    rolled = [{"op": "set", "key": f"rolled:{index}", "value": index} for index in range(200)]
    conflict = store.mutateAtomically(
        {
            "conditions": [{"target": {"kind": "key", "key": "wide:0"}, "expected": "missing"}],
            "operations": rolled,
        }
    )
    assert conflict["status"] == "conflict"
    assert store.keys("rolled:") == []
    store.close()

    reopened = SqliteStore(path)
    assert reopened.get("wide:0") == 0
    assert reopened.get("wide:199") == 199
    assert reopened.keys("rolled:") == []
    assert len(reopened.keys("wide:")) == 200
    reopened.close()


# ── Validation ──────────────────────────────────────────────────────────────

REJECTIONS: list[tuple[str, Any, str]] = [
    ("not an object", [], "request must be a plain object"),
    ("no operations", {}, "operations must be a non-empty array"),
    ("empty operations", {"operations": []}, "operations must be a non-empty array"),
    (
        "conditions not an array",
        {"conditions": {}, "operations": [{"op": "set", "key": "k", "value": 1}]},
        "conditions must be an array",
    ),
    ("operation not an object", {"operations": [[]]}, "invalid atomic operation"),
    ("operation without op", {"operations": [{}]}, "invalid atomic operation"),
    ("set without a key", {"operations": [{"op": "set", "value": 1}]}, "set requires a string key"),
    ("delete without a key", {"operations": [{"op": "delete"}]}, "delete requires a string key"),
    (
        "put without an item id",
        {"operations": [{"op": "put", "collection": "c", "item": {}}]},
        "put requires a collection and an item with a string id",
    ),
    (
        "put with an empty collection",
        {"operations": [{"op": "put", "collection": "", "item": {"id": "a"}}]},
        "put requires a collection and an item with a string id",
    ),
    (
        "remove without an id",
        {"operations": [{"op": "remove", "collection": "c"}]},
        "remove requires string collection and id",
    ),
    (
        "unknown operation",
        {"operations": [{"op": "nope"}]},
        "unsupported atomic operation: nope",
    ),
    (
        "condition not an object",
        {"conditions": ["x"], "operations": [{"op": "set", "key": "k", "value": 1}]},
        "invalid atomic condition",
    ),
    (
        "condition without a target",
        {"conditions": [{"expected": "missing"}], "operations": [{"op": "delete", "key": "k"}]},
        "invalid store target",
    ),
    (
        "key target without a string key",
        {
            "conditions": [{"target": {"kind": "key"}, "expected": "missing"}],
            "operations": [{"op": "delete", "key": "k"}],
        },
        "key target requires a string key",
    ),
    (
        "record target without an id",
        {
            "conditions": [
                {"target": {"kind": "record", "collection": "c"}, "expected": "missing"}
            ],
            "operations": [{"op": "delete", "key": "k"}],
        },
        "record target requires string collection and id",
    ),
    (
        "unknown expectation",
        {
            "conditions": [{"target": {"kind": "key", "key": "k"}, "expected": "whatever"}],
            "operations": [{"op": "delete", "key": "k"}],
        },
        "invalid atomic condition expectation",
    ),
    (
        "version expectation without a version",
        {
            "conditions": [{"target": {"kind": "key", "key": "k"}, "expected": "version"}],
            "operations": [{"op": "delete", "key": "k"}],
        },
        "invalid atomic condition expectation",
    ),
    (
        "repeated condition target",
        {
            "conditions": [
                {"target": {"kind": "key", "key": "k"}, "expected": "missing"},
                {"target": {"kind": "key", "key": "k"}, "expected": "present"},
            ],
            "operations": [{"op": "delete", "key": "k"}],
        },
        "repeated conditions for one target are not supported",
    ),
    (
        "repeated operation target",
        {"operations": [{"op": "set", "key": "k", "value": 1}, {"op": "delete", "key": "k"}]},
        "repeated operation targets are not supported",
    ),
    (
        "idempotency without a string key",
        {"operations": [{"op": "delete", "key": "k"}], "idempotency": {}},
        "idempotency requires a string key",
    ),
    (
        "non-finite set value",
        {"operations": [{"op": "set", "key": "k", "value": math.inf}]},
        "set value is not JSON-safe: non-finite numbers are not JSON-safe",
    ),
    (
        "missing set value",
        {"operations": [{"op": "set", "key": "k"}]},
        "set value is not JSON-safe: value is not JSON-safe",
    ),
    (
        "non-JSON put item",
        {"operations": [{"op": "put", "collection": "c", "item": {"id": "a", "n": {1, 2}}}]},
        "put item is not JSON-safe: only plain objects are JSON-safe",
    ),
    (
        "non-finite outcome",
        {
            "operations": [{"op": "delete", "key": "k"}],
            "idempotency": {"key": "i", "outcome": math.nan},
        },
        "idempotency outcome is not JSON-safe: non-finite numbers are not JSON-safe",
    ),
]


@pytest.mark.parametrize(
    ("name", "request_body", "message"), REJECTIONS, ids=[r[0] for r in REJECTIONS]
)
def test_rejection_messages(name: str, request_body: Any, message: str) -> None:
    with pytest.raises(AtomicMutationRejectedError) as caught:
        validate_atomic_request(request_body, IN_PROCESS_ATOMIC_LIMITS)
    assert str(caught.value) == message


def test_rejections_reach_both_backends(make_store: MakeStore) -> None:
    """The stores validate through the same path, so the message travels."""
    store = make_store()
    with pytest.raises(AtomicMutationRejectedError) as caught:
        store.mutateAtomically({"operations": []})
    assert str(caught.value) == "operations must be a non-empty array"


def test_conditions_are_sorted_before_the_digest() -> None:
    first = validate_atomic_request(
        {
            "conditions": [
                {"target": {"kind": "record", "collection": "c", "id": "a"}, "expected": "present"},
                {"target": {"kind": "key", "key": "b"}, "expected": "missing"},
                {"target": {"kind": "key", "key": "a"}, "expected": "missing"},
            ],
            "operations": [{"op": "delete", "key": "z"}],
        }
    )
    assert [condition["target"] for condition in first.conditions] == [
        {"kind": "key", "key": "a"},
        {"kind": "key", "key": "b"},
        {"kind": "record", "collection": "c", "id": "a"},
    ]
    second = validate_atomic_request(
        {
            "conditions": [
                {"target": {"kind": "key", "key": "a"}, "expected": "missing"},
                {"target": {"kind": "record", "collection": "c", "id": "a"}, "expected": "present"},
                {"target": {"kind": "key", "key": "b"}, "expected": "missing"},
            ],
            "operations": [{"op": "delete", "key": "z"}],
        }
    )
    # Condition order is not part of a request's identity.
    assert first.request_digest == second.request_digest


def test_operation_order_is_part_of_the_digest() -> None:
    forward = validate_atomic_request(
        {
            "operations": [
                {"op": "set", "key": "a", "value": 1},
                {"op": "set", "key": "b", "value": 2},
            ]
        }
    )
    backward = validate_atomic_request(
        {
            "operations": [
                {"op": "set", "key": "b", "value": 2},
                {"op": "set", "key": "a", "value": 1},
            ]
        }
    )
    assert forward.request_digest != backward.request_digest


def test_the_digest_ignores_the_idempotency_key_but_not_the_outcome() -> None:
    base: dict[str, Any] = {"operations": [{"op": "set", "key": "k", "value": 1}]}
    bare = validate_atomic_request(base)
    under_key = validate_atomic_request({**base, "idempotency": {"key": "one"}})
    under_other_key = validate_atomic_request({**base, "idempotency": {"key": "two"}})
    assert bare.request_digest == under_key.request_digest == under_other_key.request_digest
    with_outcome = validate_atomic_request(
        {**base, "idempotency": {"key": "one", "outcome": {"ok": True}}}
    )
    assert with_outcome.request_digest != bare.request_digest


def test_integral_floats_and_ints_share_one_digest() -> None:
    as_int = validate_atomic_request({"operations": [{"op": "set", "key": "n", "value": 100}]})
    as_float = validate_atomic_request({"operations": [{"op": "set", "key": "n", "value": 100.0}]})
    assert as_int.request_digest == as_float.request_digest
    assert as_float.operations[0]["value"] == 100
    assert isinstance(as_float.operations[0]["value"], int)


def test_negative_zero_normalizes_inside_the_digest() -> None:
    negative = validate_atomic_request(
        {"operations": [{"op": "set", "key": "n", "value": {"deep": [-0.0]}}]}
    )
    positive = validate_atomic_request(
        {"operations": [{"op": "set", "key": "n", "value": {"deep": [0]}}]}
    )
    assert negative.request_digest == positive.request_digest


# ── Targets and limits ──────────────────────────────────────────────────────


def test_target_key_length_prefixes_every_component() -> None:
    assert target_key({"kind": "key", "key": "a"}) == "k:1:a"
    assert target_key({"kind": "record", "collection": "a:b", "id": "c"}) == "r:3:a:b:1:c"
    assert target_key({"kind": "record", "collection": "a", "id": "b:c"}) == "r:1:a:3:b:c"
    # UTF-16 code units, matching `String.prototype.length`.
    assert target_key({"kind": "key", "key": "\U0001f600"}) == "k:2:\U0001f600"


def test_compare_targets_orders_keys_before_records_in_code_point_order() -> None:
    key_a: dict[str, Any] = {"kind": "key", "key": "a"}
    key_b: dict[str, Any] = {"kind": "key", "key": "b"}
    record: dict[str, Any] = {"kind": "record", "collection": "a", "id": "a"}
    assert compare_targets(key_a, key_b) == -1
    assert compare_targets(key_b, key_a) == 1
    assert compare_targets(key_a, key_a) == 0
    assert compare_targets(key_b, record) == -1
    assert compare_targets(record, key_b) == 1
    # Code point order, not UTF-16: U+1F600 sorts above U+FFFD.
    assert compare_targets({"kind": "key", "key": "�"}, {"kind": "key", "key": "\U0001f600"}) == -1


def test_resolve_atomic_limits_merges_onto_the_base() -> None:
    assert resolve_atomic_limits() == DEFAULT_ATOMIC_LIMITS
    assert resolve_atomic_limits(None, IN_PROCESS_ATOMIC_LIMITS) == IN_PROCESS_ATOMIC_LIMITS
    merged = resolve_atomic_limits({"maxOperations": 10}, IN_PROCESS_ATOMIC_LIMITS)
    assert merged == AtomicMutationLimits(
        maxOperations=10,
        maxConditions=IN_PROCESS_ATOMIC_LIMITS.maxConditions,
        maxRequestBytes=IN_PROCESS_ATOMIC_LIMITS.maxRequestBytes,
    )
    assert resolve_atomic_limits(merged) == merged


@pytest.mark.parametrize(
    ("value", "rendered"),
    [(0, "0"), (-1, "-1"), (1.5, "1.5"), (None, "null"), (True, "true"), ("x", "x")],
)
def test_resolve_atomic_limits_names_the_bad_field(value: Any, rendered: str) -> None:
    with pytest.raises(ValueError) as caught:
        resolve_atomic_limits({"maxConditions": value})
    assert str(caught.value) == f"maxConditions must be a positive safe integer; got {rendered}."
