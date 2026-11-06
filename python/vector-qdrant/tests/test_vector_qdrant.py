from __future__ import annotations

import math
import os
import uuid
from collections.abc import Iterator, Sequence

import pytest
from mirk.store.conformance import Scenario, load_scenarios, run_scenario
from mirk.store.vector import VectorInputError, VectorSearchResult
from qdrant_client import QdrantClient, models

from mirk.vector_qdrant import QdrantVectorStore

VECTOR_SCENARIOS = tuple(
    scenario for scenario in load_scenarios() if scenario.path.parent.name == "vector"
)


def _ids(rows: Sequence[VectorSearchResult]) -> list[str]:
    return [str(row["id"]) for row in rows]


@pytest.fixture
def qdrant_url() -> str:
    url = os.environ.get("MIRK_QDRANT_URL")
    if not url:
        pytest.skip("MIRK_QDRANT_URL is not set")
    return url


@pytest.fixture
def store(qdrant_url: str) -> Iterator[QdrantVectorStore]:
    client = QdrantClient(url=qdrant_url)
    name = f"mirk_py_test_{uuid.uuid4().hex}"
    assert not client.collection_exists(name)
    value = QdrantVectorStore(client, collection_name=name, page_size=2)
    value.ensureSpace("default", {"dimensions": 2})
    try:
        yield value
    finally:
        if client.collection_exists(name):
            client.delete_collection(name)
        client.close()


def test_round_trip_scope_count_filters_and_reopen(
    store: QdrantVectorStore, qdrant_url: str
) -> None:
    store.upsertMany(
        "notes",
        [
            {
                "id": "b",
                "vectors": {"default": [1.0, 0.0]},
                "metadata": {"nested": {"a": 1, "b": 2}, "tags": ["a", None]},
            },
            {"id": "a", "vectors": {"default": [1.0, 0.0]}},
            {"id": "other", "vectors": {"default": [1.0, 0.0]}, "metadata": {"kind": "other"}},
        ],
    )
    store.upsert("other", {"id": "same", "vectors": {"default": [1.0, 0.0]}})

    assert store.count("notes") == 3
    assert store.count("other") == 1
    assert store.get("notes", "b") == {
        "id": "b",
        "vectors": {"default": [1.0, 0.0]},
        "metadata": {"nested": {"a": 1, "b": 2}, "tags": ["a", None]},
    }
    assert store.get("notes", "missing") is None
    assert _ids(
        store.search("notes", {"space": "default", "vector": [1.0, 0.0]}, {"topK": 10})
    ) == ["a", "b", "other"]
    assert _ids(
        store.search(
            "notes",
            {"space": "default", "vector": [1.0, 0.0]},
            {"where": {"nested": {"a": 1, "b": 2}, "tags": ["a", None]}},
        )
    ) == ["b"]
    assert (
        store.search(
            "notes",
            {"space": "default", "vector": [1.0, 0.0]},
            {"where": {"nested": {"b": 2, "a": 1}}},
        )
        == []
    )
    assert _ids(
        store.search("notes", {"space": "default", "vector": [1.0, 0.0]}, {"whereNot": {}})
    ) == ["a"]

    reopened_client = QdrantClient(url=qdrant_url)
    try:
        reopened = QdrantVectorStore(
            reopened_client,
            collection_name=store._collection_name,  # pyright: ignore[reportPrivateUsage]
            page_size=2,
        )
        assert reopened.get("notes", "b") == store.get("notes", "b")
        assert reopened.count("notes") == 3
    finally:
        reopened_client.close()


def test_wire_tokens_preserve_lone_surrogates(store: QdrantVectorStore) -> None:
    scope = "scope-\ud800"
    identifier = "id-\udcff"
    store.upsert(
        scope, {"id": identifier, "vectors": {"default": [1.0, 0.0]}, "metadata": {"x": "\ud800"}}
    )
    assert store.count(scope) == 1
    assert store.get(scope, identifier) == {
        "id": identifier,
        "vectors": {"default": [1.0, 0.0]},
        "metadata": {"x": "\ud800"},
    }
    assert _ids(
        store.search(scope, {"space": "default", "vector": [1.0, 0.0]}, {"where": {"x": "\ud800"}})
    ) == [identifier]


