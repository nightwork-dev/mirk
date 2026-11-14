"""Item worker and administrative lifecycle transitions."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any

from .core import QueueCore, Record, validate_positive, validate_time
from .errors import QueueError as QueueError
from .validation import validate_claim


class QueueStore(QueueCore):
    def _worker(
        self,
        name: str,
        claim: Record,
        data: Any,
        command: Record,
        change: Callable[[Record, int], None],
        allow_cancel: bool = False,
    ) -> Record:
        validate_claim(claim)

        def work() -> Record:
            prior = self._require(claim["itemId"])
            now = validate_time(self.now())
            self._owned(prior["value"], claim, now)
            if prior["value"]["cancellation"] and not allow_cancel:
                raise QueueError("cancel-requested")
            item = copy.deepcopy(prior["value"])
            item["updatedAt"] = now
            change(item, now)
            if item["state"] != "leased":
                item.update(ownerToken=None, expiresAt=None)
            return self._save(item, prior, name)

        return self._command(name, {"claim": claim, "data": data}, command, work)

    def renew(self, claim: Record, leaseMs: int, command: Record) -> Record:
        validate_positive(leaseMs)
        return self._worker(
            "renew",
            claim,
            leaseMs,
            command,
            lambda j, n: j.update(expiresAt=validate_time(n + leaseMs)),
            True,
        )

    def checkpoint(self, claim: Record, value: Any, command: Record) -> Record:
        return self._worker(
            "checkpoint", claim, value, command, lambda j, _: j.update(checkpoint=value), True
        )

    def complete(self, claim: Record, result: Any, command: Record) -> Record:
        return self._worker(
            "complete",
            claim,
            result,
            command,
            lambda j, _: j.update(state="succeeded", result=result),
        )

    def fail(self, claim: Record, error: Any, command: Record) -> Record:
        return self._worker(
            "fail", claim, error, command, lambda j, _: j.update(state="failed", error=error)
        )

    def retry(self, claim: Record, availableAt: int, command: Record) -> Record:
        validate_time(availableAt)
        return self._worker(
            "retry",
            claim,
            availableAt,
            command,
            lambda j, _: j.update(state="queued", availableAt=availableAt),
        )

    def block(self, claim: Record, checkpoint: Any, command: Record) -> Record:
        return self._worker(
            "block",
            claim,
            checkpoint,
            command,
            lambda j, _: j.update(state="blocked", checkpoint=checkpoint),
            True,
        )

    def acknowledgeCancel(self, claim: Record, command: Record) -> Record:
        def change(item: Record, _: int) -> None:
            if not item["cancellation"]:
                raise QueueError("conflict")
            item["state"] = "cancelled"

        return self._worker("acknowledgeCancel", claim, None, command, change, True)

    def requestCancel(self, id: str, command: Record) -> Record:
        def work() -> Record:
            prior = self._require(id)
            if (
                prior["value"]["state"] in ("succeeded", "failed", "cancelled")
                or prior["value"]["cancellation"]
            ):
                return prior
            now = validate_time(self.now())
            item = {
                **prior["value"],
                "updatedAt": now,
                "cancellation": {"requestedAt": now, "generation": prior["value"]["generation"]},
            }
            if item["state"] != "leased":
                item["state"] = "cancelled"
            return self._save(item, prior, "requestCancel")

        return self._command("requestCancel", {"id": id}, command, work)

    def recoverExpired(self, id: str, expectedGeneration: int, command: Record) -> Record:
        def work() -> Record:
            prior = self._require(id)
            now = validate_time(self.now())
            item = prior["value"]
            if (
                item["state"] != "leased"
                or item["generation"] != expectedGeneration
                or item["expiresAt"] is None
                or item["expiresAt"] > now
            ):
                raise QueueError("conflict")
            return self._save(
                {
                    **item,
                    "state": "blocked",
                    "generation": item["generation"] + 1,
                    "ownerToken": None,
                    "expiresAt": None,
                    "updatedAt": now,
                },
                prior,
                "recoverExpired",
            )

        return self._command(
            "recoverExpired", {"id": id, "expectedGeneration": expectedGeneration}, command, work
        )

    def resolveBlocked(
        self, id: str, expectedVersion: str, decision: Record, command: Record
    ) -> Record:
        fields = {
            "queued": {"state", "availableAt"},
            "succeeded": {"state", "result"},
            "failed": {"state", "error"},
            "cancelled": {"state"},
        }
        state = decision.get("state")
        expected_fields = fields.get(state) if isinstance(state, str) else None
        if expected_fields is None or set(decision) != expected_fields:
            raise QueueError("invalid-input")

        def work() -> Record:
            prior = self._require(id)
            if prior["version"] != expectedVersion:
                raise QueueError("conflict")
            if prior["value"]["state"] != "blocked":
                raise QueueError("not-blocked")
            if prior["value"]["cancellation"] and decision["state"] != "cancelled":
                raise QueueError("cancel-requested")
            if decision["state"] == "queued":
                validate_time(decision["availableAt"])
            return self._save(
                {**prior["value"], **decision, "updatedAt": validate_time(self.now())},
                prior,
                "resolveBlocked",
            )

        return self._command(
            "resolveBlocked",
            {"id": id, "expectedVersion": expectedVersion, "decision": decision},
            command,
            work,
        )

    def updateQueued(self, id: str, expectedVersion: str, patch: Record, command: Record) -> Record:
        if set(patch) - {"priority", "availableAt"}:
            raise QueueError("invalid-input")
        if "priority" in patch:
            priority = patch["priority"]
            if (
                isinstance(priority, bool)
                or not isinstance(priority, int)
                or abs(priority) > 9007199254740991
            ):
                raise QueueError("invalid-input")
        if "availableAt" in patch:
            validate_time(patch["availableAt"])

        def work() -> Record:
            prior = self._require(id)
            if prior["version"] != expectedVersion or prior["value"]["state"] != "queued":
                raise QueueError("conflict")
            return self._save(
                {**prior["value"], **patch, "updatedAt": validate_time(self.now())},
                prior,
                "updateQueued",
            )

        return self._command(
            "updateQueued",
            {"id": id, "expectedVersion": expectedVersion, "patch": patch},
            command,
            work,
        )

    def requeueTerminal(
        self, id: str, expectedVersion: str, patch: Record, command: Record
    ) -> Record:
        if set(patch) - {"availableAt"}:
            raise QueueError("invalid-input")
        if "availableAt" in patch:
            validate_time(patch["availableAt"])

        def work() -> Record:
            prior = self._require(id)
            if prior["version"] != expectedVersion:
                raise QueueError("conflict")
            if prior["value"]["state"] not in ("succeeded", "failed", "cancelled"):
                raise QueueError("not-terminal")
            now = validate_time(self.now())
            return self._save(
                {
                    **prior["value"],
                    "state": "queued",
                    "availableAt": patch.get("availableAt", now),
                    "generation": prior["value"]["generation"] + 1,
                    "cancellation": None,
                    "checkpoint": None,
                    "result": None,
                    "error": None,
                    "ownerToken": None,
                    "expiresAt": None,
                    "updatedAt": now,
                },
                prior,
                "requeueTerminal",
            )

        return self._command(
            "requeueTerminal",
            {"id": id, "expectedVersion": expectedVersion, "patch": patch},
            command,
            work,
        )

    def removeTerminal(self, id: str, expectedVersion: str, command: Record) -> bool:
        def work() -> bool:
            prior = self._require(id)
            if prior["version"] != expectedVersion:
                raise QueueError("conflict")
            if prior["value"]["state"] not in ("succeeded", "failed", "cancelled"):
                raise QueueError("not-terminal")
            stream = self._stream(id) if self.delete_history else None
            result = self.store.mutateAtomically(
                {
                    "conditions": [
                        {
                            "target": self._target(id),
                            "expected": "version",
                            "version": expectedVersion,
                        }
                    ],
                    "operations": [
                        {"op": "remove", "collection": self.collection, "id": id},
                        {
                            "op": "set",
                            "key": self._generation_key(id),
                            "value": prior["value"]["generation"],
                        },
                    ],
                }
            )
            if result["status"] != "applied":
                raise QueueError("conflict")
            if self.delete_history:
                assert self.log is not None
                assert stream is not None
                self.log.deleteStream(stream)
            return True

        return self._command(
            "removeTerminal", {"id": id, "expectedVersion": expectedVersion}, command, work
        )
