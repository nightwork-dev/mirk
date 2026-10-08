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
    VectorSearchResult,
    VectorSearchResultList,
    VectorStore,
    VectorStoreMeta,
    assert_dimensions,
    bytes_to_vector,
    is_usable_vector,
    min_score_of,
    score_of,
    sort_results,
    to_float32,
    top_k_of,
    vector_to_bytes,
)
from qdrant_client import QdrantClient, models

__all__ = ["QdrantVectorStore"]

_COLLECTION_FIELD = "_mirk_collection"
_ID_FIELD = "_mirk_id"
_VECTOR_FIELD = "_mirk_vector"
_USABLE_FIELD = "_mirk_usable"
_HAS_METADATA_FIELD = "_mirk_has_metadata"
_METADATA_FIELD = "_mirk_metadata"
_TERMS_FIELD = "_mirk_terms"
_WIRE_VERSION = "mirk-vector-qdrant-v1"
_DEFAULT_PAGE_SIZE = 256
_UNIT_ROUNDOFF = 2.0**-24


def _positive_dimensions_message(dimensions: object) -> str:
    return f"Vector dimensions must be a positive integer; got {dimensions}."


def _validate_dimensions(dimensions: object) -> int:
    if isinstance(dimensions, bool) or not isinstance(dimensions, int) or dimensions <= 0:
        raise VectorInputError("invalid-dimensions", _positive_dimensions_message(dimensions))
    return dimensions


def _json_token(value: str) -> str:
    return dumps_json(value)


def _point_uuid(collection: str, identifier: str) -> uuid.UUID:
    digest = hashlib.sha256(
        dumps_json([_WIRE_VERSION, collection, identifier]).encode("utf-8")
    ).digest()
    raw = bytearray(digest[:16])
    raw[6] = (raw[6] & 0x0F) | 0x50
    raw[8] = (raw[8] & 0x3F) | 0x80
    return uuid.UUID(bytes=bytes(raw))


def _index_vector(vector: list[float]) -> list[float]:
    if not is_usable_vector(vector):
        return [0.0] * len(vector)
    norm = math.sqrt(sum(component * component for component in vector))
    if norm == 0.0 or not math.isfinite(norm):
        return [0.0] * len(vector)
    return to_float32([component / norm for component in vector])


def _candidate_bound(dimensions: int) -> float:
    n = 4 * dimensions + 16
    product = n * _UNIT_ROUNDOFF
    if product >= 1.0:
        return math.inf
    return product / (1.0 - product)


def _is_already_exists_conflict(error: BaseException) -> bool:
    status_code = getattr(error, "status_code", None)
    if status_code != 409:
        return False
    text = str(error).lower()
    return "already exists" in text or "already exist" in text


def _distance_value(value: object) -> object:
    return getattr(value, "value", value)


def _vector_params(info: Any) -> tuple[int, object, object, object] | None:
    params = getattr(getattr(info, "config", None), "params", None)
    vectors = getattr(params, "vectors", None)
    if isinstance(vectors, dict):
        return None
    size = getattr(vectors, "size", None)
    distance = getattr(vectors, "distance", None)
    if not isinstance(size, int) or distance is None:
        return None
    return (
        size,
        _distance_value(distance),
        _distance_value(getattr(vectors, "datatype", None)),
        getattr(vectors, "multivector_config", None),
    )


def _condition(key: str, value: str | bool) -> models.FieldCondition:
    return models.FieldCondition(key=key, match=models.MatchValue(value=value))


def _metadata_conditions(values: dict[str, Any]) -> list[models.FieldCondition]:
    return [
        _condition(_HAS_METADATA_FIELD, True),
        *(
            _condition(_TERMS_FIELD, dumps_json([key, value]))
            for key, value in values.items()
        ),
    ]


