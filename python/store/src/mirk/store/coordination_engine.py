"""One lease state machine for all coordination backends."""

from __future__ import annotations

import asyncio
import contextlib
import uuid
from collections.abc import Awaitable, Callable
from typing import Literal, Protocol, TypedDict, TypeVar, cast

from .coordination import (
    CoordinationAbortedError,
    CoordinationAbortSignal,
    CoordinationAcquireResult,
    CoordinationClock,
    CoordinationGuard,
    CoordinationOwnershipLostError,
    CoordinationTimeoutError,
    Held,
    SystemClock,
    Unavailable,
)

T = TypeVar("T")


class LeaseParticipation(Protocol):
    def check(self) -> None: ...
    async def run(self, work: Callable[[], Awaitable[T]]) -> T: ...
    def afterCommit(self, work: Callable[[], None]) -> None: ...
    def afterRollback(self, work: Callable[[], None]) -> None: ...


def participation(backend: LeaseBackend) -> LeaseParticipation | None:
    return cast(LeaseParticipation | None, getattr(backend, "participation", None))


class LeaseIdentity(Protocol):
    key: str
    ownerToken: str
    fencingGeneration: int

    @property
    def expiresAt(self) -> int: ...


class Acquisition(TypedDict):
    fencingGeneration: int
    expiresAt: int


class LeaseBackend(Protocol):
    def acquire(self, key: str, token: str, leaseMs: int) -> Acquisition | Held | Unavailable: ...
    def renew(self, lease: LeaseIdentity, leaseMs: int) -> int | Literal["unavailable"] | None: ...
    def release(self, lease: LeaseIdentity) -> bool | Literal["unavailable"]: ...
    def isOwned(self, lease: LeaseIdentity) -> bool: ...


def positive(value: int, name: str) -> int:
    if isinstance(value, bool) or type(value) is not int or not 0 < value <= 2**53 - 1:
        raise ValueError(f"{name} must be a positive safe integer")
    return value


class ManagedLease:
    def __init__(
        self,
        backend: LeaseBackend,
        namespace: str,
        key: str,
        token: str,
        generation: int,
        expires: int,
        clock: CoordinationClock,
    ) -> None:
        self.backend = backend
        self.clock = clock
        self.namespace = namespace
        self.key = key
        self.ownerToken = token
        self.fencingGeneration = generation
        self._expiresAt = expires
        self.participation = participation(backend)
        self.signal = CoordinationAbortSignal()

    @property
    def expiresAt(self) -> int:
        if self.participation:
            self.participation.check()
        return self._expiresAt

    def _lost(self) -> CoordinationOwnershipLostError:
        error = CoordinationOwnershipLostError(
            f'Lost "{self.key}" generation {self.fencingGeneration} in "{self.namespace}"'
        )
        if self.participation:
            self.participation.afterCommit(lambda: self.signal.abort(error))
        else:
            self.signal.abort(error)
        return error

    def assertOwned(self) -> None:
        if self.participation:
            self.participation.check()
        if self.signal.aborted:
            raise self.signal.reason or CoordinationOwnershipLostError()
        if not self.backend.isOwned(self):
            raise self._lost()

    async def renew(self, leaseMs: int) -> bool:
        async def work() -> bool:
            return await self._renew(leaseMs)

        return await self.participation.run(work) if self.participation else await work()

    async def _renew(self, leaseMs: int) -> bool:
        positive(leaseMs, "leaseMs")
        if self.signal.aborted:
            return False
        while self.clock.now() < self.expiresAt and not self.signal.aborted:
            expiry = self.backend.renew(self, leaseMs)
            if expiry == "unavailable":
                try:
                    await self.clock.sleep(
                        max(0, min(5, self.expiresAt - self.clock.now())), self.signal
                    )
                except Exception:
                    if self.signal.aborted:
                        return False
                    raise
                continue
            if expiry is None:
                self._lost()
                return False
            previous = self._expiresAt
            if self.participation:
                self.participation.afterRollback(
                    lambda previous=previous: setattr(self, "_expiresAt", previous)
                )
            self._expiresAt = expiry
            return True
        self._lost()
        return False

    async def release(self) -> bool:
        return (
            await self.participation.run(self._release)
            if self.participation
            else await self._release()
        )

    async def _release(self) -> bool:
        while self.clock.now() < self.expiresAt:
            released = self.backend.release(self)
            if released == "unavailable":
                await self.clock.sleep(max(0, min(5, self.expiresAt - self.clock.now())))
                continue
            self._lost()
            return released
        self._lost()
        return False


