"""Portable byte, metadata, and digest helpers for artifacts."""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable, Iterable, Iterator, Mapping
from typing import Any, cast

from mirk.store.canonical import canonical_digest, canonical_json

from .errors import ArtifactLimitError, ArtifactValidationError
from .types import (
    ArtifactDescriptor,
    ArtifactDigest,
    ByteSource,
    JsonValue,
    StoredArtifactRecord,
)

__all__ = [
    "UNDEFINED",
    "artifactFinalizationDigest",
    "assertBoundedJson",
    "assertObjectKey",
    "assertPortableMetadata",
    "chunks",
    "cloneJson",
    "descriptor",
    "digestStream",
    "hashingStream",
    "makeId",
    "metadataFingerprint",
]


class _Undefined:
    __slots__ = ()

    def __repr__(self) -> str:
        return "UNDEFINED"


# Python None is JSON null.  Callers must use this sentinel to delete an
# annotation key, matching JavaScript's undefined patch value.
UNDEFINED = _Undefined()


def _as_bytes(chunk: Any) -> bytes:
    if isinstance(chunk, bytes):
        return chunk
    if isinstance(chunk, (bytearray, memoryview)):
        return bytes(cast(Any, chunk))
    raise ArtifactValidationError(
        "invalid-byte-chunk", "artifact byte sources must yield byte chunks"
    )


def chunks(source: ByteSource) -> Iterator[bytes]:
    if isinstance(source, (bytes, bytearray, memoryview)):
        yield _as_bytes(source)
        return
    try:
        iterator = iter(source)
    except TypeError as exc:
        raise ArtifactValidationError(
            "invalid-byte-chunk", "artifact byte sources must yield byte chunks"
        ) from exc
    for chunk in iterator:
        yield _as_bytes(chunk)


def digestStream(source: ByteSource) -> tuple[ArtifactDigest, int]:
    digest = hashlib.sha256()
    size = 0
    for chunk in chunks(source):
        digest.update(chunk)
        size += len(chunk)
    return {"algorithm": "sha256", "value": digest.hexdigest()}, size


def hashingStream(
    source: ByteSource, complete: Callable[[ArtifactDigest, int], None]
) -> Iterator[bytes]:
    digest = hashlib.sha256()
    size = 0
    for chunk in chunks(source):
        digest.update(chunk)
        size += len(chunk)
        yield chunk
    complete({"algorithm": "sha256", "value": digest.hexdigest()}, size)


def assertObjectKey(key: str) -> None:
    if (
        not key
        or "\0" in key
        or key.startswith("/")
        or any(part in (".", "..") for part in key.split("/"))
    ):
        raise ArtifactValidationError("invalid-object-key", f"invalid object key: {key!r}")


def _walk_json(value: Any, depth: int, label: str, seen: set[int]) -> None:
    if depth > 20:
        raise ArtifactLimitError("metadata-too-deep", f"{label} exceeds maximum depth 20")
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not (value == value and abs(value) != float("inf")):
            raise ArtifactValidationError(
                "non-finite-metadata", f"{label} contains a non-finite number"
            )
        return
    if not isinstance(value, (list, dict)):
        raise ArtifactValidationError("non-json-metadata", f"{label} must be JSON-safe")
    container = cast(list[Any] | dict[str, Any], value)
    marker = id(container)
    if marker in seen:
        raise ArtifactValidationError("non-json-metadata", f"{label} must be JSON-safe")
    seen.add(marker)
    try:
        values: Iterable[Any] = container if isinstance(container, list) else container.values()
        for child in values:
            _walk_json(child, depth + 1, label, seen)
    finally:
        seen.remove(marker)


def assertBoundedJson(value: JsonValue, label: str) -> None:
    # Validate values before canonical serialization so non-finite numbers use
    # the artifact-specific error code instead of the store's canonical one.
    _walk_json(value, 0, label, set())
    try:
        serialized = canonical_json(value)
    except Exception as exc:
        if isinstance(exc, ArtifactValidationError):
            raise
        raise ArtifactValidationError("non-json-metadata", f"{label} must be JSON-safe") from exc
    if len(serialized.encode("utf-8")) > 64 * 1024:
        raise ArtifactLimitError("metadata-too-large", f"{label} exceeds 64 KiB")


def assertPortableMetadata(
    *,
    mediaType: str,
    annotations: Mapping[str, JsonValue] | None = None,
    producer: Mapping[str, Any] | None = None,
) -> None:
    if not mediaType.strip() or "/" not in mediaType:
        raise ArtifactValidationError(
            "invalid-media-type", "mediaType must be a non-empty MIME type"
        )
    if producer is not None:
        system = producer.get("system")
        if not isinstance(system, str) or not system.strip():
            raise ArtifactValidationError("invalid-producer", "producer.system must be non-empty")
    if annotations is not None:
        assertBoundedJson(dict(annotations), "annotations")


def cloneJson(value: Any) -> Any:
    try:
        return json.loads(canonical_json(value))
    except Exception as exc:
        raise ArtifactValidationError("non-json-metadata", "value must be JSON-safe") from exc


def descriptor(record: StoredArtifactRecord) -> ArtifactDescriptor:
    return cast(
        ArtifactDescriptor,
        {
            key: cloneJson(value)
            for key, value in record.items()
            if key
            not in {
                "objectKey",
                "idempotencyKey",
                "idempotencyFingerprint",
                "idempotencyFinalizationDigest",
            }
        },
    )


def metadataFingerprint(value: Any) -> str:
    return canonical_digest(value)


def artifactFinalizationDigest(record: StoredArtifactRecord) -> str:
    request: dict[str, Any] = {
        "schema": "mirk-artifact-finalization/v1",
        "mediaType": record["mediaType"],
        "sizeBytes": record["sizeBytes"],
        "digest": record["digest"],
    }
    for key in ("kind", "filename", "producer", "annotations"):
        if key in record:
            request[key] = record.get(key)
    return canonical_digest(request)


def makeId() -> str:
    return str(uuid.uuid4())
