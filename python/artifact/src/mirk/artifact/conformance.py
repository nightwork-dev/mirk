"""Conformance target for the portable artifact lifecycle.

The target deliberately exposes setup helpers for object bytes while keeping
physical object keys out of coordinator-facing results.  Scenario inputs use
base64 strings because the JSON corpus has no byte type.
"""

from __future__ import annotations

import base64
from typing import Any, cast

from .coordinator import ArtifactCoordinator
from .maintenance import ArtifactMaintenance
from .memory import InMemoryArtifactRepository, InMemoryObjectStore
from .store import StoreArtifactRepository
from .types import (
    ArtifactDigest,
    ArtifactLineageEdge,
    ArtifactObjectLease,
    ArtifactQuery,
    ByteStream,
    StoredArtifactRecord,
)
from .util import UNDEFINED, artifactFinalizationDigest, metadataFingerprint

__all__ = ["conformance_target"]


def _decode(value: str) -> bytes:
    return base64.b64decode(value.encode("ascii"), validate=True)


def _encode(stream: ByteStream) -> str:
    return base64.b64encode(b"".join(bytes(part) for part in stream)).decode("ascii")


class _ArtifactTarget:
    def __init__(self, backend: str, connection: object) -> None:
        self.backend = backend
        self.connection = connection
        self.objects: InMemoryObjectStore
        self.repository: StoreArtifactRepository | InMemoryArtifactRepository
        self.coordinator: ArtifactCoordinator
        self.maintenance: ArtifactMaintenance
        self._now = 1000.0
        self._ids: list[str] = []
        self._next_id = 0
        self._next_lease = 0
        self._next_audit = 0
        self._audit_report: dict[str, Any] | None = None
        self._repair_plan: dict[str, Any] | None = None
        self.configure()

    def configure(self, spec: dict[str, Any] | None = None) -> None:
        spec = spec or {}
        self._ids = [str(value) for value in spec.get("ids", [])]
        self._now = float(spec.get("now", 1000))
        self._next_id = 0
        self._next_lease = 0
        self._next_audit = 0
        namespace = str(spec.get("namespace", "artifacts"))
        concurrency = spec.get("concurrency", {"mode": "repository-atomic"})

        def next_lease() -> str:
            self._next_lease += 1
            return f"lease-{self._next_lease}"

        if self.backend == "sqlite":
            self.repository = StoreArtifactRepository(self.connection, lease_id_factory=next_lease)
        else:
            self.repository = InMemoryArtifactRepository(lease_id_factory=next_lease)
        self.objects = InMemoryObjectStore()

        def next_id() -> str:
            index = self._next_id
            self._next_id += 1
            return self._ids[index] if index < len(self._ids) else f"artifact-{index + 1}"

        self.coordinator = ArtifactCoordinator(
            self.objects,
            self.repository,
            namespace=namespace,
            id_factory=next_id,
            now=lambda: self._now,
            owner_id="conformance-writer",
            concurrency=concurrency,
            lease_ttl_ms=30_000,
        )
        self.maintenance = ArtifactMaintenance(
            self.objects,
            self.repository,
            now=lambda: self._now,
            owner_id="conformance-maintenance",
            audit_id_factory=lambda: self._next_audit_id(),
        )

    def _next_audit_id(self) -> str:
        self._next_audit += 1
        return f"audit-{self._next_audit}"

    def write(self, input: dict[str, Any]) -> dict[str, Any]:
        value = dict(input)
        value["bytes"] = _decode(str(value["bytes"]))
        return self.coordinator.write(value)

    def importArtifact(self, input: dict[str, Any]) -> dict[str, Any]:
        return self.coordinator.importArtifact(dict(input))

    def read(self, artifact_id: str) -> dict[str, Any] | None:
        result = self.coordinator.read(artifact_id)
        if result is None:
            return None
        return {"artifact": result["artifact"], "bytes": _encode(result["bytes"])}

    def verify(self, artifact_id: str) -> dict[str, Any]:
        return self.coordinator.verify(artifact_id)

    def delete(self, artifact_id: str) -> bool:
        return self.coordinator.delete(artifact_id)

    def get(self, artifact_id: str) -> dict[str, Any] | None:
        return cast(dict[str, Any] | None, self.repository.get(artifact_id))

    def list(self, query: dict[str, Any] | None = None) -> dict[str, Any]:
        return cast(dict[str, Any], self.repository.list(cast(ArtifactQuery, query or {})))

    def updateAnnotations(self, artifact_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        return cast(dict[str, Any], self.repository.updateAnnotations(artifact_id, patch))

    def removeAnnotations(self, artifact_id: str, keys: list[str]) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            self.repository.updateAnnotations(
                artifact_id, {key: UNDEFINED for key in keys}
            ),
        )

    def getByDigest(self, digest: dict[str, Any]) -> list[dict[str, Any]]:
        return cast(
            list[dict[str, Any]], self.repository.getByDigest(cast(ArtifactDigest, digest))
        )

    def getByIdempotencyKey(self, key: str) -> dict[str, Any] | None:
        return cast(dict[str, Any] | None, self.repository.getByIdempotencyKey(key))

    def getSources(self, artifact_id: str) -> list[dict[str, Any]]:
        return cast(list[dict[str, Any]], self.repository.getSources(artifact_id))

    def getDerivatives(self, artifact_id: str) -> list[dict[str, Any]]:
        return cast(list[dict[str, Any]], self.repository.getDerivatives(artifact_id))

    def addLineage(self, edge: dict[str, Any]) -> None:
        self.repository.addLineage(cast(ArtifactLineageEdge, edge))

    def createRecord(self, record: dict[str, Any]) -> None:
        self.repository.create(cast(StoredArtifactRecord, record))

    def removeLineage(self, edge_id: str) -> bool:
        return self.repository.removeLineage(edge_id)

    def acquireObjectLease(self, input: dict[str, Any]) -> dict[str, Any]:
        values = dict(input)
        values.setdefault("now", self._now)
        return self.repository.acquireObjectLease(**values)

    def renewObjectLease(self, input: dict[str, Any]) -> dict[str, Any]:
        values = dict(input)
        values.setdefault("now", self._now)
        return self.repository.renewObjectLease(**values)

    def releaseObjectLease(self, lease: dict[str, Any]) -> bool:
        return self.repository.releaseObjectLease(cast(ArtifactObjectLease, lease))

    def createWithLease(self, input: dict[str, Any]) -> dict[str, Any]:
        values = dict(input)
        values.setdefault("now", self._now)
        return self.repository.createWithLease(**values)

    def createIdempotent(self, input: dict[str, Any]) -> dict[str, Any]:
        return self.repository.createIdempotent(**input)

    def createIdempotentWithLease(self, input: dict[str, Any]) -> dict[str, Any]:
        values = dict(input)
        values.setdefault("now", self._now)
        return self.repository.createIdempotentWithLease(**values)

    def putObject(self, key: str, value: str) -> None:
        self.objects.put(key, _decode(value))

    def deleteObject(self, key: str) -> bool:
        return self.objects.delete(key)

    def setTime(self, value: int | float) -> None:
        self._now = float(value)

    def audit(self) -> dict[str, Any]:
        self._audit_report = self.maintenance.audit()
        self._repair_plan = None
        return self._audit_report

    def planRepair(self) -> dict[str, Any]:
        if self._audit_report is None:
            raise RuntimeError("audit() must run before planRepair()")
        self._repair_plan = self.maintenance.planRepair(self._audit_report)
        return self._repair_plan

    def applyRepair(self) -> list[dict[str, Any]]:
        if self._repair_plan is None:
            raise RuntimeError("planRepair() must run before applyRepair()")
        return self.maintenance.applyRepair(self._repair_plan)

    def metadataFingerprint(self, value: Any) -> str:
        return metadataFingerprint(value)

    def finalizationDigest(self, record: dict[str, Any]) -> str:
        return artifactFinalizationDigest(cast(StoredArtifactRecord, record))


def conformance_target(backend: str, connection: object) -> _ArtifactTarget:
    """Build one artifact scenario target over the supplied Mirk store."""
    return _ArtifactTarget(backend, connection)
