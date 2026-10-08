"""Zero-native reference object store and artifact repository."""

from __future__ import annotations

import secrets
import time
from collections.abc import Mapping
from functools import cmp_to_key
from typing import Any

from .errors import ArtifactConflictError, ArtifactOperationError
from .types import (
    ArtifactDigest,
    ArtifactLeaseMode,
    ArtifactLineageEdge,
    ArtifactObjectLease,
    ArtifactQuery,
    ByteSource,
    ObjectInfo,
    ObjectPutOptions,
    StoredArtifactPage,
    StoredArtifactRecord,
)
from .util import (
    UNDEFINED,
    artifactFinalizationDigest,
    assertBoundedJson,
    assertObjectKey,
    chunks,
    cloneJson,
)

__all__ = [
    "ArtifactConflictError",
    "InMemoryArtifactRepository",
    "InMemoryObjectStore",
    "ObjectAlreadyExistsError",
    "compareRecords",
    "cursorOffset",
    "encodeCursor",
    "matches",
]


class ObjectAlreadyExistsError(Exception):
    def __init__(self, key: str) -> None:
        super().__init__(f"object already exists: {key}")


class InMemoryObjectStore:
    def __init__(self) -> None:
        self._objects: dict[str, tuple[bytes, ObjectInfo]] = {}

    def put(
        self, key: str, source: ByteSource, options: ObjectPutOptions | None = None
    ) -> ObjectInfo:
        assertObjectKey(key)
        options = options or {}
        if options.get("ifAbsent") and key in self._objects:
            raise ObjectAlreadyExistsError(key)
        parts = list(chunks(source))
        value = b"".join(parts)
        info: ObjectInfo = {"key": key, "sizeBytes": len(value)}
        media_type = options.get("mediaType")
        metadata = options.get("metadata")
        if media_type:
            info["mediaType"] = media_type
        if metadata is not None:
            info["metadata"] = dict(metadata)
        self._objects[key] = (value, info)
        return cloneJson(info)

    def get(self, key: str):
        assertObjectKey(key)
        found = self._objects.get(key)
        if found is None:
            return None
        value = bytes(found[0])

        def stream():
            yield value

        return stream()

    def head(self, key: str) -> ObjectInfo | None:
        assertObjectKey(key)
        found = self._objects.get(key)
        return cloneJson(found[1]) if found else None

    def delete(self, key: str) -> bool:
        assertObjectKey(key)
        return self._objects.pop(key, None) is not None

    def list(self, prefix: str = "") -> list[ObjectInfo]:
        if prefix:
            assertObjectKey(prefix)
        infos = [
            cloneJson(info) for _, info in self._objects.values() if info["key"].startswith(prefix)
        ]
        return sorted(infos, key=lambda info: info["key"])


