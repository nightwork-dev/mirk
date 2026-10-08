"""Synchronous OpenDAL binding for the Mirk artifact object-store port."""

from __future__ import annotations

import hashlib
from contextlib import suppress
from datetime import datetime
from typing import Any

from mirk.artifact.memory import ObjectAlreadyExistsError
from mirk.artifact.types import ByteSource, ListableObjectStore, ObjectInfo, ObjectPutOptions
from mirk.artifact.util import assertObjectKey, chunks
from opendal import Operator
from opendal.exceptions import (  # pyright: ignore[reportMissingModuleSource]
    AlreadyExists,
    ConditionNotMatch,
)
from opendal.types import Metadata  # pyright: ignore[reportMissingModuleSource]

from .errors import OpenDalObjectStoreError

__all__ = ["OpenDalObjectStore"]


class OpenDalObjectStore(ListableObjectStore):
    """Use an injected blocking ``opendal.Operator`` as a Mirk object store."""

    def __init__(self, operator: Operator, *, digest_metadata_key: str | None = None) -> None:
        self.operator = operator
        self.digest_metadata_key = digest_metadata_key
        capability = operator.capability()
        required = ("read", "write", "stat", "delete")
        if any(not getattr(capability, name, False) for name in required):
            raise OpenDalObjectStoreError(
                "missing-required-capability",
                "OpenDAL operator must support read, write, stat, and delete",
            )

    def put(
        self, key: str, source: ByteSource, options: ObjectPutOptions | None = None
    ) -> ObjectInfo:
        assertObjectKey(key)
        options = options or {}
        capability = self.operator.capability()
        if options.get("ifAbsent") and not capability.write_with_if_not_exists:
            raise OpenDalObjectStoreError(
                "unsupported-if-absent",
                "OpenDAL backend does not support atomic ifAbsent writes",
            )
        if options.get("mediaType") and not capability.write_with_content_type:
            raise OpenDalObjectStoreError(
                "unsupported-content-type",
                "OpenDAL backend does not support content type metadata",
            )
        if (
            options.get("metadata") or self.digest_metadata_key
        ) and not capability.write_with_user_metadata:
            raise OpenDalObjectStoreError(
                "unsupported-user-metadata",
                "OpenDAL backend does not support user metadata",
            )

        write_source: ByteSource = source
        digest_value: str | None = None
        if self.digest_metadata_key:
            buffered = b"".join(chunks(source))
            digest_value = hashlib.sha256(buffered).hexdigest()
            write_source = buffered

        try:
            writer = self.operator.open(
                key,
                "wb",
                **self._write_options(options, digest_value),
            )
        except (AlreadyExists, ConditionNotMatch) as exc:
            raise ObjectAlreadyExistsError(key) from exc
        try:
            for chunk in chunks(write_source):
                writer.write(chunk)
        except (AlreadyExists, ConditionNotMatch) as exc:
            with suppress(Exception):
                writer.close()
            raise ObjectAlreadyExistsError(key) from exc
        except BaseException as source_error:
            try:
                writer.close()
            except (AlreadyExists, ConditionNotMatch) as close_error:
                if not isinstance(source_error, Exception):
                    raise source_error from close_error
                if options.get("ifAbsent"):
                    raise ObjectAlreadyExistsError(key) from close_error
                raise
            except BaseException as close_error:
                # The close result is indeterminate. Preserve a conditional
                # object because its ownership cannot be proved.
                raise source_error from close_error
            self._delete_owned(key, preserve_interrupt=not isinstance(source_error, Exception))
            raise source_error
        try:
            writer.close()
        except (AlreadyExists, ConditionNotMatch) as exc:
            if not options.get("ifAbsent"):
                self._delete_owned(key)
            raise ObjectAlreadyExistsError(key) from exc
        except BaseException as close_error:
            if not options.get("ifAbsent"):
                self._delete_owned(key, preserve_interrupt=not isinstance(close_error, Exception))
            raise
        return _metadata_to_info(key, self.operator.stat(key), self.digest_metadata_key)

    def get(self, key: str):
        assertObjectKey(key)
        if not self.operator.exists(key):
            return None

        def stream():
            with self.operator.open(key, "rb") as reader:
                while True:
                    chunk = reader.read(1024 * 1024)
                    if not chunk:
                        return
                    yield bytes(chunk)

        return stream()

    def head(self, key: str) -> ObjectInfo | None:
        assertObjectKey(key)
        if not self.operator.exists(key):
            return None
        return _metadata_to_info(key, self.operator.stat(key), self.digest_metadata_key)

    def delete(self, key: str) -> bool:
        assertObjectKey(key)
        if not self.operator.exists(key):
            return False
        self.operator.delete(key)
        return True

    def list(self, prefix: str = "") -> list[ObjectInfo]:
        if prefix:
            assertObjectKey(prefix)
        capability = self.operator.capability()
        if not capability.list or not capability.list_with_recursive:
            raise OpenDalObjectStoreError(
                "unsupported-recursive-list",
                "OpenDAL backend does not support recursive object listing",
            )
        directory = prefix[: prefix.rfind("/") + 1]
        results: list[ObjectInfo] = []
        for entry in self.operator.list(directory, recursive=True):
            metadata = entry.metadata
            if not metadata.is_file:
                continue
            key = str(entry.path).lstrip("/")
            try:
                assertObjectKey(key)
            except Exception as exc:
                raise OpenDalObjectStoreError(
                    "invalid-backend-key",
                    "OpenDAL backend returned an invalid object key",
                ) from exc
            if key.startswith(prefix):
                results.append(_metadata_to_info(key, metadata, self.digest_metadata_key))
        return sorted(results, key=lambda info: str(info["key"]))

    def _write_options(self, options: ObjectPutOptions, digest_value: str | None) -> dict[str, Any]:
        metadata = dict(options.get("metadata") or {})
        if digest_value is not None and self.digest_metadata_key is not None:
            metadata[self.digest_metadata_key] = digest_value
        result: dict[str, Any] = {}
        if options.get("ifAbsent"):
            result["if_not_exists"] = True
        media_type = options.get("mediaType")
        if media_type:
            result["content_type"] = media_type
        if metadata:
            result["user_metadata"] = metadata
        return result

    def _delete_owned(self, key: str, *, preserve_interrupt: bool = False) -> None:
        cleanup_errors = BaseException if preserve_interrupt else Exception
        with suppress(cleanup_errors):
            self.operator.delete(key)


def _metadata_to_info(key: str, metadata: Metadata, digest_metadata_key: str | None) -> ObjectInfo:
    user_metadata = metadata.user_metadata
    digest_value = (
        user_metadata.get(digest_metadata_key) if user_metadata and digest_metadata_key else None
    )
    last_modified = metadata.last_modified
    last_modified_at: float | None = None
    if isinstance(last_modified, datetime):
        last_modified_at = last_modified.timestamp() * 1000
    elif last_modified is not None and hasattr(last_modified, "timestamp"):
        last_modified_at = float(last_modified.timestamp()) * 1000
    info: ObjectInfo = {
        "key": key,
        "sizeBytes": int(metadata.content_length),
    }
    content_type = metadata.content_type
    if content_type:
        info["mediaType"] = str(content_type)
    if digest_value:
        info["digest"] = {"algorithm": "sha256", "value": str(digest_value)}
    etag = metadata.etag
    if etag:
        info["etag"] = str(etag)
    if last_modified_at is not None:
        info["lastModifiedAt"] = last_modified_at
    if user_metadata:
        info["metadata"] = {str(k): str(v) for k, v in user_metadata.items()}
    return info
