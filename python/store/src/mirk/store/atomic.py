"""Declarative atomic mutation: request validation, digests, and result shapes.

Port of ``packages/store/src/atomic.ts``. Validation order and every rejection
message are copied from that file, because the request digest and the errors are
part of the cross-language contract: the same request must produce the same
``requestDigest`` under Node and under Python, and a caller that switches
languages must read the same message.

Results are plain dicts with the TypeScript key spelling (``status``,
``requestDigest``, ``versions``, ``outcome``), so a result serialized by one
language deserializes into the other unchanged.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from functools import cmp_to_key
from typing import Any, Literal, cast

from .canonical import canonical_json, sha256_hex

__all__ = [
    "DEFAULT_ATOMIC_LIMITS",
    "IN_PROCESS_ATOMIC_LIMITS",
    "MAX_ATOMIC_OUTCOME_BYTES",
    "REQUEST_SCHEMA",
    "UNDEFINED",
    "AtomicMutationBackendError",
    "AtomicMutationIndeterminateError",
    "AtomicMutationLimits",
    "AtomicMutationRejectedError",
    "StoreTarget",
    "ValidatedRequest",
    "clone_condition",
    "clone_json",
    "clone_target",
    "compare_targets",
    "condition_matches",
    "operation_target",
    "resolve_atomic_limits",
    "target_key",
    "validate_atomic_request",
]

REQUEST_SCHEMA = "mirk-atomic-request/v1"

#: A fixed cap, not configurable: an idempotency outcome is persisted under its
#: key forever, so no backend may accept a larger one.
MAX_ATOMIC_OUTCOME_BYTES = 64 * 1024

StoreTarget = dict[str, Any]
"""``{"kind": "key", "key": str}`` or ``{"kind": "record", "collection", "id"}``."""

AtomicMutationRejectionCode = Literal[
    "invalid-request",
    "unsupported-operation",
    "condition-limit-exceeded",
    "operation-limit-exceeded",
    "request-size-exceeded",
    "outcome-size-exceeded",
]


class _Undefined:
    """Stands in for JavaScript ``undefined``, which Python's ``None`` is not.

    ``{"outcome": None}`` is a request carrying a JSON null outcome; a request
    with no ``outcome`` key carries none at all. The two produce different
    digests, so the absent case needs its own value.
    """

    __slots__ = ()

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<undefined>"


UNDEFINED = _Undefined()


class AtomicMutationRejectedError(Exception):
    """The request never reached a backend decision point."""

    def __init__(self, code: AtomicMutationRejectionCode, message: str) -> None:
        super().__init__(message)
        self.code: AtomicMutationRejectionCode = code
        self.message = message


class AtomicMutationBackendError(Exception):
    """The backend could not decide the request; ``retryable`` says whether to retry."""

    def __init__(
        self,
        code: Literal["unavailable", "serialization-failure"],
        retryable: bool,
        message: str,
    ) -> None:
        super().__init__(message)
        self.code: Literal["unavailable", "serialization-failure"] = code
        self.retryable = retryable
        self.message = message


class AtomicMutationIndeterminateError(Exception):
    """The request may or may not have applied."""

    def __init__(
        self,
        request_digest: str,
        idempotency_key: str | None,
        recovery: Literal["retry-with-same-key", "manual-reconciliation"],
        message: str = "Atomic mutation outcome is indeterminate.",
    ) -> None:
        super().__init__(message)
        self.request_digest = request_digest
        self.idempotency_key = idempotency_key
        self.recovery: Literal["retry-with-same-key", "manual-reconciliation"] = recovery
        self.message = message


@dataclass(frozen=True, slots=True)
class AtomicMutationLimits:
    """The request bounds one store applies before its atomic decision point.

    Field names keep the TypeScript spelling so a corpus or wire ``atomicLimits``
    object maps straight in.
    """

    maxOperations: int
    maxConditions: int
    maxRequestBytes: int


#: What every store enforced before limits were configurable, and what a remote
#: or unknown transport should keep.
DEFAULT_ATOMIC_LIMITS = AtomicMutationLimits(
    maxOperations=128,
    maxConditions=128,
    maxRequestBytes=1024 * 1024,
)

#: In-process backends: the request is never serialized onto a wire and the
#: batch is one local transaction.
IN_PROCESS_ATOMIC_LIMITS = AtomicMutationLimits(
    maxOperations=4096,
    maxConditions=1024,
    maxRequestBytes=16 * 1024 * 1024,
)

_LIMIT_FIELDS = ("maxOperations", "maxConditions", "maxRequestBytes")


def _js_string(value: Any) -> str:
    """``String(value)`` for the values that reach a limit-rejection message."""
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return value
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "Infinity" if value > 0 else "-Infinity"
    if isinstance(value, int | float):
        return canonical_json(value)
    return str(value)


def _is_safe_integer(value: Any) -> bool:
    """``Number.isSafeInteger``: a number, integral, within 2^53 - 1."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return False
    if isinstance(value, float) and (
        math.isnan(value) or math.isinf(value) or not value.is_integer()
    ):
        return False
    return abs(int(value)) <= 9007199254740991


