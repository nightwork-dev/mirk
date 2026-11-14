"""Shared corpus target using real store transactions."""

from __future__ import annotations

from typing import Any

from .store import QueueStore


class QueueConformanceTarget:
    def __init__(self, queue: QueueStore, clock: list[int]):
        self.queue = queue
        self.clock = clock
        self.claims: dict[str, Any] = {}
        self.sequence = 0

    def _key(self) -> dict[str, str]:
        self.sequence += 1
        return {"key": f"command-{self.sequence}"}

    def _version(self, id: str) -> str:
        item = self.queue.get(id)
        assert item is not None
        return str(item["version"])

    def setNow(self, value: int) -> None:
        self.clock[0] = value

    def enqueue(self, id: str, queue: str, payload: Any, priority: int = 0) -> Any:
        return self.queue.enqueue(
            {"id": id, "queue": queue, "payload": payload, "priority": priority}, self._key()
        )["value"]

    def enqueueCommand(self, input: Any, commandKey: str) -> Any:
        return self.queue.enqueue(input, {"key": commandKey})["value"]

    def resolveBlockedCommand(self, id: str, decision: Any, commandKey: str) -> Any:
        return self.queue.resolveBlocked(id, self._version(id), decision, {"key": commandKey})[
            "value"
        ]

    def rememberClaim(self, id: str, alias: str) -> None:
        self.claims[alias] = self.claims[id]

    def corruptRecord(self, id: str, patch: Any) -> None:
        item = self.queue.get(id)
        assert item is not None
        self.queue.store.put(self.queue.collection, {**item["value"], **patch})

    def start(self, input: Any, commandKey: str) -> Any:
        result = self.queue.start(input, {"key": commandKey})
        return {**result, "item": result["item"]["value"]}

    def listFiltered(self, filter: Any) -> Any:
        return [j["value"] for j in self.queue.list(filter)]

    def corruptActiveSlot(self, queue: str, activeKey: str, id: str) -> None:
        from mirk.store.canonical import canonical_json

        self.queue.store.set(
            "mirk-queue-active:" + canonical_json([self.queue.collection, queue, activeKey]), id
        )

    def seedLegacy(self, id: str) -> None:
        item = self.queue.get(id)
        assert item is not None
        legacy = {
            k: v for k, v in item["value"].items() if k not in {"activeKey", "subject", "kind"}
        }
        self.queue.store.put(self.queue.collection, {**legacy, "schemaVersion": 1})

    def runClaimNoop(self, id: str) -> str:
        import asyncio

        from mirk.store.coordination import CoordinationAbortSignal, SystemClock

        from .runner import run_claim

        clock = self.clock

        class FixtureClock(SystemClock):
            def now(self) -> int:
                return clock[0]

        async def work(_: CoordinationAbortSignal) -> str:
            return "work-done"

        return asyncio.run(
            run_claim(
                self.queue,
                self.claims[id],
                lease_ms=20,
                renew_every_ms=5,
                command_key=self._key()["key"],
                clock=FixtureClock(),
                work=work,
            )
        )

    def get(self, id: str) -> Any:
        result = self.queue.get(id)
        return result["value"] if result else None

    def list(self, queue: str) -> Any:
        return [j["value"] for j in self.queue.list({"queue": queue})]

    def claim(self, id: str, leaseMs: int) -> Any:
        result = self.queue.claim(id, {**self._key(), "leaseMs": leaseMs})
        if result:
            self.claims[result["itemId"]] = result
        return result

    def claimNext(self, queue: str, leaseMs: int) -> Any:
        result = self.queue.claimNext(queue, {**self._key(), "leaseMs": leaseMs})
        if result:
            self.claims[result["itemId"]] = result
        return result

    def __getattr__(self, name: str) -> Any:
        if name in {"renew", "checkpoint", "complete", "fail", "retry", "block"}:

            def worker(id: str, value: Any) -> Any:
                return getattr(self.queue, name)(self.claims[id], value, self._key())["value"]

            return worker
        if name in {"requestCancel", "acknowledgeCancel", "recoverExpired", "removeTerminal"}:

            def single(id: str) -> Any:
                if name == "requestCancel":
                    return self.queue.requestCancel(id, self._key())["value"]
                if name == "acknowledgeCancel":
                    return self.queue.acknowledgeCancel(self.claims[id], self._key())["value"]
                if name == "recoverExpired":
                    return self.queue.recoverExpired(
                        id, self.claims[id]["generation"], self._key()
                    )["value"]
                return self.queue.removeTerminal(id, self._version(id), self._key())

            return single
        if name in {"resolveBlocked", "updateQueued", "requeueTerminal"}:

            def resolve(id: str, decision: Any) -> Any:
                return getattr(self.queue, name)(id, self._version(id), decision, self._key())[
                    "value"
                ]

            return resolve
        raise AttributeError(name)


def conformance_target(backend: str, connection: Any) -> QueueConformanceTarget:
    from mirk.store.log import InMemoryLogStore
    from mirk.store.transaction import SqliteTransactions, create_memory_transactions

    transactions = (
        create_memory_transactions(kv=connection, log=InMemoryLogStore())
        if backend == "memory"
        else SqliteTransactions(connection)
    )
    clock = [100]
    tokens = [0]

    def token() -> str:
        tokens[0] += 1
        return f"owner-{tokens[0]}"

    return QueueConformanceTarget(
        QueueStore(store=connection, transactions=transactions, now=lambda: clock[0], token=token),
        clock,
    )
