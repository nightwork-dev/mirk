"""Portable fenced lease coordination contracts and clock."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Literal, Protocol, TypedDict, TypeVar

T = TypeVar("T")


class CoordinationTimeoutError(TimeoutError):
    def __init__(self, key: str, waitMs: int, namespace: str) -> None:
        super().__init__(f'Timed out waiting {waitMs}ms for "{key}" in "{namespace}".')
        self.key = key
        self.waitMs = waitMs
        self.namespace = namespace


class CoordinationAbortedError(RuntimeError):
    pass


class CoordinationOwnershipLostError(RuntimeError):
    pass


class CoordinationAbortSignal:
    def __init__(self) -> None:
        self.aborted = False
        self.reason: BaseException | None = None
        self._listeners: set[Callable[[], None]] = set()

    def abort(self, reason: BaseException | None = None) -> None:
        if not self.aborted:
            self.aborted = True
            self.reason = reason or CoordinationAbortedError("Aborted")
            for listener in list(self._listeners):
                listener()

    def add(self, listener: Callable[[], None]) -> None:
        self._listeners.add(listener)
        if self.aborted:
            listener()

    def remove(self, listener: Callable[[], None]) -> None:
        self._listeners.discard(listener)


class CoordinationClock(Protocol):
    def now(self) -> int: ...
    async def sleep(self, ms: int, signal: CoordinationAbortSignal | None = None) -> None: ...


class SystemClock:
    def now(self) -> int:
        return time.time_ns() // 1_000_000

    async def sleep(self, ms: int, signal: CoordinationAbortSignal | None = None) -> None:
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        timer = asyncio.get_running_loop().call_later(
            ms / 1000, lambda: None if future.done() else future.set_result(None)
        )

        def abort() -> None:
            if not future.done():
                future.set_exception(
                    signal.reason if signal and signal.reason else CoordinationAbortedError()
                )

        if signal:
            signal.add(abort)
        try:
            await future
        finally:
            timer.cancel()
            if signal:
                signal.remove(abort)


class CoordinationGuard(Protocol):
    key: str
    ownerToken: str
    fencingGeneration: int
    signal: CoordinationAbortSignal

    def assertOwned(self) -> None: ...


class CoordinationLease(CoordinationGuard, Protocol):
    @property
    def expiresAt(self) -> int: ...

    async def renew(self, leaseMs: int) -> bool: ...
    async def release(self) -> bool: ...


class Acquired(TypedDict):
    status: Literal["acquired"]
    lease: CoordinationLease


class Held(TypedDict):
    status: Literal["held"]
    expiresAt: int


class Unavailable(TypedDict):
    status: Literal["unavailable"]
    retryable: Literal[True]


CoordinationAcquireResult = Acquired | Held | Unavailable


class AsyncCoordinator(Protocol):
    async def tryAcquire(
        self, key: str, *, leaseMs: int = 5000, signal: CoordinationAbortSignal | None = None
    ) -> CoordinationAcquireResult: ...
    async def runExclusive(
        self,
        key: str,
        work: Callable[[CoordinationGuard], Awaitable[T]],
        *,
        waitMs: int = 30000,
        leaseMs: int = 5000,
        renewEveryMs: int | None = None,
        signal: CoordinationAbortSignal | None = None,
    ) -> T: ...


def conformance_target(backend: str, connection: object) -> object:
    from .coordination_conformance import CoordinationTarget
    from .coordination_memory import createMemoryCoordinationState, createMemoryCoordinator

    if backend == "sqlite":
        from .coordination_sqlite import conformance_coordinator

        return CoordinationTarget(lambda clock: conformance_coordinator(connection, clock))
    state = createMemoryCoordinationState()
    return CoordinationTarget(lambda clock: createMemoryCoordinator(state=state, clock=clock))
