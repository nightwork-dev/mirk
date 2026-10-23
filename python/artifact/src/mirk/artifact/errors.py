"""Errors raised by the Mirk artifact ports."""

from __future__ import annotations

from typing import Literal

__all__ = [
    "ArtifactConflictError",
    "ArtifactLimitError",
    "ArtifactOperationError",
    "ArtifactValidationError",
    "ObjectWriteIndeterminateError",
    "ObjectWriteRejectedError",
]

ArtifactValidationErrorCode = Literal[
    "invalid-object-key",
    "object-key-escapes-root",
    "invalid-byte-chunk",
    "invalid-media-type",
    "invalid-producer",
    "non-json-metadata",
    "non-finite-metadata",
    "invalid-concurrency-config",
]
ArtifactLimitErrorCode = Literal["metadata-too-large", "metadata-too-deep"]
ArtifactOperationErrorCode = Literal[
    "invalid-cursor",
    "missing-lineage-endpoint",
    "artifact-not-found",
    "object-not-found",
    "artifact-object-missing",
    "object-deletion-failed",
    "lease-lost",
    "lease-commit-unsupported",
    "atomic-mutation-unavailable",
    "object-key-occupied",
    "web-crypto-unavailable",
]


class ArtifactValidationError(TypeError):
    def __init__(self, code: ArtifactValidationErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


class ArtifactLimitError(ValueError):
    def __init__(self, code: ArtifactLimitErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


class ArtifactOperationError(Exception):
    def __init__(self, code: ArtifactOperationErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code


class ArtifactConflictError(Exception):
    """A record, receipt, or lineage edge conflicts with existing state."""


class ObjectWriteIndeterminateError(Exception):
    """A write failed after its bytes may have reached the store.

    The store cannot prove whether the object now at ``key`` is this writer's;
    a remote upload can succeed before its reply is lost.  The coordinator
    keeps the object instead of deleting bytes that may belong to another
    writer.  A retry under the same id adopts identical bytes, and
    ``ArtifactMaintenance`` finds any other leftover as
    ``object-without-record`` and removes it with ``delete-unreferenced-object``.
    """

    def __init__(self, key: str) -> None:
        super().__init__(
            "Object write outcome is indeterminate; the object is kept. A retry with the same "
            "bytes adopts it; ArtifactMaintenance removes it if nothing does."
        )
        self.key = key


class ObjectWriteRejectedError(Exception):
    """A write failed and the store knows it stored nothing at ``key``.

    The request was refused, the source failed or ran over a limit before
    anything was committed, or the store removed its own partial bytes.  The
    coordinator then leaves the key alone, because any object there now belongs
    to another writer.  The original error is the ``__cause__``.
    """

    def __init__(self, key: str) -> None:
        super().__init__("Object write stored nothing at this key.")
        self.key = key
