"""The explicitly enlisted memory-domain rollback journey, independent of SQLite leases."""

from __future__ import annotations

from .coordination import CoordinationLease, SystemClock
from .coordination_memory import createMemoryCoordinationState, createMemoryCoordinator
from .log import InMemoryLogStore
from .memory import InMemoryStore
from .transaction import create_memory_transactions


class _Clock(SystemClock):
    def now(self) -> int:
        return 1000


async def memory_transaction_rollback() -> dict[str, object]:
    kv = InMemoryStore()
    log = InMemoryLogStore()
    state = createMemoryCoordinationState()
    coordinator = createMemoryCoordinator(
        state=state, ownerTokenFactory=lambda: "repeated", clock=_Clock()
    )
    transactions = create_memory_transactions(kv=kv, log=log, coordination=state)

    async def acquire(key: str) -> CoordinationLease:
        result = await coordinator.tryAcquire(key, leaseMs=100)
        assert result["status"] == "acquired"
        return result["lease"]

    prior = await acquire("prior")
    escaped: list[CoordinationLease] = []
    premature_abort = False
    assertion_failed = False
    try:
        with transactions.transaction():
            kv.set("record", True)
            log.append("history", True)
            await prior.renew(500)
            await prior.release()
            try:
                prior.assertOwned()
            except RuntimeError:
                assertion_failed = True
            premature_abort = prior.signal.aborted
            escaped.append(await acquire("provisional"))
            raise RuntimeError("rollback")
    except RuntimeError as error:
        if str(error) != "rollback":
            raise
    prior.assertOwned()
    next_lease = await acquire("provisional")
    return {
        "recordPresent": kv.has("record"),
        "historyLength": len(log.list("history")),
        "priorExpiry": prior.expiresAt,
        "priorAborted": prior.signal.aborted,
        "assertionFailed": assertion_failed,
        "prematureAbort": premature_abort,
        "provisionalAborted": escaped[0].signal.aborted,
        "nextGeneration": next_lease.fencingGeneration,
        "staleRenewed": await escaped[0].renew(100),
        "staleReleased": await escaped[0].release(),
    }
