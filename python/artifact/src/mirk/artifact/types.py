"""Wire-shaped types for the artifact ports.

The dictionaries intentionally retain the TypeScript camelCase field and
method vocabulary.  This keeps records written by either implementation
portable without a translation layer.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any, Literal, NotRequired, Protocol, Required, TypedDict

type JsonPrimitive = str | int | float | bool | None
type JsonValue = JsonPrimitive | list[Any] | dict[str, Any]
type ByteChunk = bytes | bytearray | memoryview[Any]
type ByteSource = ByteChunk | Iterable[ByteChunk]
type ByteStream = Iterable[bytes]


class ArtifactDigest(TypedDict):
    algorithm: Literal["sha256"]
    value: str


class ArtifactProducer(TypedDict):
    system: str
    operation: NotRequired[str]
    jobId: NotRequired[str]
    attemptId: NotRequired[str]
    outputSlot: NotRequired[str]
    evidenceRef: NotRequired[str]


class ArtifactDescriptor(TypedDict):
    id: str
    mediaType: str
    sizeBytes: int
    digest: ArtifactDigest
    createdAt: float
    kind: NotRequired[str]
    filename: NotRequired[str]
    producer: NotRequired[ArtifactProducer]
    annotations: NotRequired[dict[str, JsonValue]]


class StoredArtifactRecord(ArtifactDescriptor):
    objectKey: str
    idempotencyKey: NotRequired[str]
    idempotencyFingerprint: NotRequired[str]
    idempotencyFinalizationDigest: NotRequired[str]


class ArtifactLineageEdge(TypedDict):
    id: str
    sourceArtifactId: str
    resultArtifactId: str
    operation: str
    createdAt: float
    parameters: NotRequired[dict[str, JsonValue]]
    producer: NotRequired[ArtifactProducer]


class ObjectInfo(TypedDict):
    key: str
    sizeBytes: int
    mediaType: NotRequired[str]
    digest: NotRequired[ArtifactDigest]
    etag: NotRequired[str]
    lastModifiedAt: NotRequired[float]
    metadata: NotRequired[dict[str, str]]


class ObjectPutOptions(TypedDict, total=False):
    mediaType: str
    metadata: dict[str, str]
    ifAbsent: bool


class ArtifactQuery(TypedDict, total=False):
    mediaType: str
    mediaTypePrefix: str
    kind: str
    producerSystem: str
    producerJobId: str
    producerAttemptId: str
    producerOutputSlot: str
    createdAfter: float
    createdBefore: float
    limit: int
    cursor: str


class StoredArtifactPage(TypedDict):
    items: list[StoredArtifactRecord]
    nextCursor: NotRequired[str]


class ArtifactSourceInput(TypedDict, total=False):
    artifactId: Required[str]
    operation: Required[str]
    parameters: dict[str, JsonValue]
    producer: ArtifactProducer


class WriteArtifactInput(TypedDict, total=False):
    bytes: Required[ByteSource]
    mediaType: Required[str]
    kind: str
    filename: str
    producer: ArtifactProducer
    annotations: dict[str, JsonValue]
    sources: list[ArtifactSourceInput]
    idempotencyKey: str


class ImportArtifactInput(TypedDict, total=False):
    objectKey: Required[str]
    mediaType: Required[str]
    kind: str
    filename: str
    producer: ArtifactProducer
    annotations: dict[str, JsonValue]
    sources: list[ArtifactSourceInput]
    idempotencyKey: str


class ArtifactReadResult(TypedDict):
    artifact: ArtifactDescriptor
    bytes: ByteStream


class ArtifactVerification(TypedDict, total=False):
    artifact: Required[ArtifactDescriptor]
    ok: Required[bool]
    actualDigest: ArtifactDigest
    actualSizeBytes: int
    reason: Literal["object-missing", "digest-mismatch", "size-mismatch"]


class ArtifactAuditFinding(TypedDict, total=False):
    code: Required[str]
    artifactId: str
    maintenanceRef: str
    detail: str


class ArtifactAuditReport(TypedDict):
    auditId: str
    scannedRecords: int
    findings: list[ArtifactAuditFinding]
    scannedObjects: NotRequired[int]
    coverage: NotRequired[Literal["complete", "partial"]]


class ArtifactRepairAction(TypedDict):
    id: str
    operation: str
    precondition: dict[str, Any]


class ArtifactRepairPlan(TypedDict):
    schema: str
    auditId: str
    createdAt: float
    actions: list[ArtifactRepairAction]


class ArtifactRepairResult(TypedDict):
    status: Literal["applied", "not-found", "conflict"]
    actionId: str
    reason: NotRequired[str]


type ArtifactLeaseMode = Literal["shared-writer", "exclusive-delete"]


class ArtifactObjectLease(TypedDict):
    leaseId: str
    ownerId: str
    objectKey: str
    mode: ArtifactLeaseMode
    generation: int
    heartbeatAt: float
    expiresAt: float


class ArtifactAtomicCreated(TypedDict):
    status: Literal["created"]
    requestDigest: str
    record: StoredArtifactRecord


class ArtifactAtomicReplayed(TypedDict):
    status: Literal["replayed"]
    requestDigest: str
    record: StoredArtifactRecord


class ArtifactAtomicConflict(TypedDict):
    status: Literal["conflict"]
    expectedRequestDigest: str
    receivedRequestDigest: str


type ArtifactAtomicCreateResult = (
    ArtifactAtomicCreated | ArtifactAtomicReplayed | ArtifactAtomicConflict
)


class ArtifactLeaseAcquired(TypedDict):
    status: Literal["acquired"]
    lease: ArtifactObjectLease


class ArtifactLeaseUnavailable(TypedDict):
    status: Literal["conflict", "unavailable"]
    reason: Literal["exclusive-held", "shared-held", "reference-created", "expired"]


type ArtifactLeaseResult = ArtifactLeaseAcquired | ArtifactLeaseUnavailable


class ArtifactLeaseCreated(TypedDict):
    status: Literal["created"]


class ArtifactLeaseLost(TypedDict):
    status: Literal["lease-lost"]


class ArtifactLeaseConflict(TypedDict):
    status: Literal["conflict"]


type ArtifactLeaseCreateResult = ArtifactLeaseCreated | ArtifactLeaseLost | ArtifactLeaseConflict


type ArtifactLeaseAtomicCreateResult = ArtifactAtomicCreateResult | ArtifactLeaseLost


class ObjectStore(Protocol):
    def put(
        self, key: str, source: ByteSource, options: ObjectPutOptions | None = None
    ) -> ObjectInfo: ...
    def get(self, key: str) -> ByteStream | None: ...
    def head(self, key: str) -> ObjectInfo | None: ...
    def delete(self, key: str) -> bool: ...


class ListableObjectStore(ObjectStore, Protocol):
    def list(self, prefix: str = "") -> list[ObjectInfo]: ...


class ArtifactRepository(Protocol):
    def create(self, record: StoredArtifactRecord) -> None: ...
    def get(self, id: str) -> StoredArtifactRecord | None: ...
    def getByDigest(self, digest: ArtifactDigest) -> list[StoredArtifactRecord]: ...
    def getByIdempotencyKey(self, key: str) -> StoredArtifactRecord | None: ...
    def list(self, query: ArtifactQuery | None = None) -> StoredArtifactPage: ...
    def updateAnnotations(self, id: str, patch: Mapping[str, Any]) -> StoredArtifactRecord: ...
    def delete(self, id: str) -> bool: ...
    def addLineage(self, edge: ArtifactLineageEdge) -> None: ...
    def getSources(self, id: str) -> list[ArtifactLineageEdge]: ...
    def getDerivatives(self, id: str) -> list[ArtifactLineageEdge]: ...


class AtomicArtifactRepository(ArtifactRepository, Protocol):
    atomicAvailable: bool

    def createIdempotent(
        self, input: Mapping[str, Any] | None = None, **kwargs: Any
    ) -> ArtifactAtomicCreateResult: ...


class ArtifactLeaseRepository(ArtifactRepository, Protocol):
    def acquireObjectLease(
        self, input: Mapping[str, Any] | None = None, **kwargs: Any
    ) -> ArtifactLeaseResult: ...

    def renewObjectLease(
        self, input: Mapping[str, Any] | None = None, **kwargs: Any
    ) -> ArtifactLeaseResult: ...

    def releaseObjectLease(self, lease: ArtifactObjectLease) -> bool: ...

    def createWithLease(
        self, input: Mapping[str, Any] | None = None, **kwargs: Any
    ) -> ArtifactLeaseCreateResult: ...

    def createIdempotentWithLease(
        self, input: Mapping[str, Any] | None = None, **kwargs: Any
    ) -> ArtifactLeaseAtomicCreateResult: ...


class AtomicLeaseArtifactRepository(AtomicArtifactRepository, ArtifactLeaseRepository, Protocol):
    pass
