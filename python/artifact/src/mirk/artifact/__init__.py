"""Portable artifact records, integrity, lineage, and finalization."""

from .coordinator import ArtifactCoordinator, ArtifactWriteError
from .errors import (
    ArtifactConflictError,
    ArtifactLimitError,
    ArtifactOperationError,
    ArtifactValidationError,
)
from .maintenance import ArtifactMaintenance, auditArtifacts
from .memory import InMemoryArtifactRepository, InMemoryObjectStore, ObjectAlreadyExistsError
from .types import (
    ArtifactAuditReport,
    ArtifactDescriptor,
    ArtifactDigest,
    ArtifactLineageEdge,
    ArtifactObjectLease,
    ArtifactProducer,
    ArtifactQuery,
    ArtifactReadResult,
    ArtifactRepairPlan,
    ArtifactRepository,
    ArtifactVerification,
    AtomicArtifactRepository,
    ByteSource,
    ByteStream,
    ImportArtifactInput,
    ListableObjectStore,
    ObjectInfo,
    ObjectPutOptions,
    ObjectStore,
    StoredArtifactPage,
    StoredArtifactRecord,
    WriteArtifactInput,
)
from .util import (
    UNDEFINED,
    artifactFinalizationDigest,
    assertBoundedJson,
    assertObjectKey,
    assertPortableMetadata,
    chunks,
    descriptor,
    digestStream,
    hashingStream,
)

__all__ = [
    "UNDEFINED",
    "ArtifactAuditReport",
    "ArtifactConflictError",
    "ArtifactCoordinator",
    "ArtifactDescriptor",
    "ArtifactDigest",
    "ArtifactLimitError",
    "ArtifactLineageEdge",
    "ArtifactMaintenance",
    "ArtifactObjectLease",
    "ArtifactOperationError",
    "ArtifactProducer",
    "ArtifactQuery",
    "ArtifactReadResult",
    "ArtifactRepairPlan",
    "ArtifactRepository",
    "ArtifactValidationError",
    "ArtifactVerification",
    "ArtifactWriteError",
    "AtomicArtifactRepository",
    "ByteSource",
    "ByteStream",
    "ImportArtifactInput",
    "InMemoryArtifactRepository",
    "InMemoryObjectStore",
    "ListableObjectStore",
    "ObjectAlreadyExistsError",
    "ObjectInfo",
    "ObjectPutOptions",
    "ObjectStore",
    "StoredArtifactPage",
    "StoredArtifactRecord",
    "WriteArtifactInput",
    "artifactFinalizationDigest",
    "assertBoundedJson",
    "assertObjectKey",
    "assertPortableMetadata",
    "auditArtifacts",
    "chunks",
    "conformance_target",
    "descriptor",
    "digestStream",
    "hashingStream",
]


def conformance_target(backend: str, connection: object) -> object:
    from .conformance import conformance_target as target

    return target(backend, connection)