def test_numeric_metadata_keys_follow_json_wire_order(store: QdrantVectorStore) -> None:
    metadata = {"2": "b", "1": "a", "other": "c"}
    store.upsert(
        "numeric-keys", {"id": "one", "vectors": {"default": [1.0, 0.0]}, "metadata": metadata}
    )
    assert store.get("numeric-keys", "one") == {
        "id": "one",
        "vectors": {"default": [1.0, 0.0]},
        "metadata": {"1": "a", "2": "b", "other": "c"},
    }
    assert _ids(
        store.search(
            "numeric-keys",
            {"space": "default", "vector": [1.0, 0.0]},
            {"where": {"1": "a", "2": "b"}},
        )
    ) == ["one"]


def test_float32_payload_preserves_unusable_vectors_and_query_rules(
    store: QdrantVectorStore,
) -> None:
    store.upsertMany(
        "vectors",
        [
            {"id": "good", "vectors": {"default": [1.0, 0.0]}},
            {"id": "zero", "vectors": {"default": [0.0, 0.0]}},
            {"id": "nan", "vectors": {"default": [math.nan, 1.0]}},
            {"id": "inf", "vectors": {"default": [math.inf, 1.0]}},
        ],
    )
    assert store.count("vectors") == 4
    assert _ids(
        store.search("vectors", {"space": "default", "vector": [1.0, 0.0]}, {"minScore": -1})
    ) == ["good"]
    zero = store.get("vectors", "zero")
    nan = store.get("vectors", "nan")
    inf = store.get("vectors", "inf")
    assert zero is not None and zero["vectors"]["default"] == [0.0, 0.0]
    assert nan is not None and math.isnan(nan["vectors"]["default"][0])
    assert inf is not None and math.isinf(inf["vectors"]["default"][0])
    assert _ids(store.search("vectors", {"space": "default", "vector": [0.0, 0.0]})) == ["good"]
    assert store.search("vectors", {"space": "default", "vector": [math.nan, 1.0]}) == []


def test_upsert_many_validates_every_document_before_mutation(store: QdrantVectorStore) -> None:
    store.upsert("atomic", {"id": "kept", "vectors": {"default": [1.0, 0.0]}})
    with pytest.raises(VectorInputError) as error:
        store.upsertMany(
            "atomic",
            [
                {"id": "new", "vectors": {"default": [0.0, 1.0]}},
                {"id": "bad", "vectors": {"default": [1.0, 0.0, 0.0]}},
            ],
        )
    assert error.value.code == "dimension-mismatch"
    assert store.count("atomic") == 1
    assert store.get("atomic", "new") is None
    store.upsertMany("atomic", [])
    assert store.count("atomic") == 1


def test_page_completion_reads_all_native_score_ties(store: QdrantVectorStore) -> None:
    store.upsertMany(
        "ties",
        [
            {"id": identifier, "vectors": {"default": [1.0, 0.0]}}
            for identifier in ("c", "a", "e", "b", "d")
        ],
    )
    assert _ids(store.search("ties", {"space": "default", "vector": [1.0, 0.0]}, {"topK": 3})) == [
        "a",
        "b",
        "c",
    ]
    assert _ids(store.search("ties", {"space": "default", "vector": [1.0, 0.0]}, {"topK": 10})) == [
        "a",
        "b",
        "c",
        "d",
        "e",
    ]


