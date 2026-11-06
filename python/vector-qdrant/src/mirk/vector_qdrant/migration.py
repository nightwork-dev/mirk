"""Recoverable copy migration from the legacy unnamed collection format."""

from __future__ import annotations

import base64
import binascii
import json
from collections.abc import Callable
from typing import Any, NoReturn, cast

from mirk.store.vector import VectorDocument, bytes_to_vector
from qdrant_client import QdrantClient

from .errors import QdrantCollectionError
from .store import QdrantVectorStore
from .wire import point_uuid


def invalid_json_constant(value: str) -> NoReturn:
    raise ValueError(f"Invalid JSON constant {value}")


def legacy_json(payload: dict[str, Any], field: str) -> Any:
    value = payload.get(field)
    if not isinstance(value, str):
        raise QdrantCollectionError(f"Malformed legacy field {field}: expected JSON text")
    try:
        return json.loads(value, parse_constant=invalid_json_constant)
    except ValueError as error:
        raise QdrantCollectionError(f"Malformed legacy field {field}: invalid JSON") from error


def migrateLegacyQdrantVectors(
    client: QdrantClient,
    *,
    source_collection_name: str,
    collection_name: str,
    page_size: object = 256,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
) -> QdrantVectorStore:
    """Copy with one runner and both stores quiesced; preserve the source."""
    if source_collection_name == collection_name:
        raise QdrantCollectionError("Migration destination must be a new collection")
    if isinstance(page_size, bool) or not isinstance(page_size, int) or page_size <= 0:
        raise QdrantCollectionError("Migration page_size must be a positive integer")
    source = client.get_collection(source_collection_name)
    params = source.config.params.vectors
    if params is None or isinstance(params, dict) or params.distance != "Dot":
        raise QdrantCollectionError("Source must be a legacy float32 Dot collection")
    if params.datatype is not None and params.datatype != "float32":
        raise QdrantCollectionError("Source must be a legacy float32 Dot collection")
    if not client.collection_exists(collection_name):
        try:
            client.create_collection(
                collection_name,
                vectors_config={},
                metadata={"mirkMigration": {"source": source_collection_name, "complete": False}},
            )
        except Exception:
            if not client.collection_exists(collection_name):
                raise
    target = client.get_collection(collection_name)
    marker = (target.config.metadata or {}).get("mirkMigration")
    if not isinstance(marker, dict):
        raise QdrantCollectionError("Destination is not owned by this migration")
    marker = cast(dict[str, Any], marker)
    if marker.get("source") != source_collection_name:
        raise QdrantCollectionError("Destination is not owned by this migration")
    if marker.get("complete") is True:
        return QdrantVectorStore(client, collection_name=collection_name)
    store = QdrantVectorStore.openMigrationDestination(client, collection_name)
    store.ensureSpace("default", {"dimensions": params.size})
    total = client.count(source_collection_name, exact=True).count
    copied = 0
    offset = None
    while True:
        points, offset = client.scroll(
            source_collection_name,
            limit=page_size,
            offset=offset,
            with_payload=True,
            with_vectors=False,
        )
        for point in points:
            payload = point.payload
            if payload is None:
                raise QdrantCollectionError("Malformed legacy point")
            collection = legacy_json(payload, "_mirk_collection")
            identifier = legacy_json(payload, "_mirk_id")
            if not isinstance(collection, str) or not isinstance(identifier, str):
                raise QdrantCollectionError("Malformed legacy identity")
            if str(point.id) != str(point_uuid(collection, identifier)):
                raise QdrantCollectionError("Malformed legacy UUID")
            encoded_vector = payload.get("_mirk_vector")
            if not isinstance(encoded_vector, str):
                raise QdrantCollectionError("Malformed legacy vector bytes")
            try:
                raw_vector = base64.b64decode(encoded_vector, validate=True)
                if (
                    len(raw_vector) != params.size * 4
                    or base64.b64encode(raw_vector).decode() != encoded_vector
                ):
                    raise ValueError("Invalid legacy vector encoding or length")
                vector = bytes_to_vector(raw_vector)
            except (ValueError, binascii.Error) as error:
                raise QdrantCollectionError("Malformed legacy vector bytes") from error
            document: dict[str, Any] = {"id": identifier, "vectors": {"default": vector}}
            has_metadata = payload.get("_mirk_has_metadata")
            if not isinstance(has_metadata, bool):
                raise QdrantCollectionError("Malformed legacy metadata presence flag")
            if has_metadata:
                metadata = legacy_json(payload, "_mirk_metadata")
                if not isinstance(metadata, dict):
                    raise QdrantCollectionError("Malformed legacy metadata: expected JSON object")
                document["metadata"] = cast(dict[str, Any], metadata)
            elif "_mirk_metadata" in payload:
                raise QdrantCollectionError("Malformed legacy metadata: present without its flag")
            store.upsert(collection, cast(VectorDocument, document))
            copied += 1
        if on_progress is not None:
            on_progress({"copied": copied, "total": total, "complete": False})
        if offset is None:
            break
    if copied != total or client.count(collection_name, exact=True).count != total:
        raise QdrantCollectionError(
            "Migration count verification failed; resume with writers stopped"
        )
    client.update_collection(
        collection_name,
        metadata={"mirkMigration": {"source": source_collection_name, "complete": True}},
    )
    if on_progress is not None:
        on_progress({"copied": copied, "total": total, "complete": True})
    return store
