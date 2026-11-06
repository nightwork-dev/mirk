"""Explicitly shared in-memory coordination state."""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass, field

from .coordination import CoordinationClock, Held, SystemClock
from .coordination_engine import Acquisition, LeaseCoordinator, LeaseIdentity


@dataclass
class MemoryCoordinationState:
    leases: dict[tuple[str, str], tuple[str, int, int]] = field(
        default_factory=lambda: dict[tuple[str, str], tuple[str, int, int]]()
    )
    generations: dict[tuple[str, str], int] = field(
        default_factory=lambda: dict[tuple[str, str], int]()
    )
    lock: threading.RLock = field(default_factory=threading.RLock)


def createMemoryCoordinationState() -> MemoryCoordinationState:
    return MemoryCoordinationState()


class _MemoryBackend:
    def __init__(
        self, state: MemoryCoordinationState, namespace: str, clock: CoordinationClock
    ) -> None:
        self.state = state
        self.namespace = namespace
        self.clock = clock

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
