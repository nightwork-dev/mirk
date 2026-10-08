from __future__ import annotations

import math
import os
import uuid
from collections.abc import Iterator, Sequence
from typing import Any, cast

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


def _dimensions_for(scenario: Scenario) -> int:
    for step in scenario.steps:
        raw_args = step.get("args")
        args = cast(list[Any], raw_args) if isinstance(raw_args, list) else None
        if not isinstance(args, list):
            continue
        op = str(step.get("op", ""))
        if op in {"upsert", "search"} and len(args) >= 2:
            value: Any = args[1]
            if op == "upsert" and isinstance(value, dict):
                vector: Any = cast(dict[str, Any], value).get("vector")
            else:
                vector = value
            if isinstance(vector, list):
                return len(cast(list[Any], vector))
        if op == "upsertMany" and len(args) >= 2 and isinstance(args[1], list):
            for document in cast(list[Any], args[1]):
                if isinstance(document, dict):
                    document_obj = cast(dict[str, Any], document)
                    vector = document_obj.get("vector")
                    if isinstance(vector, list):
                        return len(cast(list[Any], vector))
    raise AssertionError(f"vector scenario has no vector dimensions: {scenario.id}")


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
    value = QdrantVectorStore(client, collection_name=name, dimensions=2, page_size=2)
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
                "vector": [1.0, 0.0],
                "metadata": {"nested": {"a": 1, "b": 2}, "tags": ["a", None]},
            },
            {"id": "a", "vector": [1.0, 0.0]},
            {"id": "other", "vector": [1.0, 0.0], "metadata": {"kind": "other"}},
        ],
    )
    store.upsert("other", {"id": "same", "vector": [1.0, 0.0]})

    assert store.count("notes") == 3
    assert store.count("other") == 1
    assert store.get("notes", "b") == {
        "id": "b",
        "vector": [1.0, 0.0],
        "metadata": {"nested": {"a": 1, "b": 2}, "tags": ["a", None]},
    }
    assert store.get("notes", "missing") is None
    assert _ids(store.search("notes", [1.0, 0.0], {"topK": 10})) == ["a", "b", "other"]
    assert _ids(
        store.search(
            "notes",
            [1.0, 0.0],
            {"where": {"nested": {"a": 1, "b": 2}, "tags": ["a", None]}},
        )
    ) == ["b"]
    assert store.search("notes", [1.0, 0.0], {"where": {"nested": {"b": 2, "a": 1}}}) == []
    assert _ids(store.search("notes", [1.0, 0.0], {"whereNot": {}})) == ["a"]

    reopened_client = QdrantClient(url=qdrant_url)
    try:
        reopened = QdrantVectorStore(
            reopened_client,
            collection_name=store._collection_name,  # pyright: ignore[reportPrivateUsage]
            dimensions=2,
            page_size=2,
        )
        assert reopened.get("notes", "b") == store.get("notes", "b")
        assert reopened.count("notes") == 3
    finally:
        reopened_client.close()


def test_wire_tokens_preserve_lone_surrogates(store: QdrantVectorStore) -> None:
    scope = "scope-\ud800"
    identifier = "id-\udcff"
    store.upsert(scope, {"id": identifier, "vector": [1.0, 0.0], "metadata": {"x": "\ud800"}})
    assert store.count(scope) == 1
    assert store.get(scope, identifier) == {
        "id": identifier,
        "vector": [1.0, 0.0],
        "metadata": {"x": "\ud800"},
    }
    assert _ids(store.search(scope, [1.0, 0.0], {"where": {"x": "\ud800"}})) == [identifier]


def test_numeric_metadata_keys_follow_json_wire_order(store: QdrantVectorStore) -> None:
    metadata = {"2": "b", "1": "a", "other": "c"}
    store.upsert("numeric-keys", {"id": "one", "vector": [1.0, 0.0], "metadata": metadata})
    assert store.get("numeric-keys", "one") == {
        "id": "one",
        "vector": [1.0, 0.0],
        "metadata": {"1": "a", "2": "b", "other": "c"},
    }
    assert _ids(
        store.search("numeric-keys", [1.0, 0.0], {"where": {"1": "a", "2": "b"}})
    ) == ["one"]


def test_float32_payload_preserves_unusable_vectors_and_query_rules(
    store: QdrantVectorStore,
) -> None:
    store.upsertMany(
        "vectors",
        [
            {"id": "good", "vector": [1.0, 0.0]},
            {"id": "zero", "vector": [0.0, 0.0]},
            {"id": "nan", "vector": [math.nan, 1.0]},
            {"id": "inf", "vector": [math.inf, 1.0]},
        ],
    )
    assert store.count("vectors") == 4
    assert _ids(store.search("vectors", [1.0, 0.0], {"minScore": -1})) == ["good"]
    zero = store.get("vectors", "zero")
    nan = store.get("vectors", "nan")
    inf = store.get("vectors", "inf")
    assert zero is not None and zero["vector"] == [0.0, 0.0]
    assert nan is not None and math.isnan(nan["vector"][0])
    assert inf is not None and math.isinf(inf["vector"][0])
    assert _ids(store.search("vectors", [0.0, 0.0])) == ["good"]
    assert store.search("vectors", [math.nan, 1.0]) == []


def test_upsert_many_validates_every_document_before_mutation(store: QdrantVectorStore) -> None:
    store.upsert("atomic", {"id": "kept", "vector": [1.0, 0.0]})
    with pytest.raises(VectorInputError) as error:
        store.upsertMany(
            "atomic",
            [
                {"id": "new", "vector": [0.0, 1.0]},
                {"id": "bad", "vector": [1.0, 0.0, 0.0]},
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
            {"id": identifier, "vector": [1.0, 0.0]}
            for identifier in ("c", "a", "e", "b", "d")
        ],
    )
    assert _ids(store.search("ties", [1.0, 0.0], {"topK": 3})) == ["a", "b", "c"]
    assert _ids(store.search("ties", [1.0, 0.0], {"topK": 10})) == ["a", "b", "c", "d", "e"]


def test_existing_collection_configuration_is_validated(qdrant_url: str) -> None:
    client = QdrantClient(url=qdrant_url)
    name = f"mirk_py_test_{uuid.uuid4().hex}"
    client.create_collection(
        collection_name=name,
        vectors_config=models.VectorParams(size=3, distance=models.Distance.COSINE),
    )
    try:
        with pytest.raises(ValueError, match="incompatible vector config"):
            QdrantVectorStore(client, collection_name=name, dimensions=2)
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
        with pytest.raises(ValueError, match="float32"):
            QdrantVectorStore(client, collection_name=datatype_name, dimensions=2)
    finally:
        client.delete_collection(datatype_name)

    index_name = f"mirk_py_test_{uuid.uuid4().hex}"
    client.create_collection(
        collection_name=index_name,
        vectors_config=models.VectorParams(size=2, distance=models.Distance.DOT),
    )
    client.create_payload_index(
        collection_name=index_name,
        field_name="_mirk_collection",
        field_schema=models.PayloadSchemaType.INTEGER,
    )
    try:
        with pytest.raises(ValueError, match="payload index"):
            QdrantVectorStore(client, collection_name=index_name, dimensions=2)
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
        dimensions=_dimensions_for(scenario),
    )
    try:
        failures = run_scenario(store, scenario)
        assert not failures, f"{scenario.id}: " + "; ".join(str(failure) for failure in failures)
    finally:
        if client.collection_exists(physical):
            client.delete_collection(physical)
        client.close()
