"""OpenDAL adapter errors with stable capability codes."""

from __future__ import annotations

from typing import Literal

OpenDalObjectStoreErrorCode = Literal[
    "missing-required-capability",
    "unsupported-if-absent",
    "unsupported-content-type",
    "unsupported-user-metadata",
    "unsupported-recursive-list",
    "invalid-backend-key",
]


class OpenDalObjectStoreError(RuntimeError):
    def __init__(self, code: OpenDalObjectStoreErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
