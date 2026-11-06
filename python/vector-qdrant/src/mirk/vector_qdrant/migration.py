"""Recoverable copy migration from the legacy unnamed collection format."""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from typing import Any, cast

from mirk.store.vector import bytes_to_vector
from qdrant_client import QdrantClient

from .store import QdrantVectorStore
from .wire import point_uuid


def migrateLegacyQdrantVectors(
    client: QdrantClient,
    *,
    source_collection_name: str,
    collection_name: str,
    page_size: object = 256,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
) -> QdrantVectorStore:
    """Copy a quiesced source into a new, resumable destination; preserve the source."""
    if source_collection_name == collection_name:
        raise ValueError("Migration destination must be a new collection")
    if isinstance(page_size, bool) or not isinstance(page_size, int) or page_size <= 0:
        raise ValueError("Migration page_size must be a positive integer")
    source = client.get_collection(source_collection_name)
    params = source.config.params.vectors
    if params is None or isinstance(params, dict) or params.distance != "Dot":
        raise ValueError("Source must be a legacy float32 Dot collection")
    if params.datatype is not None and params.datatype != "float32":
        raise ValueError("Source must be a legacy float32 Dot collection")
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
        raise ValueError("Destination is not owned by this migration")
    marker = cast(dict[str, Any], marker)
    if marker.get("source") != source_collection_name:
        raise ValueError("Destination is not owned by this migration")
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
                raise ValueError("Malformed legacy point")
            collection = json.loads(str(payload.get("_mirk_collection")))
            identifier = json.loads(str(payload.get("_mirk_id")))
            if not isinstance(collection, str) or not isinstance(identifier, str):
                raise ValueError("Malformed legacy identity")
            if str(point.id) != str(point_uuid(collection, identifier)):
                raise ValueError("Malformed legacy UUID")
            vector = bytes_to_vector(
                base64.b64decode(str(payload.get("_mirk_vector")), validate=True)
            )
            if len(vector) != params.size:
                raise ValueError("Malformed legacy vector bytes")
            document: dict[str, Any] = {"id": identifier, "vectors": {"default": vector}}
            if payload.get("_mirk_has_metadata") is True:
                document["metadata"] = json.loads(str(payload.get("_mirk_metadata")))
            from mirk.store.vector import VectorDocument

            store.upsert(collection, cast(VectorDocument, document))
            copied += 1
        if on_progress is not None:
            on_progress({"copied": copied, "total": total, "complete": False})
        if offset is None:
            break
    if copied != total or client.count(collection_name, exact=True).count != total:
        raise ValueError("Migration count verification failed; resume with writers stopped")
    client.update_collection(
        collection_name,
        metadata={"mirkMigration": {"source": source_collection_name, "complete": True}},
    )
    if on_progress is not None:
        on_progress({"copied": copied, "total": total, "complete": True})
    return store