class LeaseCoordinator:
    def __init__(
        self,
        backend: LeaseBackend,
        *,
        namespace: str = "default",
        clock: CoordinationClock | None = None,
        ownerTokenFactory: Callable[[], str] | None = None,
    ) -> None:
        self.backend = backend
        self.namespace = namespace
        self.clock = clock or SystemClock()
        self.token = ownerTokenFactory or (lambda: str(uuid.uuid4()))

    def _check(self, signal: CoordinationAbortSignal | None) -> None:
        if signal and signal.aborted:
            raise CoordinationAbortedError("Coordination aborted") from signal.reason

    async def tryAcquire(
        self, key: str, *, leaseMs: int = 5000, signal: CoordinationAbortSignal | None = None
    ) -> CoordinationAcquireResult:
        async def acquire() -> CoordinationAcquireResult:
            return await self._tryAcquire(key, leaseMs=leaseMs, signal=signal)

        domain = participation(self.backend)
        return await domain.run(acquire) if domain else await acquire()

    async def _tryAcquire(
        self, key: str, *, leaseMs: int, signal: CoordinationAbortSignal | None
    ) -> CoordinationAcquireResult:
        if type(key) is not str or not key:
            raise ValueError("coordination key must not be empty")
        positive(leaseMs, "leaseMs")
        self._check(signal)
        token = self.token()
        result = self.backend.acquire(key, token, leaseMs)
        if "status" in result:
            return result
        lease = ManagedLease(
            self.backend,
            self.namespace,
            key,
            token,
            result["fencingGeneration"],
            result["expiresAt"],
            self.clock,
        )
        domain = participation(self.backend)
        if domain:
            domain.afterRollback(
                lambda: lease.signal.abort(
                    CoordinationOwnershipLostError("Provisional lease acquisition rolled back")
                )
            )
        if signal and signal.aborted:
            await lease.release()
            self._check(signal)
        return {"status": "acquired", "lease": lease}

    async def runExclusive(
        self,
        key: str,
        work: Callable[[CoordinationGuard], Awaitable[T]],
        *,
        waitMs: int = 30000,
        leaseMs: int = 5000,
        renewEveryMs: int | None = None,
        signal: CoordinationAbortSignal | None = None,
    ) -> T:
        if isinstance(waitMs, bool) or type(waitMs) is not int or not 0 <= waitMs <= 2**53 - 1:
            raise ValueError("waitMs must be a non-negative safe integer")
        positive(leaseMs, "leaseMs")
        interval = positive(
            renewEveryMs if renewEveryMs is not None else max(1, leaseMs // 3), "renewEveryMs"
        )
        if interval >= leaseMs:
            raise ValueError("renewEveryMs must be less than leaseMs")
        deadline = self.clock.now() + waitMs
        first = True
        while True:
            self._check(signal)
            if (not first or waitMs > 0) and self.clock.now() >= deadline:
                raise CoordinationTimeoutError(key, waitMs, self.namespace)
            first = False
            result = await self.tryAcquire(key, leaseMs=leaseMs, signal=signal)
            if result["status"] == "acquired":
                lease = result["lease"]
                break
            if waitMs == 0 or self.clock.now() >= deadline:
                raise CoordinationTimeoutError(key, waitMs, self.namespace)
            try:
                await self.clock.sleep(min(50, max(0, deadline - self.clock.now())), signal)
            except Exception:
                self._check(signal)
                raise
        stop = CoordinationAbortSignal()

        def abort() -> None:
            lease.signal.abort(CoordinationAbortedError("Coordination aborted"))

        if signal:
            signal.add(abort)

        async def renew() -> None:
            try:
                while not stop.aborted and not lease.signal.aborted:
                    await self.clock.sleep(interval, stop)
                    if stop.aborted or lease.signal.aborted:
                        break
                    if not await lease.renew(leaseMs):
                        break
            except Exception as error:
                if not stop.aborted:
                    lease.signal.abort(error)

        renewal = asyncio.create_task(renew())
        try:
            lease.assertOwned()
            return await work(lease)
        finally:
            stop.abort()
            if signal:
                signal.remove(abort)
            renewal.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await renewal
            await lease.release()
