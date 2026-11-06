"""Synchronous corpus adapter over the immediate lease API."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from .coordination import (
    AsyncCoordinator,
    CoordinationAbortSignal,
    CoordinationClock,
    CoordinationLease,
)


class _Clock:
    def __init__(self) -> None:
        self.time = 1000

    def now(self) -> int:
        return self.time

    async def sleep(self, ms: int, signal: CoordinationAbortSignal | None = None) -> None:
        raise RuntimeError("Unexpected timed wait in immediate lease scenario.")


class CoordinationTarget:
    def __init__(self, create: Callable[[CoordinationClock], AsyncCoordinator]) -> None:
        self.clock = _Clock()
        self.coordinator = create(self.clock)
        self.leases: dict[str, CoordinationLease] = {}

    def advance(self, ms: int) -> int:
        self.clock.time += ms
        return self.clock.time

    def acquire(self, handle: str, key: str, leaseMs: int) -> object:
        result = asyncio.run(self.coordinator.tryAcquire(key, leaseMs=leaseMs))
        if result["status"] != "acquired":
            return result
        lease = result["lease"]
        self.leases[handle] = lease
        return {
            "status": "acquired",
            "fencingGeneration": lease.fencingGeneration,
            "expiresAt": lease.expiresAt,
        }

    def renew(self, handle: str, leaseMs: int) -> bool:
        return asyncio.run(self.leases[handle].renew(leaseMs))

    def release(self, handle: str) -> bool:
        return asyncio.run(self.leases[handle].release())

    def owned(self, handle: str) -> bool:
        try:
            self.leases[handle].assertOwned()
            return True
        except RuntimeError:
            return False
