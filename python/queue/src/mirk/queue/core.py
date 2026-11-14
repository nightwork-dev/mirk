"""Writer-admitted, version-fenced item lifecycle transitions."""

from __future__ import annotations

import copy
import time
import uuid
from collections.abc import Callable
from typing import Any, Protocol

from mirk.store.canonical import canonical_json

from .discovery import QueueDiscovery
from .errors import QueueError
from .validation import (
    generation,
    normalize_item,
    normalize_outcome,
    validate_enqueue,
    validate_item,
    validate_outcome,
    validate_receipt,
)

Record = dict[str, Any]


class TransactionProvider(Protocol):
    def transaction(self) -> Any: ...


def _text(value: Any) -> None:
    if not isinstance(value, str) or not value:
        raise QueueError("invalid-input")


def validate_time(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 9007199254740991:
        raise QueueError("invalid-input")
    return value


def validate_positive(value: int) -> None:
    if validate_time(value) == 0:
        raise QueueError("invalid-input")


def _order(item: Record) -> tuple[int, int, str]:
    return (-item["priority"], item["enqueuedAt"], item["id"])


class QueueCore(QueueDiscovery):
    def __init__(
        self,
        *,
        store: Any,
        transactions: TransactionProvider,
        collection: str = "mirk-queue",
        now: Callable[[], int] | None = None,
        token: Callable[[], str] | None = None,
        log: Any = None,
        deleteHistoryOnRemove: bool = False,
    ):
        _text(collection)
        if not callable(getattr(store, "mutateAtomically", None)):
            raise QueueError("invalid-input")
        if log is not None and not callable(getattr(log, "append", None)):
            raise QueueError("invalid-input")
        if deleteHistoryOnRemove and not callable(getattr(log, "deleteStream", None)):
            raise QueueError("invalid-input")
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
        return "mirk-queue-generation:" + canonical_json([self.collection, id])

    def _stream(self, id: str) -> str:
        retained = self.store.get(self._generation_key(id))
        incarnation = 0 if retained is None else validate_time(generation(retained) + 1)
        return canonical_json([self.collection, id, incarnation])

    def get(self, id: str) -> Record | None:
        _text(id)
        result: Record | None = self.store.getVersioned(self._target(id))
        if result:
            validate_item(result["value"])
            if result["value"]["id"] != id:
                raise QueueError("invalid-input")
        return {**result, "value": normalize_item(result["value"])} if result else None

    def _command(self, name: str, input: Any, command: Record, work: Callable[[], Any]) -> Any:
        _text(command["key"])
        intent = canonical_json({"name": name, "input": input})
        key = "mirk-queue-command:" + canonical_json([self.collection, command["key"]])
        with self.transactions.transaction():
            receipt = self.store.get(key)
            if receipt is not None:
                validate_receipt(receipt)
                validate_outcome(name, receipt["outcome"])
                if receipt["intent"] != intent:
                    raise QueueError("idempotency-conflict")
                return normalize_outcome(name, copy.deepcopy(receipt["outcome"]))
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
                raise QueueError("conflict")
            return outcome

    def _save(self, item: Record, prior: Record | None, event: str) -> Record:
        validate_item(item)
        slot_conditions, slot_operations = self._slot_mutation(item)
        condition = {"target": self._target(item["id"]), "expected": "missing"}
        if prior:
            condition.update(expected="version", version=prior["version"])
        result = self.store.mutateAtomically(
            {
                "conditions": [condition, *slot_conditions],
                "operations": [
                    {"op": "put", "collection": self.collection, "item": item},
                    *slot_operations,
                ],
            }
        )
        if result["status"] != "applied":
            raise QueueError("conflict")
        if self.log is not None:
            self.log.append(self._stream(item["id"]), {"event": event, "item": item})
        return self._require(item["id"])

    def _require(self, id: str) -> Record:
        result = self.get(id)
        if result is None:
            raise QueueError("not-found")
        return result

    def _owned(self, item: Record, claim: Record, now: int) -> None:
        if (
            item["state"] != "leased"
            or item["ownerToken"] != claim["ownerToken"]
            or item["generation"] != claim["generation"]
            or item["expiresAt"] is None
            or item["expiresAt"] <= now
        ):
            raise QueueError("stale-claim")

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
            raise QueueError("invalid-input")
        for field in ("subject", "kind"):
            if field in input and not isinstance(input[field], str):
                raise QueueError("invalid-input")
        if "availableAt" in input:
            validate_time(input["availableAt"])

        def work() -> Record:
            return self._create(input, None)

        return self._command("enqueue", input, command, work)

    def _create(self, input: Record, active_key: str | None) -> Record:
        retained_generation = self.store.get(self._generation_key(input["id"]))
        initial_generation = (
            0 if retained_generation is None else validate_time(generation(retained_generation) + 1)
        )
        now = validate_time(self.now())
        item = {
            **input,
            "schemaVersion": 2,
            "activeKey": active_key,
            "subject": input.get("subject"),
            "kind": input.get("kind"),
            "state": "queued",
            "priority": input.get("priority", 0),
            "availableAt": input.get("availableAt", now),
            "enqueuedAt": now,
            "updatedAt": now,
            "claimCount": 0,
            "generation": initial_generation,
            "ownerToken": None,
            "expiresAt": None,
            "checkpoint": None,
            "cancellation": None,
            "result": None,
            "error": None,
        }
        return self._save(item, None, "enqueue")

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
        item = {
            **prior["value"],
            "state": "leased",
            "ownerToken": owner,
            "generation": prior["value"]["generation"] + 1,
            "claimCount": prior["value"]["claimCount"] + 1,
            "expiresAt": validate_time(now + lease_ms),
            "updatedAt": now,
        }
        self._save(item, prior, "claim")
        return {"itemId": id, "ownerToken": owner, "generation": item["generation"]}

    def _claim_command(
        self, name: str, input: Record, options: Record, work: Callable[[], Record | None]
    ) -> Record | None:
        validate_positive(options["leaseMs"])
        with self.transactions.transaction():
            claim: Record | None = self._command(name, input, options, work)
            if claim:
                self._owned(
                    self._require(claim["itemId"])["value"], claim, validate_time(self.now())
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
            for item in records:
                validate_item(item)
            items = [
                j
                for j in records
                if j["queue"] == queue
                and j["state"] == "queued"
                and not j["cancellation"]
                and j["availableAt"] <= now
            ]
            items.sort(key=_order)
            return self._claim(items[0]["id"], options["leaseMs"]) if items else None

        return self._claim_command(
            "claimNext", {"queue": queue, "leaseMs": options["leaseMs"]}, options, work
        )