def _search_filter(
    collection: str,
    options: VectorSearchOptions | None,
) -> models.Filter:
    must: list[Any] = [
        _condition(_COLLECTION_FIELD, _json_token(collection)),
        _condition(_USABLE_FIELD, True),
    ]
    if options is not None:
        where = options.get("where")
        if where is not None:
            must.append(models.Filter(must=cast(Any, _metadata_conditions(where))))
        where_not = options.get("whereNot")
        if where_not is not None:
            must_not = models.Filter(must=cast(Any, _metadata_conditions(where_not)))
            must_not_list: list[Any] = [must_not]
        else:
            must_not_list = []
    else:
        must_not_list = []
    return models.Filter(must=must, must_not=must_not_list or None)


def _scope_filter(collection: str) -> models.Filter:
    return models.Filter(must=[_condition(_COLLECTION_FIELD, _json_token(collection))])


def _payload_for(
    collection: str,
    doc: VectorDocument,
) -> models.PointStruct:
    raw = to_float32(doc["vector"])
    metadata = doc.get("metadata")
    payload: dict[str, Any] = {
        _COLLECTION_FIELD: _json_token(collection),
        _ID_FIELD: _json_token(doc["id"]),
        _VECTOR_FIELD: base64.b64encode(vector_to_bytes(raw)).decode("ascii"),
        _USABLE_FIELD: is_usable_vector(raw),
        _HAS_METADATA_FIELD: metadata is not None,
        _TERMS_FIELD: [],
    }
    if metadata is not None:
        metadata_text = dumps_json(metadata)
        payload[_METADATA_FIELD] = metadata_text
        wire_metadata = json.loads(metadata_text)
        if not isinstance(wire_metadata, dict):
            raise _protocol_error("metadata is not a JSON object")
        wire_metadata = cast(dict[str, Any], wire_metadata)
        payload[_TERMS_FIELD] = [
            dumps_json([key, value]) for key, value in wire_metadata.items()
        ]
    return models.PointStruct(
        id=_point_uuid(collection, doc["id"]),
        vector=_index_vector(raw),
        payload=payload,
    )


def _protocol_error(message: str) -> ValueError:
    return ValueError(f"Qdrant Mirk vector protocol mismatch: {message}")


def _decode_record(
    record: Any,
    collection: str,
    dimensions: int,
) -> VectorDocument:
    payload = record.payload
    if not isinstance(payload, dict):
        raise _protocol_error("point payload is absent")
    payload = cast(dict[str, Any], payload)

    collection_token = payload.get(_COLLECTION_FIELD)
    if collection_token != _json_token(collection):
        raise _protocol_error("logical collection token does not match")

    id_token = payload.get(_ID_FIELD)
    if not isinstance(id_token, str):
        raise _protocol_error("point id token is absent")
    try:
        identifier = json.loads(id_token)
    except json.JSONDecodeError as error:
        raise _protocol_error("point id token is invalid JSON") from error
    if not isinstance(identifier, str):
        raise _protocol_error("point id token does not decode to a string")
    if str(record.id) != str(_point_uuid(collection, identifier)):
        raise _protocol_error("point UUID does not match its logical id")

    encoded_vector = payload.get(_VECTOR_FIELD)
    if not isinstance(encoded_vector, str):
        raise _protocol_error("raw vector payload is absent")
    try:
        raw = bytes_to_vector(base64.b64decode(encoded_vector, validate=True))
    except (ValueError, binascii.Error) as error:
        raise _protocol_error("raw vector payload is invalid base64") from error
    if len(raw) != dimensions:
        raise _protocol_error("raw vector dimensions do not match the collection")

    usable = payload.get(_USABLE_FIELD)
    if not isinstance(usable, bool) or usable != is_usable_vector(raw):
        raise _protocol_error("raw vector usability flag is inconsistent")

    has_metadata = payload.get(_HAS_METADATA_FIELD)
    if not isinstance(has_metadata, bool):
        raise _protocol_error("metadata presence flag is absent")
    metadata: dict[str, Any] | None = None
    if has_metadata:
        metadata_text = payload.get(_METADATA_FIELD)
        if not isinstance(metadata_text, str):
            raise _protocol_error("metadata payload is absent")
        try:
            decoded_metadata = json.loads(metadata_text)
        except json.JSONDecodeError as error:
            raise _protocol_error("metadata payload is invalid JSON") from error
        if not isinstance(decoded_metadata, dict):
            raise _protocol_error("metadata payload is not an object")
        metadata = cast(dict[str, Any], decoded_metadata)
    elif _METADATA_FIELD in payload:
        raise _protocol_error("metadata payload is present without its flag")

    terms = payload.get(_TERMS_FIELD)
    expected_terms = (
        [] if metadata is None else [dumps_json([key, value]) for key, value in metadata.items()]
    )
    if terms != expected_terms:
        raise _protocol_error("metadata terms are inconsistent")

    document: VectorDocument = {"id": identifier, "vector": raw}
    if metadata is not None:
        document["metadata"] = metadata
    return document


