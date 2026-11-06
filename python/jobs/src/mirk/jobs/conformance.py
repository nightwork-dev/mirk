"""Shared corpus target using real store transactions."""

from __future__ import annotations

from typing import Any

from .store import JobsStore


class JobsConformanceTarget:
    def __init__(self, jobs: JobsStore, clock: list[int]):
        self.jobs = jobs
        self.clock = clock
        self.claims: dict[str, Any] = {}
        self.sequence = 0

    def _key(self) -> dict[str, str]:
        self.sequence += 1
        return {"key": f"command-{self.sequence}"}

    def _version(self, id: str) -> str:
        job = self.jobs.get(id)
        assert job is not None
        return str(job["version"])

    def setNow(self, value: int) -> None:
        self.clock[0] = value

    def enqueue(self, id: str, queue: str, payload: Any, priority: int = 0) -> Any:
        return self.jobs.enqueue(
            {"id": id, "queue": queue, "payload": payload, "priority": priority}, self._key()
        )["value"]

    def get(self, id: str) -> Any:
        result = self.jobs.get(id)
        return result["value"] if result else None

    def list(self, queue: str) -> Any:
        return [j["value"] for j in self.jobs.list({"queue": queue})]

    def claim(self, id: str, leaseMs: int) -> Any:
        result = self.jobs.claim(id, {**self._key(), "leaseMs": leaseMs})
        if result:
            self.claims[result["jobId"]] = result
        return result

    def claimNext(self, queue: str, leaseMs: int) -> Any:
        result = self.jobs.claimNext(queue, {**self._key(), "leaseMs": leaseMs})
        if result:
            self.claims[result["jobId"]] = result
        return result

    def __getattr__(self, name: str) -> Any:
        if name in {"renew", "checkpoint", "complete", "fail", "retry", "block"}:

            def worker(id: str, value: Any) -> Any:
                return getattr(self.jobs, name)(self.claims[id], value, self._key())["value"]

            return worker
        if name in {"requestCancel", "acknowledgeCancel", "recoverExpired", "removeTerminal"}:

            def single(id: str) -> Any:
                if name == "requestCancel":
                    return self.jobs.requestCancel(id, self._key())["value"]
                if name == "acknowledgeCancel":
                    return self.jobs.acknowledgeCancel(self.claims[id], self._key())["value"]
                if name == "recoverExpired":
                    return self.jobs.recoverExpired(id, self.claims[id]["generation"], self._key())[
                        "value"
                    ]
                return self.jobs.removeTerminal(id, self._version(id), self._key())

            return single
        if name in {"resolveBlocked", "updateQueued", "requeueTerminal"}:

            def resolve(id: str, decision: Any) -> Any:
                return getattr(self.jobs, name)(id, self._version(id), decision, self._key())[
                    "value"
                ]

            return resolve
        raise AttributeError(name)


def conformance_target(backend: str, connection: Any) -> JobsConformanceTarget:
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

    return JobsConformanceTarget(
        JobsStore(store=connection, transactions=transactions, now=lambda: clock[0], token=token),
        clock,
    )
