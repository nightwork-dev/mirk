"""Qdrant adapter for Mirk's synchronous vector store port."""

from __future__ import annotations

import base64
import binascii
import json
import math
from typing import Any, cast

from mirk.store.filter import dumps_json
from mirk.store.vector import (
    VectorDocument,
    VectorInputError,
    VectorQuery,
    VectorSearchOptions,
    VectorSearchResult,
    VectorSearchResultList,
    VectorSpace,
    VectorSpaceOptions,
    VectorStore,
    VectorStoreMeta,
    assert_dimensions,
    min_score_of,
    score_of,
    sort_results,
    to_float32,
    top_k_of,
)
from qdrant_client import QdrantClient, models

from .wire import (
    COLLECTION_FIELD,
    DEFAULT_PAGE_SIZE,
    HAS_METADATA_FIELD,
    TERMS_FIELD,
    USABLE_FIELD,
    candidate_bound,
    decode_record,
    distance_value,
    is_already_exists_conflict,
    native_name,
    payload_for,
    point_uuid,
    protocol_error,
    scope_filter,
    search_filter,
    validate_dimensions,
)


class QdrantVectorStore(VectorStore):
    """A synchronous ``VectorStore`` backed by one host-owned Qdrant client."""

    def __init__(
        self,
        client: QdrantClient,
        *,
        collection_name: str,
        namespace: str = "default",
        page_size: object = DEFAULT_PAGE_SIZE,
    ) -> None:
        self._client = client
        self._collection_name = collection_name
        self._namespace = namespace
        self._spaces: dict[str, int] = {}
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
        return {"backend": "qdrant", "accelerated": True}

    @classmethod
    def openMigrationDestination(cls, client: QdrantClient, name: str) -> QdrantVectorStore:
        store = cls.__new__(cls)
        store._client = client
        store._collection_name = name
        store._namespace = "default"
        store._spaces = {}
        store._page_size = DEFAULT_PAGE_SIZE
        store._ensure_payload_indexes(client.get_collection(name))
        return store

    def _ensure_collection(self) -> None:
        if not self._client.collection_exists(self._collection_name):
            try:
                self._client.create_collection(
                    collection_name=self._collection_name,
                    vectors_config={},
                )
            except BaseException as error:
                if not is_already_exists_conflict(error):
                    raise
        info = self._client.get_collection(self._collection_name)
        marker = (info.config.metadata or {}).get("mirkMigration")
        if isinstance(marker, dict) and cast(dict[str, Any], marker).get("complete") is not True:
            raise ValueError("Migration incomplete; resume migrateLegacyQdrantVectors")
        vectors = info.config.params.vectors
        if not isinstance(vectors, dict):
            raise ValueError(
                "Legacy unnamed Qdrant vectors require explicit migration; data unchanged"
            )
        self.listSpaces()
        self._ensure_payload_indexes(info)

    def _ensure_payload_indexes(self, info: Any) -> None:
        expected = (
            (COLLECTION_FIELD, models.PayloadSchemaType.KEYWORD),
            (TERMS_FIELD, models.PayloadSchemaType.KEYWORD),
            (USABLE_FIELD, models.PayloadSchemaType.KEYWORD),
            (HAS_METADATA_FIELD, models.PayloadSchemaType.BOOL),
        )
        payload_schema = cast(dict[str, Any], getattr(info, "payload_schema", None) or {})
        for field_name, schema in expected:
            existing = payload_schema.get(field_name)
            if existing is None:
                continue
            actual = distance_value(getattr(existing, "data_type", existing))
            if actual != distance_value(schema):
                raise ValueError(
                    f"Qdrant collection {self._collection_name!r} has incompatible payload "
                    f"index {field_name!r}: expected {distance_value(schema)}, got {actual}."
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

    def listSpaces(self) -> list[VectorSpace]:
        vectors = self._client.get_collection(self._collection_name).config.params.vectors
        if not isinstance(vectors, dict):
            raise ValueError(
                "Legacy unnamed Qdrant vectors require explicit migration; data unchanged"
            )
        self._spaces.clear()
        for key, params in vectors.items():
            if not key.startswith("mirk_"):
                continue
            token = key[5:]
            try:
                identity = json.loads(base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)))
            except (ValueError, binascii.Error):
                continue
            if not isinstance(identity, list):
                continue
            identity = cast(list[Any], identity)
            if len(identity) != 2 or identity[0] != self._namespace:
                continue
            name: Any = identity[1]
            if (
                not isinstance(name, str)
                or params.distance != models.Distance.DOT
                or params.datatype not in (None, models.Datatype.FLOAT32)
                or params.multivector_config is not None
            ):
                raise ValueError("Incompatible named vector schema")
            self._spaces[name] = params.size
        return [
            {"name": name, "dimensions": dimensions, "metric": "cosine", "encoding": "float32"}
            for name, dimensions in sorted(self._spaces.items())
        ]

    def ensureSpace(self, name: str, options: VectorSpaceOptions) -> None:
        if not name:
            raise VectorInputError("invalid-space", "Space name must be nonempty")
        dimensions = validate_dimensions(options["dimensions"])
        self.listSpaces()
        existing = self._spaces.get(name)
        if existing is not None:
            if existing != dimensions:
                raise VectorInputError(
                    "space-definition-conflict", f"Space {name} already has {existing} dimensions"
                )
            return
        try:
            self._client.create_vector_name(
                collection_name=self._collection_name,
                vector_name=native_name(self._namespace, name),
                vector_name_config=models.DenseVectorNameConfig(
                    dense=models.DenseVectorConfig(size=dimensions, distance=models.Distance.DOT)
                ),
                wait=True,
            )
        except Exception:
            self.listSpaces()
            concurrent = self._spaces.get(name)
            if concurrent is not None and concurrent != dimensions:
                raise VectorInputError(
                    "space-definition-conflict", f"Space {name} already has {concurrent} dimensions"
                ) from None
            if concurrent is None:
                raise
        self.listSpaces()

    def _dimensions_for(self, name: str) -> int:
        dimensions = self._spaces.get(name)
        if dimensions is None:
            raise VectorInputError("unknown-space", f"Unknown vector space: {name}")
        return dimensions

    def _scope(self, collection: str) -> str:
        return dumps_json([self._namespace, collection])

    def upsert(self, collection: str, doc: VectorDocument) -> None:
        self.upsertMany(collection, [doc])

    def upsertMany(self, collection: str, docs: list[VectorDocument]) -> None:
        if not docs:
            return
        self.listSpaces()
        collection = self._scope(collection)
        points: list[models.PointStruct] = []
        for doc in docs:
            if not doc["vectors"]:
                raise VectorInputError("empty-vectors", "A document needs at least one vector")
            for name, vector in doc["vectors"].items():
                assert_dimensions(vector, self._dimensions_for(name))
            points.append(payload_for(collection, doc, self._namespace))
        self._client.upsert(collection_name=self._collection_name, points=points, wait=True)

    def get(self, collection: str, id: str) -> VectorDocument | None:
        self.listSpaces()
        collection = self._scope(collection)
        points = self._client.retrieve(
            collection_name=self._collection_name,
            ids=[point_uuid(collection, id)],
            with_payload=True,
            with_vectors=False,
        )
        if not points:
            return None
        document = decode_record(points[0], collection, self._spaces)
        if document["id"] != id:
            raise protocol_error("retrieved point id does not match the requested id")
        return document

    def has(self, collection: str, id: str) -> bool:
        return self.get(collection, id) is not None

    def remove(self, collection: str, id: str) -> bool:
        if not self.has(collection, id):
            return False
        self._client.delete(
            collection_name=self._collection_name,
            points_selector=models.PointIdsList(points=[point_uuid(self._scope(collection), id)]),
            wait=True,
        )
        return True

    def count(self, collection: str) -> int:
        result = self._client.count(
            collection_name=self._collection_name,
            count_filter=scope_filter(self._scope(collection)),
            exact=True,
        )
        return int(result.count)

    def search(
        self,
        collection: str,
        query: VectorQuery,
        opts: VectorSearchOptions | None = None,
    ) -> VectorSearchResultList:
        self.listSpaces()
        dimensions = self._dimensions_for(query["space"])
        assert_dimensions(query["vector"], dimensions)
        collection = self._scope(collection)
        rounded_query = to_float32(query["vector"])
        if any(not math.isfinite(component) for component in rounded_query):
            return []

        norm = math.sqrt(sum(component * component for component in rounded_query))
        if not math.isfinite(norm):
            return []
        native_query = (
            [0.0] * dimensions
            if norm == 0.0
            else to_float32([component / norm for component in rounded_query])
        )
        minimum = min_score_of(opts)
        bound = candidate_bound(dimensions)
        retained: VectorSearchResultList = []
        seen: set[str] = set()
        k = top_k_of(opts)
        native_filter = search_filter(collection, opts, query["space"])

        def add_point(point: Any) -> bool:
            document = decode_record(point, collection, self._spaces)
            identifier = document["id"]
            if identifier in seen:
                return False
            seen.add(identifier)
            score = score_of(rounded_query, document["vectors"][query["space"]], minimum)
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
                using=native_name(self._namespace, query["space"]),
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
                    raise protocol_error("native search returned a duplicate point")
            native_score = float(points[-1].score)
            sort_results(retained)
            cutoff: float | None = (
                minimum if minimum is not None and math.isfinite(minimum) else None
            )
            if k > 0 and len(retained) >= k:
                kth = retained[k - 1]["score"]
                cutoff = kth if cutoff is None else max(cutoff, kth)
            if cutoff is not None and native_score < cutoff - bound:
                break
            if len(points) < window:
                break
            window *= 2

        sort_results(retained)
        return retained[:k]