def test_existing_collection_configuration_is_validated(qdrant_url: str) -> None:
    client = QdrantClient(url=qdrant_url)
    name = f"mirk_py_test_{uuid.uuid4().hex}"
    client.create_collection(
        collection_name=name,
        vectors_config=models.VectorParams(size=3, distance=models.Distance.COSINE),
    )
    try:
        with pytest.raises(ValueError, match="Legacy"):
            QdrantVectorStore(client, collection_name=name)
    finally:
        client.delete_collection(name)

    datatype_name = f"mirk_py_test_{uuid.uuid4().hex}"
    client.create_collection(
        collection_name=datatype_name,
        vectors_config=models.VectorParams(
            size=2,
            distance=models.Distance.DOT,
            datatype=models.Datatype.FLOAT16,
        ),
    )
    try:
        with pytest.raises(ValueError, match="Legacy"):
            QdrantVectorStore(client, collection_name=datatype_name)
    finally:
        client.delete_collection(datatype_name)

    index_name = f"mirk_py_test_{uuid.uuid4().hex}"
    client.create_collection(
        collection_name=index_name,
        vectors_config={},
    )
    client.create_payload_index(
        collection_name=index_name,
        field_name="_mirk_collection",
        field_schema=models.PayloadSchemaType.INTEGER,
    )
    try:
        with pytest.raises(ValueError, match="payload index"):
            QdrantVectorStore(client, collection_name=index_name)
        schema = client.get_collection(index_name).payload_schema
        assert set(schema) == {"_mirk_collection"}
    finally:
        client.delete_collection(index_name)
        client.close()


@pytest.mark.parametrize("scenario", VECTOR_SCENARIOS, ids=lambda scenario: scenario.id)
def test_every_vector_conformance_scenario_against_real_qdrant(
    scenario: Scenario, qdrant_url: str
) -> None:
    client = QdrantClient(url=qdrant_url)
    physical = f"mirk_py_corpus_{uuid.uuid4().hex}"
    store = QdrantVectorStore(
        client,
        collection_name=physical,
    )
    try:
        failures = run_scenario(store, scenario)
        assert not failures, f"{scenario.id}: " + "; ".join(str(failure) for failure in failures)
    finally:
        if client.collection_exists(physical):
            client.delete_collection(physical)
        client.close()


def test_named_spaces_replace_maps_and_isolate_namespaces(store: QdrantVectorStore) -> None:
    store.ensureSpace("text", {"dimensions": 2})
    store.ensureSpace("image", {"dimensions": 3})
    store.upsert("assets", {"id": "a", "vectors": {"text": [1, 0], "image": [0, 1, 0]}})
    store.upsert("assets", {"id": "b", "vectors": {"text": [0, 1]}})
    assert store.count("assets") == 2
    assert _ids(store.search("assets", {"space": "image", "vector": [0, 1, 0]})) == ["a"]
    with pytest.raises(VectorInputError, match="dimensions"):
        store.ensureSpace("text", {"dimensions": 3})
    store.upsert("assets", {"id": "a", "vectors": {"text": [1, 0]}})
    assert store.search("assets", {"space": "image", "vector": [0, 1, 0]}) == []


def test_interrupted_migration_resumes_without_destroying_source(qdrant_url: str) -> None:
    import base64
    import hashlib
    import json
    import struct

    from mirk.vector_qdrant import migrateLegacyQdrantVectors

    client = QdrantClient(url=qdrant_url)
    source = f"mirk_py_migrate_{uuid.uuid4().hex}"
    target = source + "_new"
    client.create_collection(
        source, vectors_config=models.VectorParams(size=2, distance=models.Distance.DOT)
    )
    try:
        points: list[models.PointStruct] = []
        for identifier in ("a", "b"):
            token = json.dumps(["mirk-vector-qdrant-v1", "docs", identifier], separators=(",", ":"))
            raw = bytearray(hashlib.sha256(token.encode()).digest()[:16])
            raw[6] = (raw[6] & 0x0F) | 0x50
            raw[8] = (raw[8] & 0x3F) | 0x80
            points.append(
                models.PointStruct(
                    id=str(uuid.UUID(bytes=bytes(raw))),
                    vector=[1, 0],
                    payload={
                        "_mirk_collection": '"docs"',
                        "_mirk_id": json.dumps(identifier),
                        "_mirk_vector": base64.b64encode(struct.pack("<ff", 1, 0)).decode(),
                        "_mirk_usable": True,
                        "_mirk_has_metadata": False,
                        "_mirk_terms": [],
                    },
                )
            )
        client.upsert(source, points=points, wait=True)

        def interrupt(_progress: dict[str, object]) -> None:
            raise RuntimeError("interrupted")

        with pytest.raises(RuntimeError, match="interrupted"):
            migrateLegacyQdrantVectors(
                client,
                source_collection_name=source,
                collection_name=target,
                page_size=1,
                on_progress=interrupt,
            )
        with pytest.raises(ValueError, match="incomplete"):
            QdrantVectorStore(client, collection_name=target)
        result = migrateLegacyQdrantVectors(
            client, source_collection_name=source, collection_name=target, page_size=1
        )
        assert result.count("docs") == 2
        assert result.get("docs", "a") == {"id": "a", "vectors": {"default": [1, 0]}}
        assert client.count(source, exact=True).count == 2
    finally:
        client.delete_collection(source)
        if client.collection_exists(target):
            client.delete_collection(target)
        client.close()


