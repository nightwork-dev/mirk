"""Cooperative renewal for one existing claim, without execution policy."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from mirk.store.canonical import canonical_json
from mirk.store.coordination import CoordinationAbortSignal, CoordinationClock, SystemClock

from .core import validate_positive
from .errors import JobsError
from .store import JobsStore
from .validation import validate_claim


async def run_claim[T](
    jobs: JobsStore,
    claim: dict[str, Any],
    *,
    lease_ms: int,
    renew_every_ms: int,
    command_key: str,
    work: Callable[[CoordinationAbortSignal], Awaitable[T]],
    clock: CoordinationClock | None = None,
    signal: CoordinationAbortSignal | None = None,
) -> T:
    validate_claim(claim)
    claim = dict(claim)
    validate_positive(lease_ms)
    validate_positive(renew_every_ms)
    if renew_every_ms >= lease_ms or type(command_key) is not str or not command_key:
        raise JobsError("invalid-input")
    clock = clock or SystemClock()
    controller, sleeper = CoordinationAbortSignal(), CoordinationAbortSignal()
    stopped = False
    sequence = 0

    def abort(reason: BaseException | None) -> None:
        controller.abort(reason)
        sleeper.abort(reason)

    def external() -> None:
        abort(signal.reason if signal else None)

    if signal:
        signal.add(external)

    def check() -> None:
        with jobs.transactions.transaction():
            if controller.aborted:
                assert controller.reason is not None
                raise controller.reason
            current = jobs.get(claim["jobId"])
            now = clock.now()
            if (
                not current
                or current["value"]["state"] != "leased"
                or current["value"]["ownerToken"] != claim["ownerToken"]
                or current["value"]["generation"] != claim["generation"]
                or current["value"]["expiresAt"] is None
                or current["value"]["expiresAt"] <= now
            ):
                raise JobsError("stale-claim")
            if current["value"]["cancellation"]:
                raise JobsError("cancel-requested")

    def renew() -> None:
        nonlocal sequence
        check()
        key = canonical_json(
            [
                "runClaim",
                command_key,
                claim["jobId"],
                claim["ownerToken"],
                claim["generation"],
                sequence,
            ]
        )
        sequence += 1
        jobs.renew(claim, lease_ms, {"key": key})
        check()

    async def monitor() -> None:
        try:
            while not stopped:
                await clock.sleep(renew_every_ms, sleeper)
                if not stopped:
                    renew()
        except Exception as error:
            if not stopped:
                abort(error)

    task: asyncio.Task[None] | None = None
    try:
        renew()
        task = asyncio.create_task(monitor())
        result = await work(controller)
        stopped = True
        sleeper.abort()
        await task
        task = None
        check()
        return result
    finally:
        stopped = True
        sleeper.abort()
        if signal:
            signal.remove(external)
        if task:
            await task
