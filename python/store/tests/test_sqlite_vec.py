from __future__ import annotations

import random
import sqlite3

import pytest

from mirk.store.sqlite_vec import SqliteVecError, sqlite_vec_engine
from mirk.store.vector import (
    VectorSearchOptions,
    VectorSearchResultList,
    score_of,
    to_float32,
    vector_to_bytes,
)

pytest.importorskip("mirk_sqlite_vec_native")


def test_native_scoring_and_boundaries() -> None:
    db = sqlite3.connect(":memory:")
    engine = sqlite_vec_engine()
    engine.initialize(db)
    db.executescript(
        "CREATE TABLE _mirk_vector_values(namespace,collection,id,space,vec);"
        "CREATE TABLE _mirk_vector_documents(namespace,collection,id,metadata);"
    )
    vectors: list[list[float]] = [[1, 0.0001, 0], [1, 0, 0], [1e30, 0, 0], [1e-30, 0, 0],
               [0, 0, 0], [float("nan"), 0, 0], [float("inf"), 0, 0]]
    generator = random.Random(41)
    vectors.extend([[generator.uniform(-1, 1) for _ in range(3)] for _ in range(100)])
    vectors.extend([[2.0**-149, 0, 0], [3.4028234663852886e38, 0, 0]])
    rounded = [to_float32(v) for v in vectors]
    for index, vector in enumerate(rounded):
        identifier = f"{index:03}"
        db.execute("INSERT INTO _mirk_vector_values VALUES('default','test',?,'x',?)",
                   (identifier, vector_to_bytes(vector)))
        db.execute("INSERT INTO _mirk_vector_documents VALUES('default','test',?,NULL)",
                   (identifier,))
    for query in [[1.0, 0.0, 0.0], [0.0, 0.0, 0.0], [1e-30, 0.0, 0.0]]:
        query = to_float32(query)
        for floor in [None, 1.0, 0.0]:
            expected: VectorSearchResultList = []
            for index, vector in enumerate(rounded):
                score = score_of(query, vector, floor)
                if score is not None:
                    expected.append({"id": f"{index:03}", "score": score})
            expected.sort(key=lambda hit: (-hit["score"], hit["id"]))
            for top_k in [1, 10, -1]:
                options: VectorSearchOptions = {"topK": top_k}
                if floor is not None:
                    options["minScore"] = floor
                actual = engine.search(db, "default", "test", "x", query, options)
                assert actual == expected[:top_k]
    db.execute("DROP TABLE _mirk_vector_values")
    with pytest.raises(SqliteVecError, match="search failed"):
        engine.search(db, "default", "test", "x", [1.0, 0.0, 0.0])
    db.close()


def test_initialization_failure_is_visible() -> None:
    db = sqlite3.connect(":memory:")
    db.close()
    with pytest.raises(SqliteVecError, match="initialization failed"):
        sqlite_vec_engine().initialize(db)


def test_shared_vector_corpus_through_extension() -> None:
    from mirk.store.conformance import corpus_dir, load_scenarios, run_scenario
    from mirk.store.sqlite_vector import SqliteVectorFacet

    scenarios = [scenario for scenario in load_scenarios(corpus_dir())
                 if "vector" in scenario.ports]
    assert scenarios
    for scenario in scenarios:
        db = sqlite3.connect(":memory:")
        try:
            facet = SqliteVectorFacet(db, vector_engine=sqlite_vec_engine())
            assert facet.meta["accelerated"]
            assert not run_scenario(facet, scenario), scenario.id
        finally:
            db.close()


@pytest.mark.parametrize(
    "limit,expected",
    [
        (2.5, ["a", "b"]),
        (-2.5, ["a"]),
        (0.5, []),
        (-0.5, []),
        (float("nan"), []),
        (float("inf"), ["a", "b", "c"]),
        (float("-inf"), []),
        (1e100, ["a", "b", "c"]),
        (-1e100, []),
    ],
)
def test_limit_normalization_across_engines(limit: float, expected: list[str]) -> None:
    from mirk.store.sqlite_vector import SqliteVectorFacet
    from mirk.store.vector import InMemoryVectorStore, VectorStore

    for kind in ["memory", "sqlite", "native"]:
        db = sqlite3.connect(":memory:")
        try:
            store: VectorStore = (
                InMemoryVectorStore()
                if kind == "memory"
                else SqliteVectorFacet(
                    db, vector_engine=sqlite_vec_engine() if kind == "native" else None
                )
            )
            store.ensureSpace("default", {"dimensions": 1})
            for identifier in ["a", "b", "c"]:
                store.upsert("docs", {"id": identifier, "vectors": {"default": [1.0]}})
            actual = store.search("docs", {"space": "default", "vector": [1.0]}, {"topK": limit})
            assert [hit["id"] for hit in actual] == expected, kind
        finally:
            db.close()