def test_malformed_legacy_json_keeps_incomplete_marker_and_resumes(qdrant_url: str) -> None:
    import base64
    import json
    import struct

    from mirk.vector_qdrant import QdrantCollectionError, migrateLegacyQdrantVectors
    from mirk.vector_qdrant.wire import point_uuid

    client = QdrantClient(url=qdrant_url)
    source = f"mirk_py_bad_json_{uuid.uuid4().hex}"
    client.create_collection(
        source, vectors_config=models.VectorParams(size=2, distance=models.Distance.DOT)
    )
    payload = {
        "_mirk_collection": json.dumps("docs"),
        "_mirk_id": json.dumps("a"),
        "_mirk_vector": base64.b64encode(struct.pack("<ff", 1, 0)).decode(),
        "_mirk_usable": True,
        "_mirk_has_metadata": True,
        "_mirk_metadata": json.dumps({"kind": "legacy"}),
        "_mirk_terms": [json.dumps(["kind", "legacy"], separators=(",", ":"))],
    }
    try:
        for field, invalid in (
            ("_mirk_collection", "{invalid"),
            ("_mirk_id", "{invalid"),
            ("_mirk_metadata", "{invalid"),
            ("_mirk_metadata", "[]"),
            ("_mirk_metadata", "NaN"),
            ("_mirk_vector", base64.b64encode(bytes(9)).decode()),
        ):
            target = source + field
            damaged = {**payload, field: invalid}
            client.upsert(
                source,
                wait=True,
                points=[
                    models.PointStruct(
                        id=str(point_uuid("docs", "a")),
                        vector=[1, 0],
                        payload=damaged,
                    )
                ],
            )
            try:
                with pytest.raises(QdrantCollectionError):
                    migrateLegacyQdrantVectors(
                        client, source_collection_name=source, collection_name=target
                    )
                marker = (client.get_collection(target).config.metadata or {}).get("mirkMigration")
                assert marker == {"source": source, "complete": False}
                with pytest.raises(ValueError, match="incomplete"):
                    QdrantVectorStore(client, collection_name=target)
                original = client.retrieve(
                    source, ids=[str(point_uuid("docs", "a"))], with_payload=True
                )
                assert original[0].payload is not None
                assert original[0].payload[field] == invalid
                assert client.count(source, exact=True).count == 1
                client.upsert(
                    source,
                    wait=True,
                    points=[
                        models.PointStruct(
                            id=str(point_uuid("docs", "a")),
                            vector=[1, 0],
                            payload=payload,
                        )
                    ],
                )
                repaired = migrateLegacyQdrantVectors(
                    client, source_collection_name=source, collection_name=target
                )
                assert repaired.get("docs", "a") == {
                    "id": "a",
                    "vectors": {"default": [1, 0]},
                    "metadata": {"kind": "legacy"},
                }
                marker = (client.get_collection(target).config.metadata or {}).get("mirkMigration")
                assert marker == {"source": source, "complete": True}
            finally:
                if client.collection_exists(target):
                    client.delete_collection(target)
    finally:
        client.delete_collection(source)
        client.close()