class QdrantVectorStore(VectorStore):
    """A synchronous ``VectorStore`` backed by one host-owned Qdrant client."""

    def __init__(
        self,
        client: QdrantClient,
        *,
        collection_name: str,
        dimensions: int,
        page_size: object = _DEFAULT_PAGE_SIZE,
    ) -> None:
        self._client = client
        self._collection_name = collection_name
        self._dimensions = _validate_dimensions(dimensions)
        page_size_value: object = page_size
        if (
            isinstance(page_size_value, bool)
            or not isinstance(page_size_value, int)
            or page_size_value <= 0
        ):
            raise ValueError(f"Qdrant page_size must be a positive integer; got {page_size}.")
        self._page_size = page_size_value
        self._ensure_collection()

    @property
    def meta(self) -> VectorStoreMeta:
        return {"backend": "qdrant", "dimensions": self._dimensions, "accelerated": True}

    @property
    def dimensions(self) -> int:
        return self._dimensions

    def _ensure_collection(self) -> None:
        if not self._client.collection_exists(self._collection_name):
            try:
                self._client.create_collection(
                    collection_name=self._collection_name,
                    vectors_config=models.VectorParams(
                        size=self._dimensions,
                        distance=models.Distance.DOT,
                    ),
                )
            except BaseException as error:
                if not _is_already_exists_conflict(error):
                    raise
        info = self._client.get_collection(self._collection_name)
        params = _vector_params(info)
        if params is None:
            raise ValueError(
                f"Qdrant collection {self._collection_name!r} must have one unnamed vector."
            )
        size, distance, datatype, multivector_config = params
        if (
            size != self._dimensions
            or distance != _distance_value(models.Distance.DOT)
            or datatype not in (None, _distance_value(models.Datatype.FLOAT32))
            or multivector_config is not None
        ):
            raise ValueError(
                f"Qdrant collection {self._collection_name!r} has incompatible vector config: "
                f"expected size {self._dimensions}, distance Dot, float32, and one vector; "
                f"got size {size}, distance {distance}, datatype {datatype}, and "
                f"multivector config {multivector_config}."
            )
        self._ensure_payload_indexes(info)

    def _ensure_payload_indexes(self, info: Any) -> None:
        expected = (
            (_COLLECTION_FIELD, models.PayloadSchemaType.KEYWORD),
            (_TERMS_FIELD, models.PayloadSchemaType.KEYWORD),
            (_USABLE_FIELD, models.PayloadSchemaType.BOOL),
            (_HAS_METADATA_FIELD, models.PayloadSchemaType.BOOL),
        )
        payload_schema = cast(dict[str, Any], getattr(info, "payload_schema", None) or {})
        for field_name, schema in expected:
            existing = payload_schema.get(field_name)
            if existing is None:
                continue
            actual = _distance_value(getattr(existing, "data_type", existing))
            if actual != _distance_value(schema):
                raise ValueError(
                    f"Qdrant collection {self._collection_name!r} has incompatible payload "
                    f"index {field_name!r}: expected {_distance_value(schema)}, got {actual}."
                )
        for field_name, schema in expected:
            if field_name in payload_schema:
                continue
            self._client.create_payload_index(
                collection_name=self._collection_name,
                field_name=field_name,
                field_schema=schema,
                wait=True,
            )

    def _assert_dimensions(self, vector: list[float]) -> None:
        assert_dimensions(vector, self._dimensions)

    def upsert(self, collection: str, doc: VectorDocument) -> None:
        self.upsertMany(collection, [doc])

    def upsertMany(self, collection: str, docs: list[VectorDocument]) -> None:
        if not docs:
            return
        points: list[models.PointStruct] = []
        for doc in docs:
            self._assert_dimensions(doc["vector"])
            points.append(_payload_for(collection, doc))
        self._client.upsert(collection_name=self._collection_name, points=points, wait=True)

    def get(self, collection: str, id: str) -> VectorDocument | None:
        points = self._client.retrieve(
            collection_name=self._collection_name,
            ids=[_point_uuid(collection, id)],
            with_payload=True,
            with_vectors=False,
        )
        if not points:
            return None
        document = _decode_record(points[0], collection, self._dimensions)
        if document["id"] != id:
            raise _protocol_error("retrieved point id does not match the requested id")
        return document

    def has(self, collection: str, id: str) -> bool:
        return self.get(collection, id) is not None

    def remove(self, collection: str, id: str) -> bool:
        if not self.has(collection, id):
            return False
        self._client.delete(
            collection_name=self._collection_name,
            points_selector=models.PointIdsList(points=[_point_uuid(collection, id)]),
            wait=True,
        )
        return True

    def count(self, collection: str) -> int:
        result = self._client.count(
            collection_name=self._collection_name,
            count_filter=_scope_filter(collection),
            exact=True,
        )
        return int(result.count)

    def search(
        self,
        collection: str,
        query: list[float],
        opts: VectorSearchOptions | None = None,
    ) -> VectorSearchResultList:
        self._assert_dimensions(query)
        rounded_query = to_float32(query)
        if any(not math.isfinite(component) for component in rounded_query):
            return []

        norm = math.sqrt(sum(component * component for component in rounded_query))
        if not math.isfinite(norm):
            return []
        native_query = (
            [0.0] * self._dimensions
            if norm == 0.0
            else to_float32([component / norm for component in rounded_query])
        )
        minimum = min_score_of(opts)
        bound = _candidate_bound(self._dimensions)
        retained: VectorSearchResultList = []
        seen: set[str] = set()
        k = top_k_of(opts)
        native_filter = _search_filter(collection, opts)

        def add_point(point: Any) -> bool:
            document = _decode_record(point, collection, self._dimensions)
            identifier = document["id"]
            if identifier in seen:
                return False
            seen.add(identifier)
            score = score_of(rounded_query, document["vector"], minimum)
            if score is None:
                return True
            hit: VectorSearchResult = {"id": identifier, "score": score}
            metadata = document.get("metadata")
            if metadata is not None:
                hit["metadata"] = metadata
            retained.append(hit)
            return True

        window = self._page_size
        while True:
            retained.clear()
            seen.clear()
            response = self._client.query_points(
                collection_name=self._collection_name,
                query=native_query,
                query_filter=native_filter,
                search_params=models.SearchParams(
                    exact=True,
                    quantization=models.QuantizationSearchParams(ignore=True),
                ),
                limit=window,
                offset=0,
                with_payload=True,
                with_vectors=False,
            )
            points = list(response.points)
            if not points:
                break
            for point in points:
                if not add_point(point):
                    raise _protocol_error("native search returned a duplicate point")
            native_score = float(points[-1].score)
            sort_results(retained)
            cutoff: float | None = (
                minimum if minimum is not None and math.isfinite(minimum) else None
            )
            if k > 0 and len(retained) >= k:
                kth = retained[k - 1]["score"]
                cutoff = kth if cutoff is None else max(cutoff, kth)
            if (
                cutoff is not None
                and native_score < cutoff - bound
            ):
                break
            if len(points) < window:
                break
            window *= 2

        sort_results(retained)
        return retained[:k]