def _limit_field(source: dict[str, Any], base: AtomicMutationLimits, name: str) -> int:
    if name not in source:
        return int(getattr(base, name))
    value = source[name]
    if not _is_safe_integer(value) or value < 1:
        raise ValueError(f"{name} must be a positive safe integer; got {_js_string(value)}.")
    return int(value)


def resolve_atomic_limits(
    overrides: AtomicMutationLimits | dict[str, Any] | None = None,
    base: AtomicMutationLimits = DEFAULT_ATOMIC_LIMITS,
) -> AtomicMutationLimits:
    """Merge caller overrides onto a backend's own defaults."""
    if isinstance(overrides, AtomicMutationLimits):
        source: dict[str, Any] = {name: getattr(overrides, name) for name in _LIMIT_FIELDS}
    else:
        source = dict(overrides) if overrides else {}
    return AtomicMutationLimits(
        maxOperations=_limit_field(source, base, "maxOperations"),
        maxConditions=_limit_field(source, base, "maxConditions"),
        maxRequestBytes=_limit_field(source, base, "maxRequestBytes"),
    )


# ── Targets ─────────────────────────────────────────────────────────────────


def _utf16_length(value: str) -> int:
    """``String.prototype.length``: UTF-16 code units, not code points.

    The prefix has to count what TypeScript counts, or an astral-plane key would
    be length-prefixed differently in the two languages and the duplicate-target
    check could disagree.
    """
    return len(value.encode("utf-16-le")) // 2


def target_key(target: StoreTarget) -> str:
    """A collision-free string identity for a target.

    Each component is length-prefixed. Raw separators are not sufficient because
    callers may legitimately use those code points in keys, collection names, or
    ids (``collection: "a\\0b", id: "c"`` versus ``"a", "b\\0c"``).
    """

    def part(value: str) -> str:
        return f"{_utf16_length(value)}:{value}"

    if target["kind"] == "key":
        return f"k:{part(target['key'])}"
    return f"r:{part(target['collection'])}:{part(target['id'])}"


def _compare_code_points(a: str, b: str) -> int:
    if a == b:
        return 0
    return -1 if a < b else 1


def compare_targets(a: StoreTarget, b: StoreTarget) -> int:
    """Key targets before record targets, then code point order within a kind."""
    if a["kind"] != b["kind"]:
        return -1 if a["kind"] == "key" else 1
    if a["kind"] == "key":
        return _compare_code_points(a["key"], b["key"])
    return _compare_code_points(a["collection"], b["collection"]) or _compare_code_points(
        a["id"], b["id"]
    )


def operation_target(operation: dict[str, Any]) -> StoreTarget:
    """The single target one operation writes."""
    op = operation.get("op")
    if op in ("set", "delete"):
        return {"kind": "key", "key": operation["key"]}
    if op == "put":
        return {
            "kind": "record",
            "collection": operation["collection"],
            "id": operation["item"]["id"],
        }
    if op == "remove":
        return {"kind": "record", "collection": operation["collection"], "id": operation["id"]}
    raise AtomicMutationRejectedError("unsupported-operation", "unsupported atomic operation")


def clone_target(target: StoreTarget) -> StoreTarget:
    if target["kind"] == "key":
        return {"kind": "key", "key": target["key"]}
    return {"kind": "record", "collection": target["collection"], "id": target["id"]}


