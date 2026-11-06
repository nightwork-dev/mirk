"""Job worker and administrative lifecycle transitions."""

from __future__ import annotations

import copy
from collections.abc import Callable
from typing import Any

from .core import JobsCore, Record, validate_positive, validate_time
from .core import JobsError as JobsError


class JobsStore(JobsCore):
    def _worker(
        self,
        name: str,
        claim: Record,
        data: Any,
        command: Record,
        change: Callable[[Record, int], None],
        allow_cancel: bool = False,
    ) -> Record:
        def work() -> Record:
            prior = self._require(claim["jobId"])
            now = validate_time(self.now())
            self._owned(prior["value"], claim, now)
            if prior["value"]["cancellation"] and not allow_cancel:
                raise JobsError("cancel-requested")
            job = copy.deepcopy(prior["value"])
            job["updatedAt"] = now
            change(job, now)
            if job["state"] != "leased":
                job.update(ownerToken=None, expiresAt=None)
            return self._save(job, prior, name)

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
        def change(job: Record, _: int) -> None:
            if not job["cancellation"]:
                raise JobsError("conflict")
            job["state"] = "cancelled"

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
            job = {
                **prior["value"],
                "updatedAt": now,
                "cancellation": {"requestedAt": now, "generation": prior["value"]["generation"]},
            }
            if job["state"] != "leased":
                job["state"] = "cancelled"
            return self._save(job, prior, "requestCancel")

        return self._command("requestCancel", {"id": id}, command, work)

    def recoverExpired(self, id: str, expectedGeneration: int, command: Record) -> Record:
        def work() -> Record:
            prior = self._require(id)
            now = validate_time(self.now())
            job = prior["value"]
            if (
                job["state"] != "leased"
                or job["generation"] != expectedGeneration
                or job["expiresAt"] is None
                or job["expiresAt"] > now
            ):
                raise JobsError("conflict")
            return self._save(
                {
                    **job,
                    "state": "blocked",
                    "generation": job["generation"] + 1,
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
        def work() -> Record:
            fields = {
                "queued": {"state", "availableAt"},
                "succeeded": {"state", "result"},
                "failed": {"state", "error"},
                "cancelled": {"state"},
            }
            if set(decision) != fields.get(decision.get("state", ""), set()):
                raise JobsError("invalid-input")
            prior = self._require(id)
            if prior["version"] != expectedVersion:
                raise JobsError("conflict")
            if prior["value"]["state"] != "blocked":
                raise JobsError("not-blocked")
            if prior["value"]["cancellation"] and decision["state"] != "cancelled":
                raise JobsError("cancel-requested")
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
            raise JobsError("invalid-input")
        if "priority" in patch:
            priority = patch["priority"]
            if (
                isinstance(priority, bool)
                or not isinstance(priority, int)
                or abs(priority) > 9007199254740991
            ):
                raise JobsError("invalid-input")
        if "availableAt" in patch:
            validate_time(patch["availableAt"])

        def work() -> Record:
            prior = self._require(id)
            if prior["version"] != expectedVersion or prior["value"]["state"] != "queued":
                raise JobsError("conflict")
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
            raise JobsError("invalid-input")
        if "availableAt" in patch:
            validate_time(patch["availableAt"])

        def work() -> Record:
            prior = self._require(id)
            if prior["version"] != expectedVersion:
                raise JobsError("conflict")
            if prior["value"]["state"] not in ("succeeded", "failed", "cancelled"):
                raise JobsError("not-terminal")
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
                raise JobsError("conflict")
            if prior["value"]["state"] not in ("succeeded", "failed", "cancelled"):
                raise JobsError("not-terminal")
            result = self.store.mutateAtomically(
                {
                    "conditions": [
                        {
                            "target": self._target(id),
                            "expected": "version",
                            "version": expectedVersion,
                        }
                    ],
                    "operations": [{"op": "remove", "collection": self.collection, "id": id}],
                }
            )
            if result["status"] != "applied":
                raise JobsError("conflict")
            if self.delete_history:
                self.log.deleteStream(self._stream(id))
            return True

        return self._command(
            "removeTerminal", {"id": id, "expectedVersion": expectedVersion}, command, work
        )
