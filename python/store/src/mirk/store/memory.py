"""In-memory reference implementation of the Mirk store port."""

from __future__ import annotations

import json
from typing import Any, cast

from .atomic import (
    IN_PROCESS_ATOMIC_LIMITS,
    AtomicMutationLimits,
    clone_condition,
    clone_json,
    clone_target,
    condition_matches,
    operation_target,
    resolve_atomic_limits,
    target_key,
    validate_atomic_request,
)
from .filter import IN_SCALAR_MESSAGE, apply_filter, dumps_json, is_scalar, json_equal
from .types import JsonObject, StoreFilter, StoreMeta

__all__ = ["InMemoryStore", "copy_json"]

_MISSING = object()

_next_memory_store_id = 1


def copy_json(value: Any) -> Any:
    """Deep copy through a JSON round trip. Rejects NaN and infinities.

    Encoding through `dumps_json` keeps both backends returning the same
    number type: an integral float comes back as an int here exactly as it
    does from a SQLite row a TypeScript writer produced.
    """
    return json.loads(dumps_json(value))


def _assert_collection(collection: str) -> None:
    if len(collection) == 0:
        raise ValueError("Invalid collection name")


class InMemoryStore:
    """Reference store. Insertion-ordered, copy on write and on read."""

    def __init__(
        self,
        *,
        version_identity: str | None = None,
        atomic_limits: AtomicMutationLimits | dict[str, Any] | None = None,
    ) -> None:
        global _next_memory_store_id
        self._meta = StoreMeta(backend="memory")
        self._kv: dict[str, Any] = {}
        self._collections: dict[str, dict[str, Any]] = {}
        # Version metadata is separate from values so deletes never revive tokens.
        self._versions: dict[str, str] = {}
        self._next_version_number = 1
        if version_identity is None:
            version_identity = f"m{_next_memory_store_id}"
            _next_memory_store_id += 1
        self._version_prefix = version_identity
        self._receipts: dict[str, dict[str, Any]] = {}
        self._atomic_limits = resolve_atomic_limits(atomic_limits, IN_PROCESS_ATOMIC_LIMITS)

    @property
    def meta(self) -> StoreMeta:
        return self._meta

    @property
    def atomic_limits(self) -> AtomicMutationLimits:
        """The request bounds this store enforces."""
        return self._atomic_limits

    # ── Key-value ────────────────────────────────────────────────────────
    def get(self, key: str) -> Any:
        if key not in self._kv:
            return None
        return copy_json(self._kv[key])

    def set(self, key: str, value: Any) -> None:
        self._kv[key] = copy_json(value)
        self._versions[target_key({"kind": "key", "key": key})] = self._new_version()

    def has(self, key: str) -> bool:
        return key in self._kv

    def delete(self, key: str) -> bool:
        if key in self._kv:
            del self._kv[key]
            self._versions.pop(target_key({"kind": "key", "key": key}), None)
            return True
        return False

    def keys(self, prefix: str | None = None) -> list[str]:
        ordered = sorted(self._kv.keys())
        if not prefix:
            return ordered
        return [key for key in ordered if key.startswith(prefix)]

    # ── Collections ──────────────────────────────────────────────────────
    def _collection(self, collection: str) -> dict[str, Any]:
        _assert_collection(collection)
        existing = self._collections.get(collection)
        if existing is None:
            existing = {}
            self._collections[collection] = existing
        return existing

    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]:
        items = list(self._collection(collection).values())
        return [copy_json(item) for item in apply_filter(items, filter)]

    def getById(self, collection: str, id: str) -> Any:
        item = self._collection(collection).get(id, _MISSING)
        if item is _MISSING:
            return None
        return copy_json(item)

    def put(self, collection: str, item: JsonObject) -> JsonObject:
        col = self._collection(collection)
        item_id = item.get("id")
        if not isinstance(item_id, str):
            raise ValueError("Collection items must have a string id")
        col[item_id] = copy_json(item)
        self._versions[target_key({"kind": "record", "collection": collection, "id": item_id})] = (
            self._new_version()
        )
        return item

    def remove(self, collection: str, id: str) -> bool:
        col = self._collection(collection)
        if id in col:
            del col[id]
            self._versions.pop(
                target_key({"kind": "record", "collection": collection, "id": id}), None
            )
            return True
        return False

    def count(self, collection: str, filter: StoreFilter | None = None) -> int:
        items = list(self._collection(collection).values())
        where = filter.get("where") if filter else None
        narrowed: StoreFilter = {"where": where} if where else {}
        return len(apply_filter(items, narrowed))

    # ── Atomic mutation ──────────────────────────────────────────────────
    def _new_version(self) -> str:
        version = f"{self._version_prefix}-v{self._next_version_number}"
        self._next_version_number += 1
        return version

    def _has_target(self, target: dict[str, Any]) -> bool:
        if target["kind"] == "key":
            return target["key"] in self._kv
        return target["id"] in self._collection(target["collection"])

    def _observe(self, target: dict[str, Any]) -> dict[str, Any] | None:
        """The stored value and its token, minting one for a value that has none."""
        if target["kind"] == "key":
            value = self._kv.get(target["key"], _MISSING)
        else:
            value = self._collection(target["collection"]).get(target["id"], _MISSING)
        if value is _MISSING and not self._has_target(target):
            return None
        key = target_key(target)
        version = self._versions.get(key)
        # Values written before version metadata existed are assigned a token
        # lazily, which keeps the capability useful for an already-populated
        # instance while preserving write-order semantics thereafter.
        if version is None:
            version = self._new_version()
            self._versions[key] = version
        return {"value": None if value is _MISSING else value, "version": version}

    def getVersioned(self, target: dict[str, Any]) -> dict[str, Any] | None:
        """The value at a target and the token identifying this exact revision."""
        observed = self._observe(target)
        if observed is None:
            return None
        return {"value": copy_json(observed["value"]), "version": observed["version"]}

    def mutateAtomically(self, request: dict[str, Any]) -> dict[str, Any]:
        """Apply conditions and operations as one indivisible step."""
        validated = validate_atomic_request(request, self._atomic_limits)
        key = validated.idempotency_key
        if key is not None:
            prior = self._receipts.get(key)
            if prior is not None:
                if prior["requestDigest"] != validated.request_digest:
                    return {
                        "status": "idempotency-conflict",
                        "key": key,
                        "expectedRequestDigest": prior["requestDigest"],
                        "receivedRequestDigest": validated.request_digest,
                    }
                replayed: dict[str, Any] = {
                    "status": "replayed",
                    "requestDigest": prior["requestDigest"],
                    "versions": [
                        {"target": clone_target(entry["target"]), "version": entry["version"]}
                        for entry in prior["result"]["versions"]
                    ],
                }
                if "outcome" in prior["result"]:
                    replayed["outcome"] = clone_json(prior["result"]["outcome"])
                return replayed

        # All validation is complete before this point. Nothing here yields, so
        # no caller can observe an intermediate state between the condition
        # check and the last operation.
        for condition in validated.conditions:
            observed = self._observe(condition["target"])
            if not condition_matches(condition, observed):
                return {
                    "status": "conflict",
                    "condition": clone_condition(condition),
                    "observed": (
                        "missing"
                        if observed is None
                        else observed["version"]
                        if condition["expected"] == "version"
                        else "present"
                    ),
                }

        versions: list[dict[str, Any]] = []
        for operation in validated.operations:
            target = operation_target(operation)
            op = operation["op"]
            if op == "set":
                self.set(operation["key"], clone_json(operation["value"]))
                versions.append({"target": target, "version": self._versions[target_key(target)]})
            elif op == "delete":
                self.delete(operation["key"])
                versions.append({"target": target, "version": None})
            elif op == "put":
                self.put(operation["collection"], clone_json(operation["item"]))
                versions.append({"target": target, "version": self._versions[target_key(target)]})
            else:
                self.remove(operation["collection"], operation["id"])
                versions.append({"target": target, "version": None})

        applied: dict[str, Any] = {
            "status": "applied",
            "requestDigest": validated.request_digest,
            "versions": versions,
        }
        if validated.has_outcome:
            applied["outcome"] = clone_json(validated.outcome)
        if key is not None:
            receipt: dict[str, Any] = {
                "status": "applied",
                "requestDigest": applied["requestDigest"],
                "versions": [
                    {"target": clone_target(entry["target"]), "version": entry["version"]}
                    for entry in versions
                ],
            }
            if "outcome" in applied:
                receipt["outcome"] = clone_json(applied["outcome"])
            self._receipts[key] = {
                "requestDigest": validated.request_digest,
                "result": receipt,
            }
        return applied

    def listWhereIn(
        self,
        collection: str,
        field: str,
        values: list[Any],
        filter: StoreFilter | None = None,
    ) -> list[Any]:
        if len(values) == 0:
            return []
        for value in values:
            if not is_scalar(value):
                raise ValueError(IN_SCALAR_MESSAGE)
        items = list(self._collection(collection).values())
        matched = [item for item in items if _field_in(item, field, values)]
        return [copy_json(item) for item in apply_filter(matched, filter)]


def _field_in(item: Any, field: str, values: list[Any]) -> bool:
    if not isinstance(item, dict):
        return False
    record = cast(dict[str, Any], item)
    if field not in record:
        return False
    actual = record[field]
    return any(json_equal(actual, value) for value in values)