class InMemoryArtifactRepository:
    atomicAvailable = True

    def __init__(self, *, now: Any = None, lease_id_factory: Any = None) -> None:
        self._records: dict[str, StoredArtifactRecord] = {}
        self._edges: dict[str, ArtifactLineageEdge] = {}
        self._receipts: dict[str, dict[str, str]] = {}
        self._leases: dict[str, ArtifactObjectLease] = {}
        self._generations: dict[str, int] = {}
        self._now = now or (lambda: time.time() * 1000)
        self._lease_id_factory = lease_id_factory or (lambda: f"lease-{secrets.token_hex(8)}")

    def create(self, record: StoredArtifactRecord) -> None:
        if record["id"] in self._records:
            raise ArtifactConflictError(f"artifact already exists: {record['id']}")
        idempotency_key = record.get("idempotencyKey")
        if idempotency_key and self.getByIdempotencyKey(idempotency_key):
            raise ArtifactConflictError(f"idempotency key already exists: {idempotency_key}")
        self._records[record["id"]] = cloneJson(record)

    def get(self, id: str) -> StoredArtifactRecord | None:
        record = self._records.get(id)
        return cloneJson(record) if record is not None else None

    def getByDigest(self, digest: ArtifactDigest) -> list[StoredArtifactRecord]:
        return [
            cloneJson(record) for record in self._records.values() if record["digest"] == digest
        ]

    def getByIdempotencyKey(self, key: str) -> StoredArtifactRecord | None:
        for record in self._records.values():
            if record.get("idempotencyKey") == key:
                return cloneJson(record)
        return None

    def list(self, query: ArtifactQuery | None = None) -> StoredArtifactPage:
        query = query or {}
        ordered = sorted(
            (record for record in self._records.values() if matches(record, query)),
            key=cmp_to_key(compareRecords),
        )
        after = cursorOffset(ordered, query.get("cursor"))
        limit = min(max(int(query.get("limit", 50)), 1), 500)
        items = ordered[after : after + limit]
        page: StoredArtifactPage = {"items": [cloneJson(item) for item in items]}
        if after + limit < len(ordered) and items:
            page["nextCursor"] = encodeCursor(items[-1])
        return page

    def updateAnnotations(self, id: str, patch: Mapping[str, Any]) -> StoredArtifactRecord:
        record = self._records.get(id)
        if record is None:
            raise ArtifactOperationError("artifact-not-found", f"artifact not found: {id}")
        annotations = dict(record.get("annotations") or {})
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
        self._records[id] = cloneJson(updated)
        return cloneJson(updated)

    def delete(self, id: str) -> bool:
        if self._records.pop(id, None) is None:
            return False
        for edge_id, edge in list(self._edges.items()):
            if edge["sourceArtifactId"] == id or edge["resultArtifactId"] == id:
                del self._edges[edge_id]
        return True

    def createIdempotent(
        self,
        input: Mapping[str, Any] | None = None,
        *,
        record: StoredArtifactRecord | None = None,
        idempotencyKey: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        values = dict(input or {})
        if record is not None:
            values["record"] = record
        if idempotencyKey is not None:
            values["idempotencyKey"] = idempotencyKey
        key = idempotency_key if idempotency_key is not None else values["idempotencyKey"]
        candidate: StoredArtifactRecord = values["record"]
        request_digest = artifactFinalizationDigest(candidate)
        prior = self._receipts.get(key)
        if prior is not None:
            if prior["requestDigest"] != request_digest:
                return {
                    "status": "conflict",
                    "expectedRequestDigest": prior["requestDigest"],
                    "receivedRequestDigest": request_digest,
                }
            existing = self._records.get(prior["recordId"])
            if existing is None:
                return {
                    "status": "conflict",
                    "expectedRequestDigest": prior["requestDigest"],
                    "receivedRequestDigest": request_digest,
                }
            return {
                "status": "replayed",
                "requestDigest": request_digest,
                "record": cloneJson(existing),
            }

        legacy = self.getByIdempotencyKey(key)
        if legacy is not None:
            legacy_digest = artifactFinalizationDigest(legacy)
            if legacy_digest != request_digest:
                return {
                    "status": "conflict",
                    "expectedRequestDigest": legacy_digest,
                    "receivedRequestDigest": request_digest,
                }
            self._receipts[key] = {
                "requestDigest": legacy_digest,
                "recordId": legacy["id"],
            }
            return {"status": "replayed", "requestDigest": request_digest, "record": legacy}

        same_id = self._records.get(candidate["id"])
        if same_id is not None:
            existing_digest = artifactFinalizationDigest(same_id)
            return {
                "status": "conflict",
                "expectedRequestDigest": existing_digest,
                "receivedRequestDigest": request_digest,
            }
        saved = dict(candidate)
        saved["idempotencyKey"] = key
        self._records[candidate["id"]] = cloneJson(saved)
        self._receipts[key] = {
            "requestDigest": request_digest,
            "recordId": candidate["id"],
        }
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
        values = dict(input or {})
        if objectKey is not None:
            values["objectKey"] = objectKey
        if ownerId is not None:
            values["ownerId"] = ownerId
        if mode is not None:
            values["mode"] = mode
        if ttlMs is not None:
            values["ttlMs"] = ttlMs
        if now is not None:
            values["now"] = now
        object_key = values["objectKey"]
        owner_id = values["ownerId"]
        lease_mode = values["mode"]
        ttl_ms = values.get("ttlMs")
        now = values.get("now")
        now_value = self._time(now)
        ttl = max(1, float(ttl_ms if ttl_ms is not None else 30_000))
        self._reclaimExpired(object_key, now_value)
        active = [
            lease
            for lease in self._leases.values()
            if lease["objectKey"] == object_key and lease["expiresAt"] > now_value
        ]
        if lease_mode == "shared-writer" and any(
            lease["mode"] == "exclusive-delete" for lease in active
        ):
            return {"status": "conflict", "reason": "exclusive-held"}
        if lease_mode == "exclusive-delete":
            if any(lease["mode"] == "exclusive-delete" for lease in active):
                return {"status": "conflict", "reason": "exclusive-held"}
            if any(lease["mode"] == "shared-writer" for lease in active):
                return {"status": "unavailable", "reason": "shared-held"}
            if any(record["objectKey"] == object_key for record in self._records.values()):
                return {"status": "conflict", "reason": "reference-created"}
        generation = self._generations.get(object_key, 0)
        lease: ArtifactObjectLease = {
            "leaseId": str(self._lease_id_factory()),
            "ownerId": owner_id,
            "objectKey": object_key,
            "mode": lease_mode,
            "generation": generation,
            "heartbeatAt": now_value,
            "expiresAt": now_value + ttl,
        }
        self._leases[lease["leaseId"]] = lease
        return {"status": "acquired", "lease": cloneJson(lease)}

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
        values = dict(input or {})
        if leaseId is not None:
            values["leaseId"] = leaseId
        if ownerId is not None:
            values["ownerId"] = ownerId
        if objectKey is not None:
            values["objectKey"] = objectKey
        if mode is not None:
            values["mode"] = mode
        if generation is not None:
            values["generation"] = generation
        if ttlMs is not None:
            values["ttlMs"] = ttlMs
        if now is not None:
            values["now"] = now
        lease_id = values["leaseId"]
        owner_id = values["ownerId"]
        object_key = values["objectKey"]
        lease_mode = values["mode"]
        generation_value = values["generation"]
        ttl_ms = values.get("ttlMs")
        now = values.get("now")
        now_value = self._time(now)
        current = self._leases.get(lease_id)
        if (
            current is None
            or current["ownerId"] != owner_id
            or current["objectKey"] != object_key
            or current["mode"] != lease_mode
            or current["generation"] != generation_value
            or current["expiresAt"] <= now_value
        ):
            return {"status": "unavailable", "reason": "expired"}
        lease = dict(current)
        lease["heartbeatAt"] = now_value
        lease["expiresAt"] = now_value + max(1, float(ttl_ms if ttl_ms is not None else 30_000))
        self._leases[lease_id] = lease  # type: ignore[assignment]
        return {"status": "acquired", "lease": cloneJson(lease)}

    def releaseObjectLease(self, lease: ArtifactObjectLease) -> bool:
        current = self._leases.get(lease["leaseId"])
        if (
            current is None
            or current["ownerId"] != lease["ownerId"]
            or current["generation"] != lease["generation"]
            or current["objectKey"] != lease["objectKey"]
        ):
            return False
        del self._leases[lease["leaseId"]]
        return True

    def createIdempotentWithLease(
        self,
        input: Mapping[str, Any] | None = None,
        *,
        record: StoredArtifactRecord | None = None,
        idempotencyKey: str | None = None,
        lease: ArtifactObjectLease | None = None,
        now: float | None = None,
    ) -> dict[str, Any]:
        values = dict(input or {})
        if record is not None:
            values["record"] = record
        if idempotencyKey is not None:
            values["idempotencyKey"] = idempotencyKey
        if lease is not None:
            values["lease"] = lease
        record = values["record"]
        idempotency_key = values["idempotencyKey"]
        lease = values["lease"]
        now = values.get("now", now)
        if lease is None:
            raise TypeError("createIdempotentWithLease requires lease")
        if record is None:
            raise TypeError("createIdempotentWithLease requires record")
        if record.get("objectKey") != lease.get("objectKey"):
            return {"status": "lease-lost"}
        if not self._holdsSharedWriterLease(lease, self._time(now)):
            return {"status": "lease-lost"}
        return self.createIdempotent(record=record, idempotencyKey=idempotency_key)

    def createWithLease(
        self,
        record: StoredArtifactRecord | None = None,
        *,
        lease: ArtifactObjectLease | None = None,
        now: float | None = None,
        input: Mapping[str, Any] | None = None,
    ) -> dict[str, str]:
        if input is None and isinstance(record, Mapping) and "record" in record:
            input = record
            record = None
        if input is not None:
            record = input.get("record")
            lease = input.get("lease")
            if now is None:
                now = input.get("now")
        if record is None or lease is None:
            raise TypeError("createWithLease requires record and lease")
        if record.get("objectKey") != lease.get("objectKey"):
            return {"status": "lease-lost"}
        if not self._holdsSharedWriterLease(lease, self._time(now)):
            return {"status": "lease-lost"}
        idempotency_key = record.get("idempotencyKey")
        if record["id"] in self._records or (
            idempotency_key and self.getByIdempotencyKey(idempotency_key) is not None
        ):
            return {"status": "conflict"}
        self._records[record["id"]] = cloneJson(record)
        return {"status": "created"}

    def removeLineage(self, id: str) -> bool:
        return self._edges.pop(id, None) is not None

    def addLineage(self, edge: ArtifactLineageEdge) -> None:
        if edge["id"] in self._edges:
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
        self._edges[edge["id"]] = cloneJson(edge)

    def getSources(self, id: str) -> list[ArtifactLineageEdge]:
        return [cloneJson(edge) for edge in self._edges.values() if edge["resultArtifactId"] == id]

    def getDerivatives(self, id: str) -> list[ArtifactLineageEdge]:
        return [cloneJson(edge) for edge in self._edges.values() if edge["sourceArtifactId"] == id]

    def _time(self, now: float | None) -> float:
        return float(self._now() if now is None else now)

    def _reclaimExpired(self, objectKey: str, now: float) -> None:
        expired = [
            lease_id
            for lease_id, lease in self._leases.items()
            if lease["objectKey"] == objectKey and lease["expiresAt"] <= now
        ]
        for lease_id in expired:
            del self._leases[lease_id]
        if expired:
            self._generations[objectKey] = self._generations.get(objectKey, 0) + 1

    def _holdsSharedWriterLease(self, lease: ArtifactObjectLease, now: float) -> bool:
        current = self._leases.get(lease["leaseId"])
        return bool(
            current
            and current["ownerId"] == lease["ownerId"]
            and current["objectKey"] == lease["objectKey"]
            and current["generation"] == lease["generation"]
            and current["mode"] == "shared-writer"
            and current["expiresAt"] > now
        )

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


def compareRecords(a: StoredArtifactRecord, b: StoredArtifactRecord) -> int:
    if a["createdAt"] != b["createdAt"]:
        return -1 if a["createdAt"] > b["createdAt"] else 1
    left, right = str(b["id"]), str(a["id"])
    return -1 if left < right else 1 if left > right else 0


def encodeCursor(record: StoredArtifactRecord) -> str:
    return f"{record['createdAt']}:{record['id']}"


def cursorOffset(records: list[StoredArtifactRecord], cursor: str | None) -> int:
    if not cursor:
        return 0
    for index, record in enumerate(records):
        if encodeCursor(record) == cursor:
            return index + 1
    raise ArtifactOperationError("invalid-cursor", "invalid artifact cursor")


def matches(record: StoredArtifactRecord, query: ArtifactQuery) -> bool:
    producer = dict(record.get("producer") or {})
    media_type = query.get("mediaType")
    media_type_prefix = query.get("mediaTypePrefix")
    kind = query.get("kind")
    producer_system = query.get("producerSystem")
    producer_job_id = query.get("producerJobId")
    producer_attempt_id = query.get("producerAttemptId")
    producer_output_slot = query.get("producerOutputSlot")
    created_after = query.get("createdAfter")
    created_before = query.get("createdBefore")
    return not (
        (media_type and record.get("mediaType") != media_type)
        or (
            media_type_prefix and not str(record.get("mediaType", "")).startswith(media_type_prefix)
        )
        or (kind and record.get("kind") != kind)
        or (producer_system and producer.get("system") != producer_system)
        or (producer_job_id and producer.get("jobId") != producer_job_id)
        or (producer_attempt_id and producer.get("attemptId") != producer_attempt_id)
        or (producer_output_slot and producer.get("outputSlot") != producer_output_slot)
        or (created_after is not None and record["createdAt"] <= created_after)
        or (created_before is not None and record["createdAt"] >= created_before)
    )
