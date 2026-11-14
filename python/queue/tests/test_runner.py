import asyncio
from typing import Any

import pytest
from mirk.store.coordination import CoordinationAbortSignal

from mirk.queue import QueueError, run_claim
from test_queue import fixture as fixture


class Clock:
    def __init__(self, time: list[int]):
        self.time = time
        self.pending: list[tuple[int, asyncio.Future[None]]] = []
        self.cancel_task: asyncio.Task[Any] | None = None

    def now(self) -> int:
        return self.time[0]

    async def sleep(self, ms: int, signal: CoordinationAbortSignal | None = None) -> None:
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        entry = (self.now() + ms, future)
        self.pending.append(entry)

        def abort() -> None:
            if not future.done():
                future.set_exception(
                    signal.reason if signal and signal.reason else ValueError("stop")
                )
                if self.cancel_task:
                    self.cancel_task.cancel()
                    self.cancel_task = None

        if signal:
            signal.add(abort)
        try:
            await future
        finally:
            self.pending.remove(entry)
            if signal:
                signal.remove(abort)

    def advance(self, value: int) -> None:
        self.time[0] = value
        for at, future in list(self.pending):
            if at <= value and not future.done():
                future.set_result(None)


async def drain(test: Any) -> None:
    for _ in range(100):
        if test():
            return
        await asyncio.sleep(0)
    raise AssertionError("Clock work did not settle")


@pytest.mark.parametrize("ending", ["cancel", "expire", "external", "lost"])
def test_runner_renewal_abort_and_cleanup(fixture: Any, ending: str) -> None:
    queue, _, time = fixture
    clock = Clock(time)
    queue.enqueue({"id": "item", "queue": "q", "payload": None}, {"key": "e"})
    claim = queue.claim("item", {"key": "c", "leaseMs": 10})

    async def scenario() -> None:
        async def failing(_: CoordinationAbortSignal) -> str:
            raise ValueError("callback error")

        with pytest.raises(ValueError, match="callback error"):
            await run_claim(
                queue,
                claim,
                lease_ms=10,
                renew_every_ms=3,
                command_key="failure",
                clock=clock,
                work=failing,
            )
        assert not clock.pending
        external = CoordinationAbortSignal()
        gate: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        async def work(signal: CoordinationAbortSignal) -> str:
            def abort() -> None:
                if not gate.done():
                    gate.set_result(None)

            signal.add(abort)
            try:
                await gate
                return "ignored-abort"
            finally:
                signal.remove(abort)

        task = asyncio.create_task(
            run_claim(
                queue,
                claim,
                lease_ms=10,
                renew_every_ms=3,
                command_key="runner",
                clock=clock,
                signal=external,
                work=work,
            )
        )
        await drain(lambda: len(clock.pending) == 1)
        if ending == "cancel":
            clock.advance(103)
            await drain(lambda: queue.get("item")["value"]["expiresAt"] == 113)
            queue.requestCancel("item", {"key": "cancel"})
            clock.advance(106)
            expected = "cancel-requested"
        elif ending == "expire":
            clock.advance(110)
            expected = "stale-claim"
        elif ending == "external":
            external.abort(ValueError("external"))
            expected = "external"
        else:
            queue.complete(claim, None, {"key": "other-handler"})
            gate.set_result(None)
            expected = "stale-claim"
        with pytest.raises((QueueError, ValueError), match=expected):
            await task
        assert not clock.pending
        if ending == "expire":
            assert queue.get("item")["value"]["expiresAt"] == 110

    asyncio.run(scenario())


def test_runner_preserves_cancellation_during_cleanup(fixture: Any) -> None:
    queue, _, time = fixture
    clock = Clock(time)
    queue.enqueue({"id": "item", "queue": "q", "payload": None}, {"key": "e"})
    claim = queue.claim("item", {"key": "c", "leaseMs": 10})

    async def scenario() -> None:
        async def work(_: CoordinationAbortSignal) -> str:
            await asyncio.sleep(0)
            return "done"

        task = asyncio.create_task(
            run_claim(
                queue,
                claim,
                lease_ms=10,
                renew_every_ms=3,
                command_key="runner",
                clock=clock,
                work=work,
            )
        )
        clock.cancel_task = task
        try:
            await task
        except asyncio.CancelledError:
            assert task.cancelling() == 1
            assert task.cancelled()
        else:
            pytest.fail("run_claim swallowed cancellation during monitor cleanup")

    asyncio.run(scenario())
    assert not clock.pending
