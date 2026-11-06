"""Wire validation for owned job records and retained command outcomes."""

from __future__ import annotations

from typing import Any, cast

from mirk.store.canonical import canonical_json

from .errors import JobsError

FIELDS = {
    "id",
    "schemaVersion",
    "queue",
    "payload",
    "state",
    "priority",
    "enqueuedAt",
    "availableAt",
    "updatedAt",
    "attempt",
    "generation",
    "ownerToken",
    "expiresAt",
    "checkpoint",
    "cancellation",
    "result",
    "error",
}
STATES = {"queued", "leased", "blocked", "succeeded", "failed", "cancelled"}


def invalid() -> Any:
    raise JobsError("invalid-input", "Malformed jobs data")


def record(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        invalid()
    return cast(dict[str, Any], value)


def exact(value: dict[str, Any], fields: set[str]) -> None:
    if set(value) != fields:
        invalid()


def text(value: Any) -> None:
    if not isinstance(value, str) or not value:
        invalid()


def generation(value: Any) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not 0 <= value <= 9007199254740991
        or value != int(value)
    ):
        invalid()
    return int(value)


def validate_job(value: Any) -> None:
    job = record(value)
    exact(
        job, FIELDS if job.get("schemaVersion") == 1 else FIELDS | {"activeKey", "subject", "kind"}
    )
    if (
        isinstance(job["schemaVersion"], bool)
        or job["schemaVersion"] not in (1, 2)
        or not isinstance(job["state"], str)
        or job["state"] not in STATES
    ):
        invalid()
    if job["schemaVersion"] == 2:
        for field in ("activeKey", "subject", "kind"):
            if job[field] is not None and not isinstance(job[field], str):
                invalid()
    if job["schemaVersion"] == 2 and job["activeKey"] is not None:
        text(job["activeKey"])
    text(job["id"])
    text(job["queue"])
    priority = job["priority"]
    if (
        isinstance(priority, bool)
        or not isinstance(priority, (int, float))
        or not -9007199254740991 <= priority <= 9007199254740991
        or priority != int(priority)
    ):
        invalid()
    for field in ("enqueuedAt", "availableAt", "updatedAt", "attempt", "generation"):
        generation(job[field])
    if job["state"] == "leased":
        text(job["ownerToken"])
        generation(job["expiresAt"])
        if job["attempt"] == 0 or job["generation"] == 0:
            invalid()
    elif job["ownerToken"] is not None or job["expiresAt"] is not None:
        invalid()
    if job["cancellation"] is not None:
        cancellation = record(job["cancellation"])
        exact(cancellation, {"requestedAt", "generation"})
        generation(cancellation["requestedAt"])
        if generation(cancellation["generation"]) > generation(job["generation"]) or job[
            "state"
        ] in {"queued", "succeeded", "failed"}:
            invalid()
    try:
        canonical_json(value)
    except (TypeError, ValueError):
        invalid()


def normalize_job(value: Any) -> dict[str, Any]:
    validate_job(value)
    if value["schemaVersion"] == 2:
        return record(value)
    return {**value, "schemaVersion": 2, "activeKey": None, "subject": None, "kind": None}


def normalize_outcome(name: str, value: Any) -> Any:
    validate_outcome(name, value)
    if name == "start":
        return {**value, "job": {**value["job"], "value": normalize_job(value["job"]["value"])}}
    if name in {"claim", "claimNext", "removeTerminal"}:
        return value
    return {**value, "value": normalize_job(value["value"])}


def validate_claim(value: Any) -> None:
    claim = record(value)
    exact(claim, {"jobId", "ownerToken", "generation"})
    text(claim["jobId"])
    text(claim["ownerToken"])
    if generation(claim["generation"]) == 0:
        invalid()


def validate_outcome(name: str, value: Any) -> None:
    if name == "start":
        result = record(value)
        exact(result, {"started", "job"})
        if not isinstance(result["started"], bool):
            invalid()
        validate_outcome("enqueue", result["job"])
        return
    if name in {"claim", "claimNext"}:
        if value is not None:
            validate_claim(value)
        return
    if name == "removeTerminal":
        if value is not True:
            invalid()
        return
    result = record(value)
    exact(result, {"value", "version"})
    text(result["version"])
    validate_job(result["value"])


def validate_receipt(value: Any) -> None:
    receipt = record(value)
    exact(receipt, {"intent", "outcome"})
    text(receipt["intent"])


def validate_enqueue(value: Any) -> None:
    input = record(value)
    if (
        set(input) - {"id", "queue", "payload", "priority", "availableAt", "subject", "kind"}
        or "payload" not in input
    ):
        invalid()
