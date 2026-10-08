"""Read-only artifact audits and conditional, lease-protected repair."""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from contextlib import suppress
from typing import Any, cast

from .types import (
    ArtifactLeaseRepository,
    ArtifactQuery,
    ArtifactRepository,
    ListableObjectStore,
    ObjectStore,
    StoredArtifactRecord,
)
from .util import cloneJson, digestStream, makeId, metadataFingerprint


class ArtifactMaintenance:
    """Audit object/repository residue and apply explicit repair actions.

    A maintenance reference is meaningful only to this instance and audit.  It
    keeps physical object keys out of reports and plans while retaining the
    snapshot needed to perform a conditional repair later.
    """

    def __init__(
        self,
        objects: ObjectStore,
        repository: ArtifactRepository,
        *,
        now: Callable[[], int | float] | None = None,
        owner_id: str | None = None,
        lease_ttl_ms: int = 30_000,
        audit_id_factory: Callable[[], str] | None = None,
    ) -> None:
        self.objects: ObjectStore = objects
        self.repository: ArtifactRepository = repository
        self.now = now or (lambda: time.time() * 1000)
        self.owner_id = owner_id or f"artifact-maintenance-{uuid.uuid4().hex}"
        self.lease_ttl_ms = max(1, int(lease_ttl_ms))
        self.audit_id_factory = audit_id_factory or makeId
        self._snapshots: dict[str, dict[str, Any]] = {}

    def audit(self) -> dict[str, Any]:
        audit_id = str(self.audit_id_factory())
        records = self._all_records()
        snapshot: dict[str, Any] = {
            "refs": {},
            "records": {record["id"]: cloneJson(record) for record in records},
            "edges": {},
        }
        findings: list[dict[str, Any]] = []
        records_by_object: dict[str, list[dict[str, Any]]] = {}
        for record in records:
            records_by_object.setdefault(record["objectKey"], []).append(
                cast(dict[str, Any], record)
            )
            for edge in self.repository.getSources(record["id"]):
                snapshot["edges"][edge["id"]] = cloneJson(edge)
            for edge in self.repository.getDerivatives(record["id"]):
                snapshot["edges"][edge["id"]] = cloneJson(edge)
        for object_key, owners in records_by_object.items():
            head = self.objects.head(object_key)
            if head is None:
                for record in owners:
                    findings.append(
                        {
                            "code": "record-without-object",
                            "artifactId": record["id"],
                            "detail": "artifact record has no readable object",
                        }
                    )
                continue
            actual = self._object_digest(object_key)
            if actual is None:
                for record in owners:
                    findings.append(
                        {
                            "code": "record-without-object",
                            "artifactId": record["id"],
                            "detail": "artifact record has no readable object",
                        }
                    )
                continue
            for record in owners:
                if actual["sizeBytes"] != record["sizeBytes"]:
                    findings.append(
                        {
                            "code": "size-mismatch",
                            "artifactId": record["id"],
                            "detail": f"stored size differs for artifact {record['id']}",
                        }
                    )
                if actual["digest"]["value"] != record["digest"]["value"]:
                    findings.append(
                        {
                            "code": "digest-mismatch",
                            "artifactId": record["id"],
                            "detail": f"stored digest differs for artifact {record['id']}",
                        }
                    )

        scanned_objects: int | None = None
        list_method = getattr(self.objects, "list", None)
        if callable(list_method):
            infos = cast(ListableObjectStore, self.objects).list()
            scanned_objects = len(infos)
            for info in infos:
                key = info.get("key")
                if key in records_by_object:
                    continue
                actual = self._object_digest(key)
                size = actual["sizeBytes"] if actual is not None else info.get("sizeBytes", 0)
                observed: dict[str, Any] = {"objectKey": key, "observedSizeBytes": size}
                if actual is not None:
                    observed["observedDigest"] = actual["digest"]["value"]
                etag = info.get("etag")
                if etag is not None:
                    observed["observedEtag"] = etag
                ref = self._opaque_ref(audit_id, observed, snapshot)
                findings.append(
                    {
                        "code": "object-without-record",
                        "maintenanceRef": ref,
                        "detail": "object is not referenced by an artifact record",
                    }
                )
        self._lineage_findings(snapshot, findings)
        findings.sort(
            key=lambda finding: "\x00".join(
                (
                    finding.get("code", ""),
                    finding.get("artifactId", ""),
                    finding.get("maintenanceRef", ""),
                    finding.get("detail", ""),
                )
            )
        )
        self._snapshots[audit_id] = snapshot
        report: dict[str, Any] = {
            "auditId": audit_id,
            "scannedRecords": len(records),
            "findings": findings,
        }
        if scanned_objects is None:
            report["coverage"] = "partial"
        else:
            report["scannedObjects"] = scanned_objects
            report["coverage"] = "complete"
        return report

    def planRepair(
        self, report: dict[str, Any], *, createdAt: int | float | None = None
    ) -> dict[str, Any]:
        audit_id = report.get("auditId")
        snapshot = self._snapshots.get(audit_id) if isinstance(audit_id, str) else None
        actions: list[dict[str, Any]] = []
        if snapshot is not None:
            for finding in report.get("findings", []):
                operation: str | None = None
                precondition: dict[str, Any] | None = None
                code = finding.get("code")
                if code == "object-without-record" and finding.get("maintenanceRef"):
                    obj = snapshot["refs"].get(finding["maintenanceRef"])
                    if obj:
                        operation = "delete-unreferenced-object"
                        precondition = {
                            "kind": "object-unreferenced",
                            "maintenanceRef": finding["maintenanceRef"],
                            "observedSizeBytes": obj["observedSizeBytes"],
                        }
                        for key in ("observedDigest", "observedEtag"):
                            if key in obj:
                                precondition[key] = obj[key]
                elif code == "record-without-object" and finding.get("artifactId"):
                    record = snapshot["records"].get(finding["artifactId"])
                    if record:
                        operation = "delete-record-without-object"
                        precondition = {
                            "kind": "record-missing-object",
                            "artifactId": record["id"],
                            "recordFingerprint": metadataFingerprint(record),
                        }
                elif code in ("size-mismatch", "digest-mismatch") and finding.get("artifactId"):
                    record = snapshot["records"].get(finding["artifactId"])
                    if record:
                        operation = "reverify-imported-object"
                        precondition = {
                            "kind": "artifact-descriptor-current",
                            "artifactId": record["id"],
                            "descriptorFingerprint": metadataFingerprint(record),
                        }
                elif code in (
                    "lineage-missing-source",
                    "lineage-missing-result",
                    "lineage-cycle",
                ) and finding.get("detail"):
                    edge = snapshot["edges"].get(finding["detail"])
                    if edge:
                        operation = "remove-invalid-lineage-edge"
                        precondition = {
                            "kind": "lineage-edge-invalid",
                            "edgeId": edge["id"],
                            "edgeFingerprint": metadataFingerprint(edge),
                            "expectedReason": "cycle"
                            if code == "lineage-cycle"
                            else "missing-source"
                            if code == "lineage-missing-source"
                            else "missing-result",
                        }
                if operation is not None and precondition is not None:
                    action = {
                        "id": metadataFingerprint(
                            {
                                "schema": "mirk-artifact-repair/v1",
                                "auditId": report.get("auditId"),
                                "operation": operation,
                                "precondition": precondition,
                            }
                        ),
                        "operation": operation,
                        "precondition": precondition,
                    }
                    if not any(item["id"] == action["id"] for item in actions):
                        actions.append(action)
        actions.sort(key=lambda action: action["id"])
        return {
            "schema": "mirk-artifact-repair/v1",
            "auditId": report.get("auditId"),
            "createdAt": self.now() if createdAt is None else createdAt,
            "actions": actions,
        }

    def applyRepair(self, plan: dict[str, Any]) -> list[dict[str, Any]]:
        audit_id = plan.get("auditId")
        snapshot = self._snapshots.get(audit_id) if isinstance(audit_id, str) else None
        if snapshot is None:
            return [
                {"status": "not-found", "actionId": action["id"]}
                for action in plan.get("actions", [])
            ]
        results: list[dict[str, Any]] = []
        for action in plan.get("actions", []):
            operation = action["operation"]
            precondition = action["precondition"]
            if operation == "delete-unreferenced-object":
                results.append(self._delete_orphan(action, precondition, snapshot))
            elif operation == "delete-record-without-object":
                results.append(self._delete_missing_record(action, precondition))
            elif operation == "reverify-imported-object":
                results.append(self._reverify(action, precondition))
            elif operation == "remove-invalid-lineage-edge":
                results.append(self._remove_edge(action, precondition))
        return results

    def _all_records(self) -> list[StoredArtifactRecord]:
        result: list[StoredArtifactRecord] = []
        cursor: str | None = None
        while True:
            query: dict[str, Any] = {"limit": 500}
            if cursor is not None:
                query["cursor"] = cursor
            page = self.repository.list(cast(ArtifactQuery, query))
            result.extend(page.get("items", []))
            cursor = page.get("nextCursor")
            if not cursor:
                return result

    def _object_digest(self, key: str) -> dict[str, Any] | None:
        try:
            stream = self.objects.get(key)
            if stream is None:
                return None
            digest, size = digestStream(stream)
            return {"digest": digest, "sizeBytes": size}
        except Exception:
            return None

    def _opaque_ref(self, audit_id: str, observed: dict[str, Any], snapshot: dict[str, Any]) -> str:
        ref = f"ref-{audit_id}-{len(snapshot['refs']) + 1}"
        snapshot["refs"][ref] = observed
        return ref

    def _lineage_findings(self, snapshot: dict[str, Any], findings: list[dict[str, Any]]) -> None:
        records = snapshot["records"]
        edges = snapshot["edges"]
        for edge in edges.values():
            if edge["sourceArtifactId"] not in records:
                findings.append({"code": "lineage-missing-source", "detail": edge["id"]})
            if edge["resultArtifactId"] not in records:
                findings.append({"code": "lineage-missing-result", "detail": edge["id"]})
        visiting: set[str] = set()
        visited: set[str] = set()

        def walk(artifact_id: str) -> bool:
            if artifact_id in visiting:
                return True
            if artifact_id in visited:
                return False
            visiting.add(artifact_id)
            for edge in edges.values():
                if edge["sourceArtifactId"] == artifact_id and walk(edge["resultArtifactId"]):
                    findings.append({"code": "lineage-cycle", "detail": edge["id"]})
                    visiting.discard(artifact_id)
                    return True
            visiting.discard(artifact_id)
            visited.add(artifact_id)
            return False

        for artifact_id in records:
            walk(artifact_id)

    def _lease_repository(self) -> ArtifactLeaseRepository | None:
        candidate = self.repository
        if (
            callable(getattr(candidate, "acquireObjectLease", None))
            and getattr(candidate, "atomicAvailable", True) is not False
        ):
            return cast(ArtifactLeaseRepository, candidate)
        return None

    def _delete_orphan(
        self, action: dict[str, Any], precondition: dict[str, Any], snapshot: dict[str, Any]
    ) -> dict[str, Any]:
        obj = snapshot["refs"].get(precondition.get("maintenanceRef"))
        if obj is None:
            return {"status": "not-found", "actionId": action["id"]}
        key = cast(str, obj["objectKey"])
        if any(record.get("objectKey") == key for record in self._all_records()):
            return {"status": "conflict", "actionId": action["id"], "reason": "reference-created"}
        leases = self._lease_repository()
        if leases is None:
            return {"status": "conflict", "actionId": action["id"], "reason": "lease-unavailable"}
        acquired = leases.acquireObjectLease(
            objectKey=key,
            ownerId=self.owner_id,
            mode="exclusive-delete",
            ttlMs=self.lease_ttl_ms,
            now=self.now(),
        )
        if acquired.get("status") != "acquired":
            return {
                "status": "conflict",
                "actionId": action["id"],
                "reason": "reference-created"
                if acquired.get("reason") == "reference-created"
                else "lease-unavailable",
            }
        lease = cast(Any, acquired)["lease"]
        try:
            if any(record.get("objectKey") == key for record in self._all_records()):
                return {
                    "status": "conflict",
                    "actionId": action["id"],
                    "reason": "reference-created",
                }
            renewed = leases.renewObjectLease(
                leaseId=lease["leaseId"],
                ownerId=lease["ownerId"],
                objectKey=lease["objectKey"],
                mode=lease["mode"],
                generation=lease["generation"],
                ttlMs=self.lease_ttl_ms,
                now=self.now(),
            )
            if renewed.get("status") != "acquired":
                return {
                    "status": "conflict",
                    "actionId": action["id"],
                    "reason": "lease-unavailable",
                }
            lease = cast(Any, renewed)["lease"]
            if not self._matches_object_precondition(key, precondition):
                head = self.objects.head(key)
                return (
                    {"status": "not-found", "actionId": action["id"]}
                    if head is None
                    else {
                        "status": "conflict",
                        "actionId": action["id"],
                        "reason": "object-changed",
                    }
                )
            renewed = leases.renewObjectLease(
                leaseId=lease["leaseId"],
                ownerId=lease["ownerId"],
                objectKey=lease["objectKey"],
                mode=lease["mode"],
                generation=lease["generation"],
                ttlMs=self.lease_ttl_ms,
                now=self.now(),
            )
            if renewed.get("status") != "acquired":
                return {
                    "status": "conflict",
                    "actionId": action["id"],
                    "reason": "lease-unavailable",
                }
            lease = cast(Any, renewed)["lease"]
            if any(record.get("objectKey") == key for record in self._all_records()):
                return {
                    "status": "conflict",
                    "actionId": action["id"],
                    "reason": "reference-created",
                }
            if not self._matches_object_precondition(key, precondition):
                head = self.objects.head(key)
                return (
                    {"status": "not-found", "actionId": action["id"]}
                    if head is None
                    else {
                        "status": "conflict",
                        "actionId": action["id"],
                        "reason": "object-changed",
                    }
                )
            renewed = leases.renewObjectLease(
                leaseId=lease["leaseId"],
                ownerId=lease["ownerId"],
                objectKey=lease["objectKey"],
                mode=lease["mode"],
                generation=lease["generation"],
                ttlMs=self.lease_ttl_ms,
                now=self.now(),
            )
            if renewed.get("status") != "acquired":
                return {
                    "status": "conflict",
                    "actionId": action["id"],
                    "reason": "lease-unavailable",
                }
            lease = cast(Any, renewed)["lease"]
            self.objects.delete(key)
            return {"status": "applied", "actionId": action["id"]}
        finally:
            with suppress(Exception):
                leases.releaseObjectLease(lease)

    def _matches_object_precondition(self, key: str, precondition: dict[str, Any]) -> bool:
        head = self.objects.head(key)
        actual = self._object_digest(key)
        if (
            head is None
            or actual is None
            or actual["sizeBytes"] != precondition.get("observedSizeBytes")
        ):
            return False
        if (
            precondition.get("observedDigest") is not None
            and actual["digest"]["value"] != precondition["observedDigest"]
        ):
            return False
        etag = cast(dict[str, Any], head).get("etag")
        return precondition.get("observedEtag") is None or etag == precondition["observedEtag"]

    def _delete_missing_record(
        self, action: dict[str, Any], precondition: dict[str, Any]
    ) -> dict[str, Any]:
        record = self.repository.get(precondition["artifactId"])
        if record is None:
            return {"status": "not-found", "actionId": action["id"]}
        object_key = record["objectKey"]
        if (
            metadataFingerprint(record) != precondition["recordFingerprint"]
            or self.objects.head(object_key) is not None
        ):
            return {"status": "conflict", "actionId": action["id"], "reason": "state-changed"}
        self.repository.delete(record["id"])
        return {"status": "applied", "actionId": action["id"]}

    def _reverify(self, action: dict[str, Any], precondition: dict[str, Any]) -> dict[str, Any]:
        record = self.repository.get(precondition["artifactId"])
        if record is None:
            return {"status": "not-found", "actionId": action["id"]}
        if metadataFingerprint(record) != precondition["descriptorFingerprint"]:
            return {"status": "conflict", "actionId": action["id"], "reason": "state-changed"}
        actual = self._object_digest(record["objectKey"])
        if (
            actual is None
            or actual["sizeBytes"] != record["sizeBytes"]
            or actual["digest"]["value"] != record["digest"]["value"]
        ):
            return {"status": "conflict", "actionId": action["id"], "reason": "object-changed"}
        return {"status": "applied", "actionId": action["id"]}

    def _find_edge(self, edge_id: str) -> dict[str, Any] | None:
        for record in self._all_records():
            for edge in self.repository.getSources(record["id"]):
                if edge["id"] == edge_id:
                    return cast(dict[str, Any], edge)
            for edge in self.repository.getDerivatives(record["id"]):
                if edge["id"] == edge_id:
                    return cast(dict[str, Any], edge)
        return None

    def _edge_cycle(self, edge: dict[str, Any]) -> bool:
        seen: set[str] = set()

        def walk(artifact_id: str) -> bool:
            if artifact_id == edge["sourceArtifactId"]:
                return True
            if artifact_id in seen:
                return False
            seen.add(artifact_id)
            for candidate in self.repository.getDerivatives(artifact_id):
                if candidate["id"] != edge["id"] and walk(candidate["resultArtifactId"]):
                    return True
            return False

        return walk(edge["resultArtifactId"])

    def _remove_edge(self, action: dict[str, Any], precondition: dict[str, Any]) -> dict[str, Any]:
        edge = self._find_edge(precondition["edgeId"])
        if edge is None:
            return {"status": "not-found", "actionId": action["id"]}
        if metadataFingerprint(edge) != precondition["edgeFingerprint"] or not callable(
            getattr(self.repository, "removeLineage", None)
        ):
            return {"status": "conflict", "actionId": action["id"], "reason": "state-changed"}
        source = self.repository.get(edge["sourceArtifactId"])
        result = self.repository.get(edge["resultArtifactId"])
        expected = precondition["expectedReason"]
        invalid = (
            (expected == "missing-source" and source is None)
            or (expected == "missing-result" and result is None)
            or (expected == "cycle" and self._edge_cycle(edge))
        )
        if not invalid:
            return {"status": "conflict", "actionId": action["id"], "reason": "state-changed"}
        cast(Any, self.repository).removeLineage(edge["id"])
        return {"status": "applied", "actionId": action["id"]}


def auditArtifacts(
    objects: ObjectStore, repository: ArtifactRepository, **options: Any
) -> dict[str, Any]:
    return ArtifactMaintenance(objects, repository, **options).audit()


__all__ = ["ArtifactMaintenance", "auditArtifacts"]
