"""Explicitly shared in-memory coordination state."""

# pyright: reportPrivateUsage=false

from __future__ import annotations

import threading
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, TypeVar, cast

if TYPE_CHECKING:
    from .transaction import Transactions

from .coordination import CoordinationClock, Held, SystemClock
from .coordination_engine import Acquisition, LeaseCoordinator, LeaseIdentity

T = TypeVar("T")


@dataclass
class MemoryCoordinationState:
    leases: dict[tuple[str, str], tuple[str, int, int]] = field(
        default_factory=lambda: dict[tuple[str, str], tuple[str, int, int]]()
    )
    generations: dict[tuple[str, str], int] = field(
        default_factory=lambda: dict[tuple[str, str], int]()
    )
    lock: threading.RLock = field(default_factory=threading.RLock)
    _transaction_domain: Transactions | None = field(default=None, repr=False)

    def _transaction_checkpoint(self) -> object:
        with self.lock:
            return dict(self.leases)

    def _transaction_restore(self, state: object) -> None:
        with self.lock:
            self.leases.clear()
            self.leases.update(cast(dict[tuple[str, str], tuple[str, int, int]], state))


def createMemoryCoordinationState() -> MemoryCoordinationState:
    return MemoryCoordinationState()


class _MemoryBackend:
    def __init__(
        self, state: MemoryCoordinationState, namespace: str, clock: CoordinationClock
    ) -> None:
        self.state = state
        self.namespace = namespace
        self.clock = clock
        self.participation = self

    def check(self) -> None:
        if self.state._transaction_domain is not None:
            self.state._transaction_domain.check()

    def available(self) -> bool:
        domain = self.state._transaction_domain
        return domain.available() if domain else True

    async def run(self, work: Callable[[], Awaitable[T]]) -> T:
        domain = self.state._transaction_domain
        return await domain.run_operation(work) if domain else await work()

    def afterCommit(self, work: Callable[[], None]) -> None:
        domain = self.state._transaction_domain
        if domain:
            domain.after_commit(work)
        else:
            work()

    def afterRollback(self, work: Callable[[], None]) -> None:
        domain = self.state._transaction_domain
        if domain:
            domain.after_rollback(work)

    def _owned(self, lease: LeaseIdentity, now: int | None = None) -> bool:
        row = self.state.leases.get((self.namespace, lease.key))
        return bool(
            row
            and row[0] == lease.ownerToken
            and row[1] == lease.fencingGeneration
            and row[2] > (self.clock.now() if now is None else now)
        )

    def acquire(self, key: str, token: str, leaseMs: int) -> Acquisition | Held:
        with self.state.lock:
            address = (self.namespace, key)
            row = self.state.leases.get(address)
            now = self.clock.now()
            if row and row[2] > now:
                return {"status": "held", "expiresAt": row[2]}
            generation = self.state.generations.get(address, 0) + 1
            if generation > 2**53 - 1:
                raise OverflowError("Coordination fencing generation exhausted")
            self.state.generations[address] = generation
            self.state.leases[address] = (token, generation, now + leaseMs)
            return {"fencingGeneration": generation, "expiresAt": now + leaseMs}

    def renew(self, lease: LeaseIdentity, leaseMs: int) -> int | None:
        with self.state.lock:
            now = self.clock.now()
            if not self._owned(lease, now):
                return None
            expires = now + leaseMs
            self.state.leases[self.namespace, lease.key] = (
                lease.ownerToken,
                lease.fencingGeneration,
                expires,
            )
            return expires

    def release(self, lease: LeaseIdentity) -> bool:
        with self.state.lock:
            if not self._owned(lease):
                return False
            del self.state.leases[self.namespace, lease.key]
            return True

    def isOwned(self, lease: LeaseIdentity) -> bool:
        self.check()
        with self.state.lock:
            return self._owned(lease)


def createMemoryCoordinator(
    *,
    state: MemoryCoordinationState,
    namespace: str = "default",
    clock: CoordinationClock | None = None,
    ownerTokenFactory: Callable[[], str] | None = None,
) -> LeaseCoordinator:
    clock = clock or SystemClock()
    return LeaseCoordinator(
        _MemoryBackend(state, namespace, clock),
        namespace=namespace,
        clock=clock,
        ownerTokenFactory=ownerTokenFactory,
    )
