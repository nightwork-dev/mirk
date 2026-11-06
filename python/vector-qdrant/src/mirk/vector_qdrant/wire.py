"""Qdrant adapter for Mirk's synchronous vector store port."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import uuid
from typing import Any, cast

from mirk.store.filter import dumps_json
from mirk.store.vector import (
    VectorDocument,
    VectorInputError,
    VectorSearchOptions,
    bytes_to_vector,
    is_usable_vector,
    to_float32,
    vector_to_bytes,
)
from qdrant_client import models

COLLECTION_FIELD = "_mirk_collection"
ID_FIELD = "_mirk_id"
VECTOR_FIELD = "_mirk_vectors"
USABLE_FIELD = "_mirk_usable_spaces"
HAS_METADATA_FIELD = "_mirk_has_metadata"
METADATA_FIELD = "_mirk_metadata"
TERMS_FIELD = "_mirk_terms"
WIRE_VERSION = "mirk-vector-qdrant-v1"
DEFAULT_PAGE_SIZE = 256
UNIT_ROUNDOFF = 2.0**-24


def positive_dimensions_message(dimensions: object) -> str:
    return f"Vector dimensions must be a positive integer; got {dimensions}."


def validate_dimensions(dimensions: object) -> int:
    if isinstance(dimensions, bool) or not isinstance(dimensions, int) or dimensions <= 0:
        raise VectorInputError("invalid-dimensions", positive_dimensions_message(dimensions))
    return dimensions


def json_token(value: str) -> str:
    return dumps_json(value)


def point_uuid(collection: str, identifier: str) -> uuid.UUID:
    digest = hashlib.sha256(
        dumps_json([WIRE_VERSION, collection, identifier]).encode("utf-8")
    ).digest()
    raw = bytearray(digest[:16])
    raw[6] = (raw[6] & 0x0F) | 0x50
    raw[8] = (raw[8] & 0x3F) | 0x80
    return uuid.UUID(bytes=bytes(raw))


def index_vector(vector: list[float]) -> list[float]:
    if not is_usable_vector(vector):
        return [0.0] * len(vector)
    norm = math.sqrt(sum(component * component for component in vector))
    if norm == 0.0 or not math.isfinite(norm):
        return [0.0] * len(vector)
    return to_float32([component / norm for component in vector])


def candidate_bound(dimensions: int) -> float:
    n = 4 * dimensions + 16
    product = n * UNIT_ROUNDOFF
    if product >= 1.0:
        return math.inf
    return product / (1.0 - product)


def is_already_exists_conflict(error: BaseException) -> bool:
    status_code = getattr(error, "status_code", None)
    if status_code != 409:
        return False
    text = str(error).lower()
    return "already exists" in text or "already exist" in text


def distance_value(value: object) -> object:
    return getattr(value, "value", value)


def condition(key: str, value: str | bool) -> models.FieldCondition:
    return models.FieldCondition(key=key, match=models.MatchValue(value=value))


def metadata_conditions(values: dict[str, Any]) -> list[models.FieldCondition]:
    return [
        condition(HAS_METADATA_FIELD, True),
        *(condition(TERMS_FIELD, dumps_json([key, value])) for key, value in values.items()),
    ]


def search_filter(
    collection: str,
    options: VectorSearchOptions | None,
    space: str,
) -> models.Filter:
    must: list[Any] = [
        condition(COLLECTION_FIELD, json_token(collection)),
        condition(USABLE_FIELD, json_token(space)),
    ]
    if options is not None:
        where = options.get("where")
        if where is not None:
            must.append(models.Filter(must=cast(Any, metadata_conditions(where))))
        where_not = options.get("whereNot")
        if where_not is not None:
            must_not = models.Filter(must=cast(Any, metadata_conditions(where_not)))
            must_not_list: list[Any] = [must_not]
        else:
            must_not_list = []
    else:
        must_not_list = []
    return models.Filter(must=must, must_not=must_not_list or None)


def scope_filter(collection: str) -> models.Filter:
    return models.Filter(must=[condition(COLLECTION_FIELD, json_token(collection))])


def payload_for(
    collection: str,
    doc: VectorDocument,
    namespace: str,
) -> models.PointStruct:
    raw = {name: to_float32(vector) for name, vector in doc["vectors"].items()}
    metadata = doc.get("metadata")
    payload: dict[str, Any] = {
        COLLECTION_FIELD: json_token(collection),
        ID_FIELD: json_token(doc["id"]),
        VECTOR_FIELD: dumps_json(
            {
                name: base64.b64encode(vector_to_bytes(vector)).decode("ascii")
                for name, vector in raw.items()
            }
        ),
        USABLE_FIELD: [
            json_token(name) for name, vector in raw.items() if is_usable_vector(vector)
        ],
        HAS_METADATA_FIELD: metadata is not None,
        TERMS_FIELD: [],
    }
    if metadata is not None:
        metadata_text = dumps_json(metadata)
        payload[METADATA_FIELD] = metadata_text
        wire_metadata = json.loads(metadata_text)
        if not isinstance(wire_metadata, dict):
            raise protocol_error("metadata is not a JSON object")
        wire_metadata = cast(dict[str, Any], wire_metadata)
        payload[TERMS_FIELD] = [dumps_json([key, value]) for key, value in wire_metadata.items()]
    return models.PointStruct(
        id=point_uuid(collection, doc["id"]),
        vector={native_name(namespace, name): index_vector(vector) for name, vector in raw.items()},
        payload=payload,
    )


def protocol_error(message: str) -> ValueError:
    return ValueError(f"Qdrant Mirk vector protocol mismatch: {message}")


def decode_record(
    record: Any,
    collection: str,
    spaces: dict[str, int],
) -> VectorDocument:
    payload = record.payload
    if not isinstance(payload, dict):
        raise protocol_error("point payload is absent")
    payload = cast(dict[str, Any], payload)

    collection_token = payload.get(COLLECTION_FIELD)
    if collection_token != json_token(collection):
        raise protocol_error("logical collection token does not match")

    id_token = payload.get(ID_FIELD)
    if not isinstance(id_token, str):
        raise protocol_error("point id token is absent")
    try:
        identifier = json.loads(id_token)
    except json.JSONDecodeError as error:
        raise protocol_error("point id token is invalid JSON") from error
    if not isinstance(identifier, str):
        raise protocol_error("point id token does not decode to a string")
    if str(record.id) != str(point_uuid(collection, identifier)):
        raise protocol_error("point UUID does not match its logical id")

    encoded_vectors = payload.get(VECTOR_FIELD)
    if not isinstance(encoded_vectors, str):
        raise protocol_error("raw vectors payload is absent")
    decoded_vectors = json.loads(encoded_vectors)
    if not isinstance(decoded_vectors, dict):
        raise protocol_error("raw vectors payload is malformed")
    raw: dict[str, list[float]] = {}
    for name, value in cast(dict[str, Any], decoded_vectors).items():
        if name not in spaces or not isinstance(value, str):
            raise protocol_error("unknown vector space")
        try:
            vector = bytes_to_vector(base64.b64decode(value, validate=True))
        except (ValueError, binascii.Error) as error:
            raise protocol_error("invalid vector base64") from error
        if len(vector) != spaces[name]:
            raise protocol_error("vector dimensions mismatch")
        raw[name] = vector

    expected_usable = [json_token(name) for name, vector in raw.items() if is_usable_vector(vector)]
    if payload.get(USABLE_FIELD) != expected_usable or not raw:
        raise protocol_error("vector usability flags are inconsistent")

    has_metadata = payload.get(HAS_METADATA_FIELD)
    if not isinstance(has_metadata, bool):
        raise protocol_error("metadata presence flag is absent")
    metadata: dict[str, Any] | None = None
    if has_metadata:
        metadata_text = payload.get(METADATA_FIELD)
        if not isinstance(metadata_text, str):
            raise protocol_error("metadata payload is absent")
        try:
            decoded_metadata = json.loads(metadata_text)
        except json.JSONDecodeError as error:
            raise protocol_error("metadata payload is invalid JSON") from error
        if not isinstance(decoded_metadata, dict):
            raise protocol_error("metadata payload is not an object")
        metadata = cast(dict[str, Any], decoded_metadata)
    elif METADATA_FIELD in payload:
        raise protocol_error("metadata payload is present without its flag")

    terms = payload.get(TERMS_FIELD)
    expected_terms = (
        [] if metadata is None else [dumps_json([key, value]) for key, value in metadata.items()]
    )
    if terms != expected_terms:
        raise protocol_error("metadata terms are inconsistent")

    document: VectorDocument = {"id": identifier, "vectors": raw}
    if metadata is not None:
        document["metadata"] = metadata
    return document


def native_name(namespace: str, space: str) -> str:
    encoded = base64.urlsafe_b64encode(dumps_json([namespace, space]).encode()).decode().rstrip("=")
    return "mirk_" + encoded
