"""Artifact metadata persisted through the canonical ``mirk.store`` port."""

from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any, cast
from urllib.parse import quote

from .errors import ArtifactConflictError, ArtifactOperationError
from .memory import compareRecords, cursorOffset, encodeCursor, matches
from .types import (
    ArtifactDigest,
    ArtifactLeaseMode,
    ArtifactLineageEdge,
    ArtifactObjectLease,
    ArtifactQuery,
    StoredArtifactPage,
    StoredArtifactRecord,
)
from .util import artifactFinalizationDigest, assertBoundedJson, cloneJson

__all__ = ["StoreArtifactRepository"]

_ENCODE_COMPONENT_SAFE = "-_.!~*'()"


class StoreArtifactRepository:
    """Artifact repository over a synchronous Mirk store.

    The collection and key names are the same strings as the TypeScript
    repository. Atomic receipts and leases use the store's existing atomic
    mutation primitive; this class does not create a second transaction layer.
    """

    atomicAvailable: bool

    def __init__(
        self,
        store: Any,
        namespace: str = "mirk-artifacts",
        now: Any = None,
        lease_id_factory: Any = None,
    ) -> None:
        self.store = store
        self._records = f"{namespace}:records"
        self._edges = f"{namespace}:lineage"
        self._idempotency_prefix = f"{namespace}:idempotency:"
        self._lease_state_prefix = f"{namespace}:lease-state:"
        self._leases = f"{namespace}:leases"
        self._now = now or _now_ms
        self._lease_id_factory = lease_id_factory or _lease_id
        self.atomicAvailable = callable(getattr(store, "mutateAtomically", None)) and callable(
            getattr(store, "getVersioned", None)
        )

    def create(self, record: StoredArtifactRecord) -> None:
        if self.get(record["id"]) is not None:
            raise ArtifactConflictError(f"artifact already exists: {record['id']}")
        idempotency_key = record.get("idempotencyKey")
        if idempotency_key and self.getByIdempotencyKey(idempotency_key):
            raise ArtifactConflictError(f"idempotency key already exists: {idempotency_key}")
        self.store.put(self._records, cloneJson(record))

    def get(self, id: str) -> StoredArtifactRecord | None:
        return self.store.getById(self._records, id)

    def getByDigest(self, digest: ArtifactDigest) -> list[StoredArtifactRecord]:
        return [
            cloneJson(record)
            for record in self.store.list(self._records)
            if record.get("digest") == digest
        ]

    def getByIdempotencyKey(self, key: str) -> StoredArtifactRecord | None:
        return next(
            (
                record
                for record in self.store.list(self._records)
                if record.get("idempotencyKey") == key
            ),
            None,
        )

    def list(self, query: ArtifactQuery | None = None) -> StoredArtifactPage:
        query = query or {}
        ordered = sorted(
            (record for record in self.store.list(self._records) if matches(record, query)),
            key=_RecordSortKey,
        )
        after = cursorOffset(ordered, query.get("cursor"))
        limit = min(max(int(query.get("limit", 50)), 1), 500)
        items = ordered[after : after + limit]
        page: StoredArtifactPage = {"items": [cloneJson(item) for item in items]}
        if after + limit < len(ordered) and items:
            page["nextCursor"] = encodeCursor(items[-1])
        return page

    def updateAnnotations(self, id: str, patch: Mapping[str, Any]) -> StoredArtifactRecord:
        record = self.get(id)
        if record is None:
            raise ArtifactOperationError("artifact-not-found", f"artifact not found: {id}")
        annotations = dict(record.get("annotations") or {})
        from .util import UNDEFINED

        for key, value in patch.items():
            if value is UNDEFINED:
                annotations.pop(key, None)
            else:
                annotations[key] = value
        assertBoundedJson(annotations, "annotations")
        updated = dict(record)
        if annotations:
            updated["annotations"] = annotations
        else:
            updated.pop("annotations", None)
        return self.store.put(self._records, cloneJson(updated))

    def delete(self, id: str) -> bool:
        if not self.store.remove(self._records, id):
            return False
        for edge in self.store.list(self._edges):
            if edge["sourceArtifactId"] == id or edge["resultArtifactId"] == id:
                self.store.remove(self._edges, edge["id"])
        return True

    def addLineage(self, edge: ArtifactLineageEdge) -> None:
        if self.store.getById(self._edges, edge["id"]) is not None:
            raise ArtifactConflictError(f"lineage edge already exists: {edge['id']}")
        if self.get(edge["sourceArtifactId"]) is None or self.get(edge["resultArtifactId"]) is None:
            raise ArtifactOperationError("missing-lineage-endpoint", "lineage endpoints must exist")
        if edge["sourceArtifactId"] == edge["resultArtifactId"] or self._reaches(
            edge["resultArtifactId"], edge["sourceArtifactId"]
        ):
            raise ArtifactConflictError("lineage cycle forbidden")
        parameters = edge.get("parameters")
        if parameters is not None:
            assertBoundedJson(parameters, "lineage parameters")
        self.store.put(self._edges, cloneJson(edge))

    def removeLineage(self, id: str) -> bool:
        return self.store.remove(self._edges, id)

    def getSources(self, id: str) -> list[ArtifactLineageEdge]:
        return [
            cloneJson(edge)
            for edge in self.store.list(self._edges)
            if edge["resultArtifactId"] == id
        ]

    def getDerivatives(self, id: str) -> list[ArtifactLineageEdge]:
        return [
            cloneJson(edge)
            for edge in self.store.list(self._edges)
            if edge["sourceArtifactId"] == id
        ]

    def createIdempotent(
        self,
        input: Mapping[str, Any] | None = None,
        *,
        record: StoredArtifactRecord | None = None,
        idempotencyKey: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        self._atomic()
        values = _merge_input(input, record=record, idempotencyKey=idempotencyKey)
        key = idempotency_key if idempotency_key is not None else values["idempotencyKey"]
        candidate: StoredArtifactRecord = values["record"]
        request_digest = artifactFinalizationDigest(candidate)
        index_key = self._idempotency_key(key)
        prior = self.store.get(index_key)
        if prior is not None:
            if prior["requestDigest"] != request_digest:
                return _conflict(prior["requestDigest"], request_digest)
            found = self.get(prior["recordId"])
            if found is None:
                return _conflict(prior["requestDigest"], request_digest)
            return {"status": "replayed", "requestDigest": request_digest, "record": found}
        legacy = self.getByIdempotencyKey(key)
        if legacy is not None:
            legacy_digest = artifactFinalizationDigest(legacy)
            if legacy_digest != request_digest:
                return _conflict(legacy_digest, request_digest)
            self.store.set(index_key, {"requestDigest": legacy_digest, "recordId": legacy["id"]})
            return {"status": "replayed", "requestDigest": request_digest, "record": legacy}

        result = self.store.mutateAtomically(
            {
                "conditions": [
                    {"target": {"kind": "key", "key": index_key}, "expected": "missing"},
                    {
                        "target": {
                            "kind": "record",
                            "collection": self._records,
                            "id": candidate["id"],
                        },
                        "expected": "missing",
                    },
                ],
                "operations": [
                    {
                        "op": "put",
                        "collection": self._records,
                        "item": {**candidate, "idempotencyKey": key},
                    },
                    {
                        "op": "set",
                        "key": index_key,
                        "value": {"requestDigest": request_digest, "recordId": candidate["id"]},
                    },
                ],
            }
        )
        if result["status"] == "conflict":
            raced = self.store.get(index_key)
            if raced is not None:
                found = self.get(raced["recordId"])
                if found is not None and raced["requestDigest"] == request_digest:
                    return {"status": "replayed", "requestDigest": request_digest, "record": found}
                return _conflict(raced["requestDigest"], request_digest)
            existing = self.get(candidate["id"])
            if existing is not None:
                return _conflict(artifactFinalizationDigest(existing), request_digest)
            raise RuntimeError("artifact idempotent mutation conflicted without a receipt")
        if result["status"] != "applied":
            raise RuntimeError("artifact idempotent mutation was not applied")
        saved = {**candidate, "idempotencyKey": key}
        return {"status": "created", "requestDigest": request_digest, "record": cloneJson(saved)}

    def acquireObjectLease(
        self,
        input: Mapping[str, Any] | None = None,
        *,
        objectKey: str | None = None,
        ownerId: str | None = None,
        mode: ArtifactLeaseMode | None = None,
        ttlMs: float | None = None,
        now: float | None = None,
    ) -> dict[str, Any]:
        self._atomic()
        values = _merge_input(
            input, objectKey=objectKey, ownerId=ownerId, mode=mode, ttlMs=ttlMs, now=now
        )
        object_key = values["objectKey"]
        owner_id = values["ownerId"]
        lease_mode = values["mode"]
        now_value = _number(values.get("now"), float(self._now()))
        ttl = max(1, _number(values.get("ttlMs"), 30_000))
        state_key = self._lease_state_key(object_key)
        for _ in range(8):
            current = self._versioned(state_key)
            state_value = current.get("value") if isinstance(current, dict) else None
            state: dict[str, Any] = (
                cast(dict[str, Any], state_value)
                if isinstance(state_value, dict)
                else {"generation": 0, "mode": "none", "leases": []}
            )
            live = [lease for lease in state["leases"] if lease["expiresAt"] > now_value]
            expired = [lease for lease in state["leases"] if lease["expiresAt"] <= now_value]
            if lease_mode == "shared-writer" and any(
                lease["mode"] == "exclusive-delete" for lease in live
            ):
                return {"status": "conflict", "reason": "exclusive-held"}
            if lease_mode == "exclusive-delete":
                if any(lease["mode"] == "exclusive-delete" for lease in live):
                    return {"status": "conflict", "reason": "exclusive-held"}
                if any(lease["mode"] == "shared-writer" for lease in live):
                    return {"status": "unavailable", "reason": "shared-held"}
                if self._objectReferences(object_key):
                    return {"status": "conflict", "reason": "reference-created"}
            generation = int(state["generation"]) + (1 if expired else 0)
            lease: ArtifactObjectLease = {
                "leaseId": str(self._lease_id_factory()),
                "ownerId": owner_id,
                "objectKey": object_key,
                "mode": lease_mode,
                "generation": generation,
                "heartbeatAt": now_value,
                "expiresAt": now_value + ttl,
            }
            next_state = {
                "generation": generation,
                "mode": "exclusive" if lease_mode == "exclusive-delete" else "shared",
                "leases": [*live, lease],
            }
            conditions = [
                {
                    "target": {"kind": "key", "key": state_key},
                    "expected": "version",
                    "version": current["version"],
                }
                if current is not None
                else {"target": {"kind": "key", "key": state_key}, "expected": "missing"}
            ]
            operations = [
                {"op": "set", "key": state_key, "value": next_state},
                {
                    "op": "put",
                    "collection": self._leases,
                    "item": {**lease, "id": lease["leaseId"]},
                },
            ]
            operations.extend(
                [
                    {"op": "remove", "collection": self._leases, "id": old["leaseId"]}
                    for old in expired
                ]
            )
            result = self.store.mutateAtomically(
                {"conditions": conditions, "operations": operations}
            )
            if result["status"] == "applied":
                return {"status": "acquired", "lease": cloneJson(lease)}
        return {"status": "unavailable", "reason": "expired"}

    def renewObjectLease(
        self,
        input: Mapping[str, Any] | None = None,
        *,
        leaseId: str | None = None,
        ownerId: str | None = None,
        objectKey: str | None = None,
        mode: ArtifactLeaseMode | None = None,
        generation: int | None = None,
        ttlMs: float | None = None,
        now: float | None = None,
        **_: Any,
    ) -> dict[str, Any]:
        self._atomic()
        values = _merge_input(
            input,
            leaseId=leaseId,
            ownerId=ownerId,
            objectKey=objectKey,
            mode=mode,
            generation=generation,
            ttlMs=ttlMs,
            now=now,
        )
        now_value = _number(values.get("now"), float(self._now()))
        state_key = self._lease_state_key(values["objectKey"])
        current = self._versioned(state_key)
        state_value = current.get("value") if isinstance(current, dict) else None
        state: dict[str, Any] | None = (
            cast(dict[str, Any], state_value) if isinstance(state_value, dict) else None
        )
        prior = (
            next(
                (lease for lease in state["leases"] if lease["leaseId"] == values["leaseId"]), None
            )
            if state
            else None
        )
        if (
            current is None
            or state is None
            or prior is None
            or prior["ownerId"] != values["ownerId"]
            or prior["mode"] != values["mode"]
            or prior["generation"] != values["generation"]
            or prior["expiresAt"] <= now_value
        ):
            return {"status": "unavailable", "reason": "expired"}
        lease = {
            **prior,
            "heartbeatAt": now_value,
            "expiresAt": now_value + max(1, float(values.get("ttlMs") or 30_000)),
        }
        next_state = {
            **state,
            "leases": [lease if x["leaseId"] == lease["leaseId"] else x for x in state["leases"]],
        }
        result = self.store.mutateAtomically(
            {
                "conditions": [
                    {
                        "target": {"kind": "key", "key": state_key},
                        "expected": "version",
                        "version": current["version"],
                    }
                ],
                "operations": [
                    {"op": "set", "key": state_key, "value": next_state},
                    {
                        "op": "put",
                        "collection": self._leases,
                        "item": {**lease, "id": lease["leaseId"]},
                    },
                ],
            }
        )
        return (
            {"status": "acquired", "lease": cloneJson(lease)}
            if result["status"] == "applied"
            else {"status": "unavailable", "reason": "expired"}
        )

    def releaseObjectLease(self, lease: ArtifactObjectLease) -> bool:
        self._atomic()
        state_key = self._lease_state_key(lease["objectKey"])
        current = self._versioned(state_key)
        state = current["value"] if current is not None else None
        if (
            current is None
            or state is None
            or not any(
                x["leaseId"] == lease["leaseId"]
                and x["ownerId"] == lease["ownerId"]
                and x["generation"] == lease["generation"]
                for x in state["leases"]
            )
        ):
            return False
        leases = [x for x in state["leases"] if x["leaseId"] != lease["leaseId"]]
        next_state = {
            "generation": state["generation"],
            "mode": "exclusive"
            if any(x["mode"] == "exclusive-delete" for x in leases)
            else "shared"
            if leases
            else "none",
            "leases": leases,
        }
        result = self.store.mutateAtomically(
            {
                "conditions": [
                    {
                        "target": {"kind": "key", "key": state_key},
                        "expected": "version",
                        "version": current["version"],
                    }
                ],
                "operations": [
                    {"op": "set", "key": state_key, "value": next_state},
                    {"op": "remove", "collection": self._leases, "id": lease["leaseId"]},
                ],
            }
        )
        return result["status"] == "applied"

    def createIdempotentWithLease(
        self,
        input: Mapping[str, Any] | None = None,
        *,
        record: StoredArtifactRecord | None = None,
        idempotencyKey: str | None = None,
        lease: ArtifactObjectLease | None = None,
        now: float | None = None,
    ) -> dict[str, Any]:
        values = _merge_input(
            input, record=record, idempotencyKey=idempotencyKey, lease=lease, now=now
        )
        candidate = values["record"]
        lease_value = values["lease"]
        if candidate.get("objectKey") != lease_value.get("objectKey"):
            return {"status": "lease-lost"}
        self._atomic()
        request_digest = artifactFinalizationDigest(candidate)
        state_key = self._lease_state_key(lease_value["objectKey"])
        current = self._versioned(state_key)
        state = current["value"] if current is not None else None
        active = (
            next((x for x in state["leases"] if x["leaseId"] == lease_value["leaseId"]), None)
            if state
            else None
        )
        now_value = _number(values.get("now"), float(self._now()))
        if (
            current is None
            or state is None
            or active is None
            or active["ownerId"] != lease_value["ownerId"]
            or active["objectKey"] != lease_value["objectKey"]
            or active["generation"] != lease_value["generation"]
            or active["mode"] != "shared-writer"
            or active["expiresAt"] <= now_value
        ):
            return {"status": "lease-lost"}
        key = values["idempotencyKey"]
        index_key = self._idempotency_key(key)
        prior = self.store.get(index_key)
        if prior is not None:
            if prior["requestDigest"] != request_digest:
                return _conflict(prior["requestDigest"], request_digest)
            found = self.get(prior["recordId"])
            return (
                {"status": "replayed", "requestDigest": request_digest, "record": found}
                if found is not None
                else _conflict(prior["requestDigest"], request_digest)
            )
        result = self.store.mutateAtomically(
            {
                "conditions": [
                    {
                        "target": {"kind": "key", "key": state_key},
                        "expected": "version",
                        "version": current["version"],
                    },
                    {"target": {"kind": "key", "key": index_key}, "expected": "missing"},
                    {
                        "target": {
                            "kind": "record",
                            "collection": self._records,
                            "id": candidate["id"],
                        },
                        "expected": "missing",
                    },
                ],
                "operations": [
                    {
                        "op": "put",
                        "collection": self._records,
                        "item": {**candidate, "idempotencyKey": key},
                    },
                    {
                        "op": "set",
                        "key": index_key,
                        "value": {"requestDigest": request_digest, "recordId": candidate["id"]},
                    },
                ],
            }
        )
        if result["status"] == "applied":
            return {
                "status": "created",
                "requestDigest": request_digest,
                "record": cloneJson({**candidate, "idempotencyKey": key}),
            }
        raced = self.store.get(index_key)
        if raced is not None:
            found = self.get(raced["recordId"])
            if raced["requestDigest"] == request_digest and found is not None:
                return {"status": "replayed", "requestDigest": request_digest, "record": found}
            return _conflict(raced["requestDigest"], request_digest)
        return {"status": "lease-lost"}

    def createWithLease(
        self,
        input: Mapping[str, Any] | None = None,
        *,
        record: StoredArtifactRecord | None = None,
        lease: ArtifactObjectLease | None = None,
        now: float | None = None,
    ) -> dict[str, str]:
        values = _merge_input(input, record=record, lease=lease, now=now)
        candidate = values["record"]
        lease_value = values["lease"]
        if candidate.get("objectKey") != lease_value.get("objectKey"):
            return {"status": "lease-lost"}
        self._atomic()
        state_key = self._lease_state_key(lease_value["objectKey"])
        current = self._versioned(state_key)
        state = current["value"] if current is not None else None
        active = (
            next((x for x in state["leases"] if x["leaseId"] == lease_value["leaseId"]), None)
            if state
            else None
        )
        now_value = _number(values.get("now"), float(self._now()))
        if (
            current is None
            or state is None
            or active is None
            or active["ownerId"] != lease_value["ownerId"]
            or active["objectKey"] != lease_value["objectKey"]
            or active["generation"] != lease_value["generation"]
            or active["mode"] != "shared-writer"
            or active["expiresAt"] <= now_value
        ):
            return {"status": "lease-lost"}
        result = self.store.mutateAtomically(
            {
                "conditions": [
                    {
                        "target": {"kind": "key", "key": state_key},
                        "expected": "version",
                        "version": current["version"],
                    },
                    {
                        "target": {
                            "kind": "record",
                            "collection": self._records,
                            "id": candidate["id"],
                        },
                        "expected": "missing",
                    },
                ],
                "operations": [
                    {"op": "put", "collection": self._records, "item": cloneJson(candidate)}
                ],
            }
        )
        if result["status"] == "applied":
            return {"status": "created"}
        return (
            {"status": "conflict"}
            if self.get(candidate["id"]) is not None
            else {"status": "lease-lost"}
        )

    def _atomic(self) -> Any:
        if not self.atomicAvailable:
            raise ArtifactOperationError(
                "atomic-mutation-unavailable",
                "artifact repository atomic mutation is unavailable; use single-writer mode",
            )
        return self.store

    def _versioned(self, key: str) -> dict[str, Any] | None:
        return cast(dict[str, Any] | None, self.store.getVersioned({"kind": "key", "key": key}))

    def _idempotency_key(self, key: str) -> str:
        return f"{self._idempotency_prefix}{quote(key, safe=_ENCODE_COMPONENT_SAFE)}"

    def _lease_state_key(self, object_key: str) -> str:
        return f"{self._lease_state_prefix}{quote(object_key, safe=_ENCODE_COMPONENT_SAFE)}"

    def _objectReferences(self, object_key: str) -> list[StoredArtifactRecord]:
        return [
            record
            for record in self.store.list(self._records)
            if record.get("objectKey") == object_key
        ]

    def _reaches(self, source: str, target: str, seen: set[str] | None = None) -> bool:
        if source == target:
            return True
        seen = seen or set()
        if source in seen:
            return False
        seen.add(source)
        return any(
            self._reaches(edge["resultArtifactId"], target, seen)
            for edge in self.getDerivatives(source)
        )


class _RecordSortKey:
    def __init__(self, record: StoredArtifactRecord) -> None:
        self.record = record

    def __lt__(self, other: object) -> bool:
        return isinstance(other, _RecordSortKey) and compareRecords(self.record, other.record) < 0


def _conflict(expected: str, received: str) -> dict[str, str]:
    return {
        "status": "conflict",
        "expectedRequestDigest": expected,
        "receivedRequestDigest": received,
    }


def _merge_input(input: Mapping[str, Any] | None, **kwargs: Any) -> dict[str, Any]:
    values = dict(input or {})
    values.update({key: value for key, value in kwargs.items() if value is not None})
    return values


def _now_ms() -> float:
    return time.time() * 1000


def _number(value: Any, default: float) -> float:
    return default if value is None else float(value)


def _lease_id() -> str:
    import uuid

    return f"lease-{uuid.uuid4().hex}"
