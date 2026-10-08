"""Artifact finalization and object/repository coordination.

The Python port intentionally keeps the wire shape of ``@mirk/artifact``:
records and descriptors are ordinary dictionaries with camel-case keys.  The
local store ports are synchronous, so the coordinator is synchronous too.
"""

from __future__ import annotations

import sys
import time
import urllib.parse
import uuid
from collections.abc import Callable, Iterator, Mapping
from contextlib import suppress
from typing import Any, cast

from .errors import ArtifactConflictError, ArtifactOperationError, ArtifactValidationError
from .memory import ObjectAlreadyExistsError
from .types import (
    ArtifactDigest,
    ArtifactLeaseRepository,
    ArtifactLineageEdge,
    ArtifactObjectLease,
    ArtifactQuery,
    ArtifactRepository,
    AtomicArtifactRepository,
    ObjectStore,
    StoredArtifactRecord,
)
from .util import (
    artifactFinalizationDigest,
    assertPortableMetadata,
    cloneJson,
    descriptor,
    digestStream,
    hashingStream,
    makeId,
    metadataFingerprint,
)


class ArtifactWriteError(RuntimeError):
    """A write failed, with an explicit statement about owned-byte cleanup."""

    def __init__(self, message: str, cleanup: str, cause: BaseException | None = None) -> None:
        super().__init__(message)
        self.cleanup = cleanup
        self.__cause__ = cause


def _is_process_level(cause: BaseException | None) -> bool:
    """Keep exceptions outside the ordinary ``Exception`` hierarchy intact."""

    return cause is not None and not isinstance(cause, Exception)


