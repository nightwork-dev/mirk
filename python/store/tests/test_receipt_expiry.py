"""Receipt expiry behaviors outside the corpus.

The expiry rules are pinned by the ``store/atomic/receipt-*`` scenarios. These
tests cover a file written by an earlier release, a backlog larger than one
batch, the default clock, and option checks.
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

import pytest

from mirk.store import RECEIPT_PRUNE_BATCH, InMemoryStore, SqliteStore

REQUEST = {
    "operations": [{"op": "set", "key": "k", "value": 1}],
    "idempotency": {"key": "once"},
}


def test_an_earlier_file_gets_the_column_and_its_receipts_one_full_window(tmp_path: Path) -> None:
    path = str(tmp_path / "legacy.db")
    legacy = sqlite3.connect(path)
    legacy.execute(
        "CREATE TABLE _mirk_atomic_receipts (idempotency_key TEXT PRIMARY KEY,"
        " request_digest TEXT NOT NULL, result_json TEXT NOT NULL)"
    )
    legacy.close()
    first = SqliteStore(path)
    assert first.mutateAtomically(REQUEST)["status"] == "applied"
    first.connection.execute("UPDATE _mirk_atomic_receipts SET created_at = NULL")
    first.close()

    clock = [5_000]
    store = SqliteStore(path, receipt_retention_ms=100, now=lambda: clock[0])
    try:
        assert store.mutateAtomically(REQUEST)["status"] == "replayed"
        clock[0] += 100
        assert store.pruneExpiredReceipts() == 0
        clock[0] += 1
        assert store.pruneExpiredReceipts() == 1
    finally:
        store.close()


def test_a_keyed_write_prunes_one_batch_and_an_explicit_prune_the_rest() -> None:
    clock = [1_000]
    store = SqliteStore(":memory:", receipt_retention_ms=10, now=lambda: clock[0])
    backlog = RECEIPT_PRUNE_BATCH * 2 + 5
    for index in range(backlog):
        store.mutateAtomically(
            {
                "operations": [{"op": "set", "key": f"k{index}", "value": index}],
                "idempotency": {"key": f"r{index}"},
            }
        )
    clock[0] += 11
    store.mutateAtomically(
        {"operations": [{"op": "set", "key": "x", "value": 0}], "idempotency": {"key": "x"}}
    )
    assert store.pruneExpiredReceipts() == backlog - RECEIPT_PRUNE_BATCH
    store.close()


def test_the_default_clock_is_wall_time_in_milliseconds() -> None:
    store = SqliteStore(":memory:")
    before = time.time() * 1000
    store.mutateAtomically(REQUEST)
    after = time.time() * 1000
    row = store.connection.execute("SELECT created_at FROM _mirk_atomic_receipts").fetchone()
    created_at = row[0]
    assert isinstance(created_at, int)
    assert before - 1 <= created_at <= after + 1
    assert store.receipt_retention_ms is None
    assert store.pruneExpiredReceipts() == 0
    store.close()


@pytest.mark.parametrize("value", [0, -1, 1.5, float("nan"), float("inf")])
def test_a_retention_window_must_be_a_positive_integer(value: float) -> None:
    with pytest.raises(ValueError, match="receiptRetentionMs must be a positive safe integer"):
        InMemoryStore(receipt_retention_ms=value)  # pyright: ignore[reportArgumentType]
    with pytest.raises(ValueError, match="receiptRetentionMs must be a positive safe integer"):
        SqliteStore(":memory:", receipt_retention_ms=value)  # pyright: ignore[reportArgumentType]
