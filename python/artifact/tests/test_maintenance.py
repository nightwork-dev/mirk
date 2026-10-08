from __future__ import annotations

from typing import Any, cast

import pytest
from mirk.store.memory import InMemoryStore

from mirk.artifact.coordinator import ArtifactCoordinator
from mirk.artifact.maintenance import ArtifactMaintenance
from mirk.artifact.memory import InMemoryArtifactRepository, InMemoryObjectStore
from mirk.artifact.store import StoreArtifactRepository


def _repository(kind: str):
    if kind == "store":
        return StoreArtifactRepository(
            InMemoryStore(), now=lambda: 1000, lease_id_factory=lambda: "lease-1"
        )
    return InMemoryArtifactRepository(now=lambda: 1000, lease_id_factory=lambda: "lease-1")


@pytest.mark.parametrize("kind", ["memory", "store"])
def test_orphan_audit_plan_and_apply_are_opaque_and_conditional(kind: str) -> None:
    objects = InMemoryObjectStore()
    repository = _repository(kind)
    objects.put("orphan", b"orphan")
    maintenance = ArtifactMaintenance(
        objects, repository, now=lambda: 1000, audit_id_factory=lambda: "audit-1"
    )

    report = maintenance.audit()
    assert report["coverage"] == "complete"
    finding = report["findings"][0]
    assert finding["code"] == "object-without-record"
    assert "objectKey" not in finding
    plan = maintenance.planRepair(report, createdAt=1001)
    assert plan["createdAt"] == 1001
    assert "objectKey" not in plan["actions"][0]["precondition"]
    result = maintenance.applyRepair(plan)[0]
    assert result["status"] == "applied"
    assert objects.head("orphan") is None


def test_repair_requires_exclusive_lease_and_recovers_after_expiry() -> None:
    now = [100.0]
    objects = InMemoryObjectStore()
    repository = InMemoryArtifactRepository(now=lambda: now[0], lease_id_factory=lambda: "lease-1")
    objects.put("orphan", b"orphan")
    maintenance = ArtifactMaintenance(
        objects, repository, now=lambda: now[0], audit_id_factory=lambda: "audit"
    )
    plan = maintenance.planRepair(maintenance.audit())

    held = repository.acquireObjectLease(
        objectKey="orphan", ownerId="writer", mode="shared-writer", ttlMs=50, now=now[0]
    )
    assert held["status"] == "acquired"
    assert maintenance.applyRepair(plan)[0] == {
        "status": "conflict",
        "actionId": plan["actions"][0]["id"],
        "reason": "lease-unavailable",
    }
    now[0] = 200
    assert maintenance.applyRepair(plan)[0]["status"] == "applied"
    assert objects.head("orphan") is None


def test_repair_renews_after_final_reference_scan() -> None:
    clock = [1000.0]

    class ExpiringRepository(InMemoryArtifactRepository):
        scans = 0

        def list(self, query: Any = None) -> Any:
            page = super().list(query)
            self.scans += 1
            if self.scans == 3:
                clock[0] = 2000
                importer = ArtifactCoordinator(
                    objects,
                    self,
                    id_factory=lambda: "imported",
                    now=lambda: clock[0],
                    owner_id="importer",
                    lease_ttl_ms=10,
                )
                importer.importArtifact({"objectKey": "orphan", "mediaType": "text/plain"})
            return page

    objects = InMemoryObjectStore()
    repository = ExpiringRepository(now=lambda: clock[0], lease_id_factory=lambda: "lease")
    objects.put("orphan", b"orphan")
    maintenance = ArtifactMaintenance(
        objects, repository, now=lambda: clock[0], lease_ttl_ms=10, audit_id_factory=lambda: "audit"
    )
    report = maintenance.audit()
    repository.scans = 0
    plan = maintenance.planRepair(report)
    result = maintenance.applyRepair(plan)[0]
    assert result["status"] == "conflict"
    assert result["reason"] == "lease-unavailable"
    assert repository.get("imported") is not None
    assert objects.head("orphan") is not None


def test_reference_created_after_audit_blocks_orphan_delete() -> None:
    objects = InMemoryObjectStore()
    repository = InMemoryArtifactRepository(now=lambda: 1000)
    objects.put("orphan", b"orphan")
    maintenance = ArtifactMaintenance(
        cast(Any, objects), repository, now=lambda: 1000, audit_id_factory=lambda: "audit"
    )
    plan = maintenance.planRepair(maintenance.audit())
    digest, size = __import__("mirk.artifact.util", fromlist=["digestStream"]).digestStream(
        b"orphan"
    )
    record: Any = {
        "id": "created",
        "objectKey": "orphan",
        "mediaType": "text/plain",
        "sizeBytes": size,
        "digest": digest,
        "createdAt": 1000,
    }
    repository.create(record)
    result = maintenance.applyRepair(plan)[0]
    assert result["status"] == "conflict"
    assert result["reason"] == "reference-created"
    assert objects.head("orphan") is not None


def test_corrupt_bytes_are_reported_and_reverify_does_not_accept_them() -> None:
    objects = InMemoryObjectStore()
    repository = InMemoryArtifactRepository(now=lambda: 1000)
    coordinator = ArtifactCoordinator(
        objects, repository, id_factory=lambda: "record", now=lambda: 1000
    )
    record = coordinator.write({"bytes": b"good", "mediaType": "text/plain"})
    objects.put("artifacts/record", b"corrupt")
    maintenance = ArtifactMaintenance(
        objects, repository, now=lambda: 1000, audit_id_factory=lambda: "audit"
    )
    report = maintenance.audit()
    assert {finding["code"] for finding in report["findings"]} == {
        "digest-mismatch",
        "size-mismatch",
    }
    plan = maintenance.planRepair(report)
    results = maintenance.applyRepair(plan)
    assert all(
        result["status"] == "conflict" and result["reason"] == "object-changed"
        for result in results
    )
    assert repository.get(record["id"]) is not None


def test_partial_audit_without_list_capability_cannot_delete_objects() -> None:
    base = InMemoryObjectStore()
    objects = type(
        "NonListable",
        (),
        {"put": base.put, "get": base.get, "head": base.head, "delete": base.delete},
    )()
    repository = InMemoryArtifactRepository(now=lambda: 1000)
    maintenance = ArtifactMaintenance(
        cast(Any, objects), repository, now=lambda: 1000, audit_id_factory=lambda: "audit"
    )
    report = maintenance.audit()
    assert report["coverage"] == "partial"
    assert "scannedObjects" not in report
    assert maintenance.planRepair(report)["actions"] == []
