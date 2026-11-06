"""Writer-admitted, version-fenced job lifecycle transitions."""

from __future__ import annotations

import copy
import time
import uuid
from collections.abc import Callable
from typing import Any, Protocol

from mirk.store.canonical import canonical_json

from .errors import JobsError
from .validation import (
    generation,
    validate_enqueue,
    validate_job,
    validate_outcome,
    validate_receipt,
)

Record = dict[str, Any]


class TransactionProvider(Protocol):
    def transaction(self) -> Any: ...


def _text(value: Any) -> None:
    if not isinstance(value, str) or not value:
        raise JobsError("invalid-input")


def validate_time(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 9007199254740991:
        raise JobsError("invalid-input")
    return value


def validate_positive(value: int) -> None:
    if validate_time(value) == 0:
        raise JobsError("invalid-input")


def _order(job: Record) -> tuple[int, int, str]:
    return (-job["priority"], job["enqueuedAt"], job["id"])


class JobsCore:
    def __init__(
        self,
        *,
        store: Any,
        transactions: TransactionProvider,
        collection: str = "mirk-jobs",
        now: Callable[[], int] | None = None,
        token: Callable[[], str] | None = None,
        log: Any = None,
        deleteHistoryOnRemove: bool = False,
    ):
        _text(collection)
        if not callable(getattr(store, "mutateAtomically", None)):
            raise JobsError("invalid-input")
        if log is not None and not callable(getattr(log, "append", None)):
            raise JobsError("invalid-input")
        if deleteHistoryOnRemove and not callable(getattr(log, "deleteStream", None)):
            raise JobsError("invalid-input")
        self.store = store
        self.transactions = transactions
        self.collection = collection
        self.now = now or (lambda: int(time.time() * 1000))
        self.token = token or (lambda: str(uuid.uuid4()))
        self.log = log
        self.delete_history = deleteHistoryOnRemove

    def _target(self, id: str) -> Record:
        return {"kind": "record", "collection": self.collection, "id": id}

    def _generation_key(self, id: str) -> str:
        return "mirk-jobs-generation:" + canonical_json([self.collection, id])

    def _stream(self, id: str) -> str:
        retained = self.store.get(self._generation_key(id))
        incarnation = 0 if retained is None else validate_time(generation(retained) + 1)
        return canonical_json([self.collection, id, incarnation])

    def get(self, id: str) -> Record | None:
        _text(id)
        result: Record | None = self.store.getVersioned(self._target(id))
        if result:
            validate_job(result["value"])
            if result["value"]["id"] != id:
                raise JobsError("invalid-input")
        return result

    def list(self, filter: Record | None = None) -> list[Record]:
        filter = filter or {}
        limit = filter.get("limit")
        if limit is not None:
            validate_time(limit)
        with self.transactions.transaction():
            records = self.store.list(self.collection)
            for job in records:
                validate_job(job)
            jobs = [
                j
                for j in records
                if ("queue" not in filter or j["queue"] == filter["queue"])
                and ("state" not in filter or j["state"] == filter["state"])
            ]
            jobs.sort(key=_order)
            return [self._require(j["id"]) for j in jobs[:limit]]

    def _command(self, name: str, input: Any, command: Record, work: Callable[[], Any]) -> Any:
        _text(command["key"])
        intent = canonical_json({"name": name, "input": input})
        key = "mirk-jobs-command:" + canonical_json([self.collection, command["key"]])
        with self.transactions.transaction():
            receipt = self.store.get(key)
            if receipt is not None:
                validate_receipt(receipt)
                validate_outcome(name, receipt["outcome"])
                if receipt["intent"] != intent:
                    raise JobsError("idempotency-conflict")
                return copy.deepcopy(receipt["outcome"])
            outcome = work()
            validate_outcome(name, outcome)
            result = self.store.mutateAtomically(
                {
                    "conditions": [{"target": {"kind": "key", "key": key}, "expected": "missing"}],
                    "operations": [
                        {"op": "set", "key": key, "value": {"intent": intent, "outcome": outcome}}
                    ],
                }
            )
            if result["status"] != "applied":
                raise JobsError("conflict")
            return outcome

    def _save(self, job: Record, prior: Record | None, event: str) -> Record:
        validate_job(job)
        condition = {"target": self._target(job["id"]), "expected": "missing"}
        if prior:
            condition.update(expected="version", version=prior["version"])
        result = self.store.mutateAtomically(
            {
                "conditions": [condition],
                "operations": [{"op": "put", "collection": self.collection, "item": job}],
            }
        )
        if result["status"] != "applied":
            raise JobsError("conflict")
        if self.log is not None:
            self.log.append(self._stream(job["id"]), {"event": event, "job": job})
        return self._require(job["id"])

    def _require(self, id: str) -> Record:
        result = self.get(id)
        if result is None:
            raise JobsError("not-found")
        return result

    def _owned(self, job: Record, claim: Record, now: int) -> None:
        if (
            job["state"] != "leased"
            or job["ownerToken"] != claim["ownerToken"]
            or job["generation"] != claim["generation"]
            or job["expiresAt"] is None
            or job["expiresAt"] <= now
        ):
            raise JobsError("stale-claim")

    def enqueue(self, input: Record, command: Record) -> Record:
        validate_enqueue(input)
        _text(input["id"])
        _text(input["queue"])
        canonical_json(input["payload"])
        priority = input.get("priority", 0)
        if (
            isinstance(priority, bool)
            or not isinstance(priority, int)
            or abs(priority) > 9007199254740991
        ):
            raise JobsError("invalid-input")
        if "availableAt" in input:
            validate_time(input["availableAt"])

        def work() -> Record:
            retained_generation = self.store.get(self._generation_key(input["id"]))
            initial_generation = (
                0
                if retained_generation is None
                else validate_time(generation(retained_generation) + 1)
            )
            now = validate_time(self.now())
            job = {
                **input,
                "schemaVersion": 1,
                "state": "queued",
                "priority": priority,
                "availableAt": input.get("availableAt", now),
                "enqueuedAt": now,
                "updatedAt": now,
                "attempt": 0,
                "generation": initial_generation,
                "ownerToken": None,
                "expiresAt": None,
                "checkpoint": None,
                "cancellation": None,
                "result": None,
                "error": None,
            }
            return self._save(job, None, "enqueue")

        return self._command("enqueue", input, command, work)

    def _claim(self, id: str, lease_ms: int) -> Record | None:
        prior = self.get(id)
        now = validate_time(self.now())
        if (
            prior is None
            or prior["value"]["state"] != "queued"
            or prior["value"]["cancellation"]
            or prior["value"]["availableAt"] > now
        ):
            return None
        owner = self.token()
        _text(owner)
        job = {
            **prior["value"],
            "state": "leased",
            "ownerToken": owner,
            "generation": prior["value"]["generation"] + 1,
            "attempt": prior["value"]["attempt"] + 1,
            "expiresAt": validate_time(now + lease_ms),
            "updatedAt": now,
        }
        self._save(job, prior, "claim")
        return {"jobId": id, "ownerToken": owner, "generation": job["generation"]}

    def _claim_command(
        self, name: str, input: Record, options: Record, work: Callable[[], Record | None]
    ) -> Record | None:
        validate_positive(options["leaseMs"])
        with self.transactions.transaction():
            claim: Record | None = self._command(name, input, options, work)
            if claim:
                self._owned(
                    self._require(claim["jobId"])["value"], claim, validate_time(self.now())
                )
            return claim

    def claim(self, id: str, options: Record) -> Record | None:
        _text(id)
        return self._claim_command(
            "claim",
            {"id": id, "leaseMs": options["leaseMs"]},
            options,
            lambda: self._claim(id, options["leaseMs"]),
        )

    def claimNext(self, queue: str, options: Record) -> Record | None:
        _text(queue)

        def work() -> Record | None:
            now = validate_time(self.now())
            records = self.store.list(self.collection)
            for job in records:
                validate_job(job)
            jobs = [
                j
                for j in records
                if j["queue"] == queue
                and j["state"] == "queued"
                and not j["cancellation"]
                and j["availableAt"] <= now
            ]
            jobs.sort(key=_order)
            return self._claim(jobs[0]["id"], options["leaseMs"]) if jobs else None

        return self._claim_command(
            "claimNext", {"queue": queue, "leaseMs": options["leaseMs"]}, options, work
        )