class ArtifactCoordinator:
    """Finalize artifact bytes into an object store and metadata repository."""

    def __init__(
        self,
        objects: ObjectStore,
        repository: ArtifactRepository,
        *,
        namespace: str = "artifacts",
        id_factory: Callable[[], str] | None = None,
        now: Callable[[], int | float] | None = None,
        owner_id: str | None = None,
        concurrency: dict[str, str] | str | None = None,
        lease_ttl_ms: int = 30_000,
    ) -> None:
        self.objects: ObjectStore = objects
        self.repository: ArtifactRepository = repository
        self.namespace = namespace
        self.id_factory = id_factory or makeId
        self.now = now or (lambda: time.time() * 1000)
        self.owner_id = owner_id or f"artifact-coordinator-{uuid.uuid4().hex}"
        self.concurrency = concurrency or {"mode": "single-writer"}
        self.lease_ttl_ms = max(1, int(lease_ttl_ms))
        mode = (
            self.concurrency if isinstance(self.concurrency, str) else self.concurrency.get("mode")
        )
        if mode == "repository-atomic" and not self.is_atomic_repository():
            raise ArtifactValidationError(
                "invalid-concurrency-config",
                "repository-atomic concurrency requires AtomicArtifactRepository",
            )

    def is_atomic_repository(self) -> bool:
        return (
            callable(getattr(self.repository, "createIdempotent", None))
            and getattr(self.repository, "atomicAvailable", True) is not False
        )

    def is_lease_repository(self) -> bool:
        candidate = self.repository
        return (
            callable(getattr(candidate, "acquireObjectLease", None))
            and callable(getattr(candidate, "releaseObjectLease", None))
            and getattr(candidate, "atomicAvailable", True) is not False
        )

    def write(self, input: Mapping[str, Any]) -> dict[str, Any]:
        self._validate(input)
        fingerprint = self._fingerprint(input)
        repository_key = self._repository_idempotency_key(input.get("idempotencyKey"))
        prior = self._prior(repository_key, fingerprint)
        if prior is not None:
            digest, size = digestStream(input["bytes"])
            self._assert_replay(prior, input, digest, size, fingerprint)
            return cast(dict[str, Any], descriptor(cast(StoredArtifactRecord, prior)))

        artifact_id = str(self.id_factory())
        object_key = f"{self.namespace}/{artifact_id}"
        lease = self._acquire_lease(object_key, repository_key is not None)
        completed = False
        try:
            digest: ArtifactDigest | None = None
            size: int | None = None
            source = input["bytes"]
            preexisting: Any = None

            def tracked() -> Iterator[bytes]:
                nonlocal digest, size

                def complete(next_digest: ArtifactDigest, next_size: int) -> None:
                    nonlocal digest, size
                    digest = next_digest
                    size = next_size

                yield from hashingStream(source, complete)

            preexisting = self.objects.head(object_key)
            try:
                info = self.objects.put(
                    object_key,
                    tracked(),
                    {"mediaType": input["mediaType"], "ifAbsent": True},
                )
            except BaseException as cause:
                if _is_process_level(cause):
                    raise
                if preexisting is not None or isinstance(cause, ObjectAlreadyExistsError):
                    cleanup = "not-needed"
                else:
                    cleanup = "succeeded" if self._cleanup_object(object_key) else "failed"
                raise ArtifactWriteError("artifact object write failed", cleanup, cause) from cause
            if digest is None or size is None:
                cleaned = self._cleanup_object(object_key)
                raise ArtifactWriteError(
                    "object store did not consume the complete byte source",
                    "succeeded" if cleaned else "failed",
                )
            reported_size = (
                info.get("sizeBytes")
                if isinstance(info, dict)
                else getattr(info, "sizeBytes", None)
            )
            if reported_size != size:
                cleaned = self._cleanup_object(object_key)
                raise ArtifactWriteError(
                    f"object store reported {reported_size} bytes after {size} were streamed",
                    "succeeded" if cleaned else "failed",
                )
            record = cast(
                StoredArtifactRecord,
                {
                    "id": artifact_id,
                    "objectKey": object_key,
                    "createdAt": self.now(),
                    "digest": digest,
                    "sizeBytes": size,
                    "idempotencyFingerprint": fingerprint,
                    **self._portable_fields(input, repository_key),
                },
            )
            if repository_key is not None:
                record["idempotencyFinalizationDigest"] = self._finalization(record)
            result = self._commit(record, input.get("sources"), True, lease, repository_key)
            completed = True
            return result
        finally:
            released = self._release_lease_preserving_interrupt(lease)
            if completed and not released:
                raise ArtifactWriteError("artifact object lease release failed", "failed")

    def importArtifact(self, input: Mapping[str, Any]) -> dict[str, Any]:
        self._validate(input)
        fingerprint = self._fingerprint(input)
        repository_key = self._repository_idempotency_key(input.get("idempotencyKey"))
        prior = self._prior(repository_key, fingerprint)
        object_key = input["objectKey"]
        if prior is not None:
            stream = self.objects.get(object_key)
            if stream is None:
                raise ArtifactOperationError("object-not-found", f"object not found: {object_key}")
            digest, size = digestStream(stream)
            self._assert_replay(prior, input, digest, size, fingerprint)
            return cast(dict[str, Any], descriptor(cast(StoredArtifactRecord, prior)))
        lease = self._acquire_lease(object_key, repository_key is not None)
        completed = False
        try:
            stream = self.objects.get(object_key)
            if stream is None:
                raise ArtifactOperationError("object-not-found", f"object not found: {object_key}")
            digest, size = digestStream(stream)
            record = cast(
                StoredArtifactRecord,
                {
                    "id": str(self.id_factory()),
                    "objectKey": object_key,
                    "createdAt": self.now(),
                    "digest": digest,
                    "sizeBytes": size,
                    "idempotencyFingerprint": fingerprint,
                    **self._portable_fields(input, repository_key),
                },
            )
            if repository_key is not None:
                record["idempotencyFinalizationDigest"] = self._finalization(record)
            result = self._commit(record, input.get("sources"), False, lease, repository_key)
            completed = True
            return result
        finally:
            released = self._release_lease_preserving_interrupt(lease)
            if completed and not released:
                raise ArtifactWriteError("artifact object lease release failed", "failed")

    # A readable alias for callers that avoid camel case in Python code.
    import_artifact = importArtifact

    def read(self, artifact_id: str) -> dict[str, Any] | None:
        record = self.repository.get(artifact_id)
        if record is None:
            return None
        stream = self.objects.get(record["objectKey"])
        if stream is None:
            raise ArtifactOperationError(
                "artifact-object-missing", f"artifact object missing: {artifact_id}"
            )
        return {"artifact": descriptor(record), "bytes": stream}

    def verify(self, artifact_id: str) -> dict[str, Any]:
        record = self.repository.get(artifact_id)
        if record is None:
            raise ArtifactOperationError("artifact-not-found", f"artifact not found: {artifact_id}")
        stream = self.objects.get(record["objectKey"])
        if stream is None:
            return {"artifact": descriptor(record), "ok": False, "reason": "object-missing"}
        digest, size = digestStream(stream)
        result: dict[str, Any] = {
            "artifact": descriptor(record),
            "ok": size == record["sizeBytes"] and digest["value"] == record["digest"]["value"],
            "actualDigest": digest,
            "actualSizeBytes": size,
        }
        if size != record["sizeBytes"]:
            result["reason"] = "size-mismatch"
        elif digest["value"] != record["digest"]["value"]:
            result["reason"] = "digest-mismatch"
        return result

    def delete(self, artifact_id: str) -> bool:
        record = self.repository.get(artifact_id)
        if record is None:
            return False
        if not self.repository.delete(artifact_id):
            return False
        if self._has_object_reference(record["objectKey"]):
            return True
        object_key = record["objectKey"]
        lease: ArtifactObjectLease | None = None
        if self.is_lease_repository():
            acquired = cast(ArtifactLeaseRepository, self.repository).acquireObjectLease(
                objectKey=object_key,
                ownerId=self.owner_id,
                mode="exclusive-delete",
                ttlMs=self.lease_ttl_ms,
                now=self.now(),
            )
            if acquired.get("status") != "acquired":
                if acquired.get("reason") == "reference-created":
                    return True
                raise ArtifactOperationError(
                    "object-deletion-failed",
                    "artifact metadata deleted but object deletion lease unavailable: "
                    f"{artifact_id}",
                )
            lease = cast(ArtifactObjectLease, cast(Any, acquired)["lease"])
        try:
            if self._has_object_reference(object_key):
                return True
            renewed = (
                cast(ArtifactLeaseRepository, self.repository).renewObjectLease(
                    leaseId=lease["leaseId"],
                    ownerId=lease["ownerId"],
                    objectKey=lease["objectKey"],
                    mode=lease["mode"],
                    generation=lease["generation"],
                    ttlMs=self.lease_ttl_ms,
                    now=self.now(),
                )
                if lease is not None
                else {"status": "acquired"}
            )
            if renewed.get("status") != "acquired":
                raise ArtifactOperationError(
                    "object-deletion-failed",
                    f"artifact metadata deleted but object deletion lease lost: {artifact_id}",
                )
            if lease is not None:
                lease = cast(ArtifactObjectLease, cast(Any, renewed)["lease"])
            if not self.objects.delete(object_key):
                raise ArtifactOperationError(
                    "object-deletion-failed",
                    f"artifact metadata deleted but object deletion failed: {artifact_id}",
                )
            return True
        finally:
            if lease is not None:
                self._release_lease(lease)

    def _validate(self, input: Mapping[str, Any]) -> None:
        if not isinstance(input.get("mediaType"), str):
            raise ArtifactValidationError(
                "invalid-media-type", "mediaType must be a non-empty MIME type"
            )
        assertPortableMetadata(
            mediaType=input["mediaType"],
            annotations=input.get("annotations"),
            producer=input.get("producer"),
        )

    def _portable_fields(
        self, input: Mapping[str, Any], repository_key: str | None = None
    ) -> dict[str, Any]:
        fields: dict[str, Any] = {"mediaType": input["mediaType"]}
        for key in ("kind", "filename", "producer", "annotations"):
            if (
                key in input
                and input[key] is not None
                and (key not in ("kind", "filename") or input[key] != "")
            ):
                fields[key] = cloneJson(input[key])
        if repository_key is not None:
            fields["idempotencyKey"] = repository_key
        return fields

    def _fingerprint(self, input: Mapping[str, Any]) -> str:
        value = self._portable_fields(input)
        if input.get("sources") is not None:
            value["sources"] = cloneJson(input["sources"])
        return metadataFingerprint(value)

    def _finalization(self, record: Any) -> str:
        return artifactFinalizationDigest(cast(StoredArtifactRecord, record))

    def _repository_idempotency_key(self, key: str | None) -> str | None:
        return (
            None
            if key is None
            else f"{urllib.parse.quote(self.namespace, safe='')}:{urllib.parse.quote(key, safe='')}"
        )

    def _prior(self, key: str | None, fingerprint: str) -> dict[str, Any] | None:
        if key is None:
            return None
        prior = self.repository.getByIdempotencyKey(key)
        if prior is not None and prior.get("idempotencyFingerprint") != fingerprint:
            raise ArtifactConflictError(f"idempotency key reused with incompatible metadata: {key}")
        return cast(dict[str, Any], prior) if prior is not None else None

    def _assert_replay(
        self,
        prior: dict[str, Any],
        input: Mapping[str, Any],
        digest: ArtifactDigest,
        size: int,
        fingerprint: str,
    ) -> None:
        if prior.get("idempotencyFingerprint") != fingerprint:
            raise ArtifactConflictError(
                "idempotency key reused with incompatible metadata: "
                f"{prior.get('idempotencyKey', '')}"
            )
        incoming = dict(prior)
        incoming.update(self._portable_fields(input, prior.get("idempotencyKey")))
        incoming["digest"] = digest
        incoming["sizeBytes"] = size
        expected = prior.get("idempotencyFinalizationDigest") or self._finalization(prior)
        if self._finalization(incoming) != expected:
            raise ArtifactConflictError(
                f"idempotency key reused with incompatible bytes: {prior.get('idempotencyKey', '')}"
            )

    def _acquire_lease(self, object_key: str, idempotent: bool) -> ArtifactObjectLease | None:
        if not self.is_lease_repository():
            return None
        lease_repository = cast(ArtifactLeaseRepository, self.repository)
        if (
            idempotent and not callable(getattr(self.repository, "createIdempotentWithLease", None))
        ) or (not idempotent and not callable(getattr(self.repository, "createWithLease", None))):
            raise ArtifactWriteError(
                "artifact repository cannot commit while holding an object lease", "not-needed"
            )
        result = lease_repository.acquireObjectLease(
            objectKey=object_key,
            ownerId=self.owner_id,
            mode="shared-writer",
            ttlMs=self.lease_ttl_ms,
            now=self.now(),
        )
        if result.get("status") != "acquired":
            raise ArtifactWriteError(
                f"artifact object lease unavailable: {result.get('reason')}", "not-needed"
            )
        return cast(ArtifactObjectLease, cast(Any, result)["lease"])

    def _release_lease(self, lease: ArtifactObjectLease | None) -> bool:
        if lease is None or not self.is_lease_repository():
            return True
        try:
            return bool(cast(ArtifactLeaseRepository, self.repository).releaseObjectLease(lease))
        except Exception:
            return False

    def _release_lease_preserving_interrupt(self, lease: ArtifactObjectLease | None) -> bool:
        active = sys.exc_info()[1]
        try:
            return self._release_lease(lease)
        except BaseException:
            if isinstance(active, BaseException) and _is_process_level(active):
                raise active from None
            raise

    def _commit(
        self,
        record: Any,
        sources: list[dict[str, Any]] | None,
        cleanup_object: bool,
        lease: ArtifactObjectLease | None,
        repository_key: str | None,
    ) -> dict[str, Any]:
        created_record = False
        cleaned = False
        try:
            active_lease = lease
            if active_lease is not None and self.is_lease_repository():
                renewed = cast(ArtifactLeaseRepository, self.repository).renewObjectLease(
                    leaseId=active_lease["leaseId"],
                    ownerId=active_lease["ownerId"],
                    objectKey=active_lease["objectKey"],
                    mode=active_lease["mode"],
                    generation=active_lease["generation"],
                    ttlMs=self.lease_ttl_ms,
                    now=self.now(),
                )
                if renewed.get("status") != "acquired":
                    raise ArtifactOperationError(
                        "lease-lost", "artifact object lease was lost before repository commit"
                    )
                active_lease = cast(ArtifactObjectLease, cast(Any, renewed)["lease"])
            replayed = False
            if repository_key is not None and self.is_atomic_repository():
                if active_lease is not None and not callable(
                    getattr(self.repository, "createIdempotentWithLease", None)
                ):
                    raise ArtifactOperationError(
                        "lease-commit-unsupported",
                        "artifact repository cannot commit while holding an object lease",
                    )
                if active_lease is not None:
                    result = cast(
                        ArtifactLeaseRepository, self.repository
                    ).createIdempotentWithLease(
                        record=record,
                        idempotencyKey=repository_key,
                        lease=active_lease,
                        now=self.now(),
                    )
                else:
                    result = cast(AtomicArtifactRepository, self.repository).createIdempotent(
                        record=record, idempotencyKey=repository_key
                    )
                if result.get("status") == "lease-lost":
                    raise ArtifactOperationError(
                        "lease-lost", "artifact object lease was lost before repository commit"
                    )
                if result.get("status") == "conflict":
                    raise ArtifactConflictError(
                        f"idempotency key reused with incompatible metadata: {repository_key}"
                    )
                committed = cast(dict[str, Any], cast(Any, result)["record"])
                replayed = result.get("status") == "replayed"
                created_record = not replayed
                if replayed and committed.get("objectKey") != record.get("objectKey"):
                    cleaned = self._cleanup_object(record["objectKey"])
                    if not cleaned:
                        raise ArtifactWriteError("artifact replay cleanup failed", "failed")
            elif active_lease is not None and self.is_lease_repository():
                result = cast(ArtifactLeaseRepository, self.repository).createWithLease(
                    record=record, lease=active_lease, now=self.now()
                )
                if result.get("status") == "lease-lost":
                    raise ArtifactOperationError(
                        "lease-lost", "artifact object lease was lost before repository commit"
                    )
                if result.get("status") == "conflict":
                    raise ArtifactConflictError(f"artifact already exists: {record['id']}")
                committed = record
                created_record = True
            else:
                self.repository.create(cast(StoredArtifactRecord, record))
                committed = record
                created_record = True
            if not replayed:
                for source in sources or []:
                    edge: dict[str, Any] = {
                        "id": str(self.id_factory()),
                        "sourceArtifactId": source["artifactId"],
                        "resultArtifactId": committed["id"],
                        "operation": source["operation"],
                        "createdAt": committed["createdAt"],
                    }
                    for key in ("parameters", "producer"):
                        if key in source and source[key] is not None:
                            edge[key] = cloneJson(source[key])
                    self.repository.addLineage(cast(ArtifactLineageEdge, edge))
            return cast(dict[str, Any], descriptor(cast(StoredArtifactRecord, committed)))
        except BaseException as cause:
            if created_record:
                if _is_process_level(cause):
                    with suppress(BaseException):
                        self.repository.delete(record["id"])
                else:
                    with suppress(Exception):
                        self.repository.delete(record["id"])
            status = "not-needed"
            if cleanup_object:
                if _is_process_level(cause):
                    with suppress(BaseException):
                        cleaned = cleaned or self._cleanup_object(record["objectKey"])
                else:
                    cleaned = cleaned or self._cleanup_object(record["objectKey"])
                status = "succeeded" if cleaned else "failed"
            if _is_process_level(cause):
                raise
            if isinstance(cause, ArtifactConflictError) and repository_key and status != "failed":
                raise
            if isinstance(cause, ArtifactWriteError) and cause.cleanup == "failed":
                raise
            raise ArtifactWriteError("artifact metadata commit failed", status, cause) from cause

    def _cleanup_object(self, object_key: str) -> bool:
        try:
            if self.objects.delete(object_key):
                return True
            return self.objects.head(object_key) is None
        except Exception:
            return False

    def _has_object_reference(self, object_key: str) -> bool:
        cursor: str | None = None
        while True:
            query: dict[str, Any] = {"limit": 500}
            if cursor is not None:
                query["cursor"] = cursor
            page = self.repository.list(cast(ArtifactQuery, query))
            items = page.get("items", [])
            if any(item.get("objectKey") == object_key for item in items):
                return True
            cursor = page.get("nextCursor")
            if not cursor:
                return False


__all__ = ["ArtifactCoordinator", "ArtifactWriteError"]