def clone_condition(condition: dict[str, Any]) -> dict[str, Any]:
    if condition["expected"] == "version":
        return {
            "target": clone_target(condition["target"]),
            "expected": "version",
            "version": condition["version"],
        }
    return {"target": clone_target(condition["target"]), "expected": condition["expected"]}


def clone_json(value: Any) -> Any:
    """Deep copy through the canonical encoding, exactly as TypeScript does.

    Parsing the canonical encoding also gives in-memory receipts the same
    value-copy behavior as SQLite: an integral float comes back as an int.
    """
    return json.loads(canonical_json(value))


def condition_matches(condition: dict[str, Any], observed: dict[str, Any] | None) -> bool:
    expected = condition["expected"]
    if expected == "missing":
        return observed is None
    if expected == "present":
        return observed is not None
    return observed is not None and observed["version"] == condition["version"]


# ── Validation ──────────────────────────────────────────────────────────────


def _invalid(message: str) -> Any:
    raise AtomicMutationRejectedError("invalid-request", message)


def _is_plain_object(value: Any) -> bool:
    return isinstance(value, dict)


def _target_from_unknown(value: Any) -> StoreTarget:
    if not _is_plain_object(value) or value.get("kind") not in ("key", "record"):
        _invalid("invalid store target")
    if value["kind"] == "key":
        if not isinstance(value.get("key"), str):
            _invalid("key target requires a string key")
        return {"kind": "key", "key": value["key"]}
    collection = value.get("collection")
    if (
        not isinstance(collection, str)
        or len(collection) == 0
        or not isinstance(value.get("id"), str)
    ):
        _invalid("record target requires string collection and id")
    return {"kind": "record", "collection": value["collection"], "id": value["id"]}


def _json_safe(value: Any, label: str) -> None:
    if isinstance(value, _Undefined):
        _invalid(f"{label} is not JSON-safe: value is not JSON-safe")
    try:
        canonical_json(value)
    except Exception as error:
        _invalid(f"{label} is not JSON-safe: {error}")


def _normalize_operation(value: Any) -> dict[str, Any]:
    if not _is_plain_object(value) or not isinstance(value.get("op"), str):
        _invalid("invalid atomic operation")
    op = value["op"]
    if op == "set":
        if not isinstance(value.get("key"), str):
            _invalid("set requires a string key")
        payload = value.get("value", UNDEFINED)
        _json_safe(payload, "set value")
        return {"op": "set", "key": value["key"], "value": clone_json(payload)}
    if op == "delete":
        if not isinstance(value.get("key"), str):
            _invalid("delete requires a string key")
        return {"op": "delete", "key": value["key"]}
    if op == "put":
        item = value.get("item")
        collection = value.get("collection")
        if (
            not isinstance(collection, str)
            or len(collection) == 0
            or not _is_plain_object(item)
            or not isinstance(item.get("id"), str)
        ):
            _invalid("put requires a collection and an item with a string id")
        _json_safe(value["item"], "put item")
        return {"op": "put", "collection": value["collection"], "item": clone_json(value["item"])}
    if op == "remove":
        collection = value.get("collection")
        if (
            not isinstance(collection, str)
            or len(collection) == 0
            or not isinstance(value.get("id"), str)
        ):
            _invalid("remove requires string collection and id")
        return {"op": "remove", "collection": value["collection"], "id": value["id"]}
    raise AtomicMutationRejectedError(
        "unsupported-operation", f"unsupported atomic operation: {op}"
    )


def _normalize_condition(value: Any) -> dict[str, Any]:
    if not _is_plain_object(value):
        _invalid("invalid atomic condition")
    target = _target_from_unknown(value.get("target"))
    expected = value.get("expected")
    if expected in ("missing", "present"):
        return {"target": target, "expected": expected}
    if expected == "version" and isinstance(value.get("version"), str):
        return {"target": target, "expected": "version", "version": value["version"]}
    return _invalid("invalid atomic condition expectation")


@dataclass(frozen=True, slots=True)
class ValidatedRequest:
    """A canonicalized request plus its digest. Nothing has been written yet."""

    conditions: list[dict[str, Any]]
    operations: list[dict[str, Any]]
    idempotency: dict[str, Any] | None
    outcome: Any
    request_digest: str

    @property
    def has_outcome(self) -> bool:
        return not isinstance(self.outcome, _Undefined)

    @property
    def idempotency_key(self) -> str | None:
        return None if self.idempotency is None else str(self.idempotency["key"])


