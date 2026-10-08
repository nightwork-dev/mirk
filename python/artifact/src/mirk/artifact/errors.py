"""Errors raised by the Mirk artifact ports."""

from __future__ import annotations

from typing import Literal

__all__ = [
    "ArtifactConflictError",
    "ArtifactLimitError",
    "ArtifactOperationError",
    "ArtifactValidationError",
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
