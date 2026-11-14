"""Wire validation for owned item records and retained command outcomes."""

from __future__ import annotations

from typing import Any, cast

from mirk.store.canonical import canonical_json

from .errors import QueueError

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
    "claimCount",
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
    raise QueueError("invalid-input", "Malformed queue data")


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


def validate_item(value: Any) -> None:
    item = record(value)
    exact(
        item,
        FIELDS if item.get("schemaVersion") == 1 else FIELDS | {"activeKey", "subject", "kind"},
    )
    if (
        isinstance(item["schemaVersion"], bool)
        or item["schemaVersion"] not in (1, 2)
        or not isinstance(item["state"], str)
        or item["state"] not in STATES
    ):
        invalid()
    if item["schemaVersion"] == 2:
        for field in ("activeKey", "subject", "kind"):
            if item[field] is not None and not isinstance(item[field], str):
                invalid()
    if item["schemaVersion"] == 2 and item["activeKey"] is not None:
        text(item["activeKey"])
    text(item["id"])
    text(item["queue"])
    priority = item["priority"]
    if (
        isinstance(priority, bool)
        or not isinstance(priority, (int, float))
        or not -9007199254740991 <= priority <= 9007199254740991
        or priority != int(priority)
    ):
        invalid()
    for field in ("enqueuedAt", "availableAt", "updatedAt", "claimCount", "generation"):
        generation(item[field])
    if item["state"] == "leased":
        text(item["ownerToken"])
        generation(item["expiresAt"])
        if item["claimCount"] == 0 or item["generation"] == 0:
            invalid()
    elif item["ownerToken"] is not None or item["expiresAt"] is not None:
        invalid()
    if item["cancellation"] is not None:
        cancellation = record(item["cancellation"])
        exact(cancellation, {"requestedAt", "generation"})
        generation(cancellation["requestedAt"])
        if generation(cancellation["generation"]) > generation(item["generation"]) or item[
            "state"
        ] in {"queued", "succeeded", "failed"}:
            invalid()
    try:
        canonical_json(value)
    except (TypeError, ValueError):
        invalid()


def normalize_item(value: Any) -> dict[str, Any]:
    validate_item(value)
    if value["schemaVersion"] == 2:
        return record(value)
    return {**value, "schemaVersion": 2, "activeKey": None, "subject": None, "kind": None}


def normalize_outcome(name: str, value: Any) -> Any:
    validate_outcome(name, value)
    if name == "start":
        return {**value, "item": {**value["item"], "value": normalize_item(value["item"]["value"])}}
    if name in {"claim", "claimNext", "removeTerminal"}:
        return value
    return {**value, "value": normalize_item(value["value"])}


def validate_claim(value: Any) -> None:
    claim = record(value)
    exact(claim, {"itemId", "ownerToken", "generation"})
    text(claim["itemId"])
    text(claim["ownerToken"])
    if generation(claim["generation"]) == 0:
        invalid()


def validate_outcome(name: str, value: Any) -> None:
    if name == "start":
        result = record(value)
        exact(result, {"started", "item"})
        if not isinstance(result["started"], bool):
            invalid()
        validate_outcome("enqueue", result["item"])
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
    validate_item(result["value"])


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