def _byte_length(text: str) -> int:
    return len(text.encode("utf-8"))


def validate_atomic_request(
    request: Any,
    limits: AtomicMutationLimits = DEFAULT_ATOMIC_LIMITS,
) -> ValidatedRequest:
    """Validate and canonicalize a request before any backend decision point."""
    if not _is_plain_object(request):
        _invalid("request must be a plain object")
    raw_operations: list[Any] = cast("list[Any]", request.get("operations"))
    if not isinstance(request.get("operations"), list) or len(raw_operations) == 0:
        _invalid("operations must be a non-empty array")
    if len(raw_operations) > limits.maxOperations:
        raise AtomicMutationRejectedError(
            "operation-limit-exceeded",
            f"request has {len(raw_operations)} operations;"
            f" this store's maxOperations is {limits.maxOperations}",
        )
    raw_conditions = request.get("conditions")
    if "conditions" in request and not isinstance(raw_conditions, list):
        _invalid("conditions must be an array")
    condition_source: list[Any] = (
        cast("list[Any]", raw_conditions) if isinstance(raw_conditions, list) else []
    )
    if len(condition_source) > limits.maxConditions:
        raise AtomicMutationRejectedError(
            "condition-limit-exceeded",
            f"request has {len(condition_source)} conditions;"
            f" this store's maxConditions is {limits.maxConditions}",
        )

    conditions = [_normalize_condition(entry) for entry in condition_source]
    condition_keys: set[str] = set()
    for condition in conditions:
        key = target_key(condition["target"])
        if key in condition_keys:
            _invalid("repeated conditions for one target are not supported")
        condition_keys.add(key)
    conditions.sort(key=cmp_to_key(lambda a, b: compare_targets(a["target"], b["target"])))

    operations = [_normalize_operation(entry) for entry in raw_operations]
    operation_keys: set[str] = set()
    for operation in operations:
        key = target_key(operation_target(operation))
        if key in operation_keys:
            _invalid("repeated operation targets are not supported")
        operation_keys.add(key)

    idempotency: dict[str, Any] | None = None
    outcome: Any = UNDEFINED
    if "idempotency" in request and request["idempotency"] is not None:
        raw = request["idempotency"]
        if not _is_plain_object(raw) or not isinstance(raw.get("key"), str):
            _invalid("idempotency requires a string key")
        idempotency = {"key": raw["key"]}
        if "outcome" in raw:
            _json_safe(raw["outcome"], "idempotency outcome")
            outcome = clone_json(raw["outcome"])
            outcome_bytes = _byte_length(canonical_json(outcome))
            if outcome_bytes > MAX_ATOMIC_OUTCOME_BYTES:
                raise AtomicMutationRejectedError(
                    "outcome-size-exceeded",
                    f"outcome is {outcome_bytes} bytes;"
                    f" the fixed outcome cap is {MAX_ATOMIC_OUTCOME_BYTES} bytes",
                )
            idempotency["outcome"] = outcome
    elif "idempotency" in request:
        _invalid("idempotency requires a string key")

    digest_input: dict[str, Any] = {
        "schema": REQUEST_SCHEMA,
        "conditions": conditions,
        "operations": operations,
    }
    if not isinstance(outcome, _Undefined):
        digest_input["outcome"] = outcome
    encoded = canonical_json(digest_input)
    # The idempotency key is deliberately excluded from the digest (the same
    # mutation has the same request identity under any key), but it is still
    # part of the bounded wire request and must not provide an unbounded escape
    # from maxRequestBytes.
    request_encoding = (
        encoded
        if idempotency is None
        else canonical_json({**digest_input, "idempotency": {"key": idempotency["key"]}})
    )
    request_bytes = _byte_length(request_encoding)
    if request_bytes > limits.maxRequestBytes:
        raise AtomicMutationRejectedError(
            "request-size-exceeded",
            f"request is {request_bytes} bytes;"
            f" this store's maxRequestBytes is {limits.maxRequestBytes}",
        )
    return ValidatedRequest(
        conditions=conditions,
        operations=operations,
        idempotency=idempotency,
        outcome=outcome,
        request_digest=sha256_hex(encoded),
    )
