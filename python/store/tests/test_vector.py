"""Vector port behaviour the language-neutral corpus cannot carry.

The corpus is JSON, so it can express neither a NaN component nor the bytes of a
stored blob nor a reopened file. Those live here, next to the two properties the
whole port rests on: components are rounded to float32 on write, and the vec0
path and the exact path return the same thing.
"""

from __future__ import annotations

import math
import random
import sqlite3
import struct
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from mirk.store.sqlite_vector import (
    NO_DIMENSIONS_MESSAGE,
    SqliteVectorFacet,
    connection_of,
    dimensions_conflict_message,
    positive_dimensions_message,
)
from mirk.store.vector import (
    InMemoryVectorStore,
    VectorDocument,
    VectorSearchOptions,
    VectorSearchResultList,
    bytes_to_vector,
    cosine_similarity,
    dimension_mismatch_message,
    is_usable_vector,
    matches_where,
    to_float32,
    vector_to_bytes,
)

RAW = [0.1, 0.2, 0.3]
ROUNDED = list(struct.unpack("<3f", struct.pack("<3f", *RAW)))


def open_facet(path: str, **kwargs: Any) -> tuple[SqliteVectorFacet, sqlite3.Connection]:
    connection = sqlite3.connect(path, isolation_level=None)
    return (SqliteVectorFacet(connection, path=path, **kwargs), connection)


@pytest.fixture
def memory_facet() -> Iterator[SqliteVectorFacet]:
    facet, connection = open_facet(":memory:", dimensions=3)
    try:
        yield facet
    finally:
        connection.close()


def ids_of(results: VectorSearchResultList) -> list[str]:
    return [result["id"] for result in results]


# ── float32 on write ─────────────────────────────────────────────────────────


def test_stored_blob_is_little_endian_float32(memory_facet: SqliteVectorFacet) -> None:
    memory_facet.upsert("c", {"id": "a", "vector": RAW})
    blob: bytes = bytes(
        memory_facet._db.execute(  # pyright: ignore[reportPrivateUsage]
            "SELECT vec FROM vectors WHERE collection = 'c' AND id = 'a'"
        ).fetchone()[0]
    )
    assert blob == struct.pack("<3f", *RAW)
    assert len(blob) == 12
    doc = memory_facet.get("c", "a")
    assert doc is not None
    assert doc["vector"] == ROUNDED
    assert doc["vector"] != RAW


def test_memory_rounds_components_on_write() -> None:
    store = InMemoryVectorStore(3)
    store.upsert("c", {"id": "a", "vector": RAW})
    doc = store.get("c", "a")
    assert doc is not None
    assert doc["vector"] == ROUNDED


def test_a_value_that_underflows_float32_stops_being_usable() -> None:
    tiny = 1e-45 / 1000
    assert is_usable_vector([tiny, 0.0]) is True
    assert is_usable_vector(to_float32([tiny, 0.0])) is False


def test_bytes_round_trip_drops_a_trailing_partial_float() -> None:
    assert bytes_to_vector(vector_to_bytes([1.0, 0.5, -0.25, 0.0])) == [1.0, 0.5, -0.25, 0.0]
    assert bytes_to_vector(vector_to_bytes([1.0, 0.5]) + b"\x00\x00") == [1.0, 0.5]
    assert bytes_to_vector(b"") == []


# ── cosine ───────────────────────────────────────────────────────────────────


def test_cosine_returns_zero_rather_than_raising() -> None:
    assert cosine_similarity([0.0, 0.0], [1.0, 0.0]) == 0.0
    assert cosine_similarity([1.0, 0.0], [1.0, 0.0, 0.0, 0.0]) == 0.0
    assert cosine_similarity([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) == pytest.approx(1.0)


def test_cosine_uses_the_two_sqrt_denominator() -> None:
    a = to_float32([0.1, 0.2, 0.3])
    b = to_float32([0.3, 0.2, 0.1])
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    an = sum(x * x for x in a)
    bn = sum(y * y for y in b)
    assert cosine_similarity(a, b) == dot / (math.sqrt(an) * math.sqrt(bn))


# ── directionless vectors ────────────────────────────────────────────────────


DIRECTIONLESS = [[float("nan"), 1.0, 0.0], [float("inf"), 1.0, 0.0], [0.0, 0.0, 0.0]]


@pytest.mark.parametrize("bad", DIRECTIONLESS)
def test_directionless_stored_vectors_are_kept_but_never_returned(bad: list[float]) -> None:
    stores: list[Any] = [InMemoryVectorStore(3)]
    facet, connection = open_facet(":memory:", dimensions=3)
    stores.append(facet)
    try:
        for store in stores:
            store.upsert("c", {"id": "good", "vector": [1.0, 0.0, 0.0]})
            store.upsert("c", {"id": "bad", "vector": bad})
            assert store.count("c") == 2
            assert store.has("c", "bad") is True
            assert store.get("c", "bad") is not None
            found = store.search("c", [1.0, 0.0, 0.0], {"minScore": -1})
            assert ids_of(found) == ["good"]
    finally:
        connection.close()


# ── metadata filter ──────────────────────────────────────────────────────────


def test_absent_metadata_never_matches_even_an_empty_filter() -> None:
    assert matches_where(None, {}) is False
    assert matches_where({}, {}) is True
    assert matches_where({"a": 1}, {}) is True


def test_metadata_equality_is_json_text_equality() -> None:
    assert matches_where({"a": {"x": 1, "y": 2}}, {"a": {"x": 1, "y": 2}}) is True
    # Key order is part of the JSON text, so it is part of the comparison.
    assert matches_where({"a": {"x": 1, "y": 2}}, {"a": {"y": 2, "x": 1}}) is False
    assert matches_where({"a": [1, 2]}, {"a": [2, 1]}) is False
    assert matches_where({"a": True}, {"a": 1}) is False
    assert matches_where({"a": None}, {"a": None}) is True
    assert matches_where({"a": 1}, {"b": 1}) is False


def test_where_not_excludes_only_when_every_condition_matches() -> None:
    store = InMemoryVectorStore(2)
    store.upsert("c", {"id": "a", "vector": [1.0, 0.0], "metadata": {"t": "cat", "c": "black"}})
    store.upsert("c", {"id": "b", "vector": [1.0, 0.0], "metadata": {"t": "cat", "c": "white"}})
    opts: VectorSearchOptions = {"whereNot": {"t": "cat", "c": "black"}}
    assert ids_of(store.search("c", [1.0, 0.0], opts)) == ["b"]


# ── ordering ─────────────────────────────────────────────────────────────────


def test_ties_break_by_code_point_not_insertion_order() -> None:
    store = InMemoryVectorStore(2)
    for id in ("c", "a", "\U0001f525", "Z", "b"):
        store.upsert("c", {"id": id, "vector": [1.0, 0.0]})
    assert ids_of(store.search("c", [1.0, 0.0])) == ["Z", "a", "b", "c", "\U0001f525"]


def test_min_score_is_applied_before_top_k(memory_facet: SqliteVectorFacet) -> None:
    memory_facet.upsert("c", {"id": "near", "vector": [1.0, 0.0, 0.0]})
    memory_facet.upsert("c", {"id": "mid", "vector": [1.0, 1.0, 0.0]})
    memory_facet.upsert("c", {"id": "far", "vector": [0.0, 0.0, 1.0]})
    opts: VectorSearchOptions = {"topK": 2, "minScore": 0.9}
    assert ids_of(memory_facet.search("c", [1.0, 0.0, 0.0], opts)) == ["near"]


# ── the two SQLite paths ─────────────────────────────────────────────────────


def test_the_facet_reports_whether_vec0_loaded(memory_facet: SqliteVectorFacet) -> None:
    forced, connection = open_facet(":memory:", dimensions=3, force_js_cosine=True)
    try:
        assert forced.meta["accelerated"] is False
    finally:
        connection.close()
    # Not an assertion about the environment: only that the flag tracks the load.
    assert isinstance(memory_facet.meta["accelerated"], bool)


def _random_corpus(seed: int, dimensions: int, size: int) -> list[VectorDocument]:
    rng = random.Random(seed)
    docs: list[VectorDocument] = []
    for index in range(size):
        scale = rng.choice([0.01, 1.0, 40.0])
        vector = [rng.uniform(-1.0, 1.0) * scale for _ in range(dimensions)]
        docs.append({"id": f"doc-{index:03d}", "vector": vector})
    return docs


def test_vec0_and_exact_paths_agree_on_random_data(tmp_path: Path) -> None:
    db = str(tmp_path / "agree.db")
    docs = _random_corpus(seed=7, dimensions=8, size=60)

    accelerated, accelerated_connection = open_facet(db, dimensions=8)
    if not accelerated.meta["accelerated"]:
        accelerated_connection.close()
        pytest.skip("sqlite-vec is not loadable in this interpreter")
    exact, exact_connection = open_facet(db, force_js_cosine=True)
    try:
        accelerated.upsertMany("c", docs)
        rng = random.Random(11)
        options: list[VectorSearchOptions] = [
            {},
            {"topK": 3},
            {"topK": 5, "minScore": 0.3},
            {"minScore": -0.2, "topK": 50},
        ]
        for trial in range(6):
            query = [rng.uniform(-1.0, 1.0) for _ in range(8)]
            for opts in options:
                fast = accelerated.search("c", query, opts)
                slow = exact.search("c", query, opts)
                assert ids_of(fast) == ids_of(slow), f"trial {trial} opts {opts}"
                for left, right in zip(fast, slow, strict=True):
                    assert left["score"] == pytest.approx(right["score"], abs=1e-6)
    finally:
        exact_connection.close()
        accelerated_connection.close()


def test_removal_and_replacement_keep_the_vec0_mirror_in_step(tmp_path: Path) -> None:
    db = str(tmp_path / "mirror.db")
    facet, connection = open_facet(db, dimensions=3)
    try:
        facet.upsert("c", {"id": "a", "vector": [1.0, 0.0, 0.0]})
        facet.upsert("c", {"id": "b", "vector": [0.0, 1.0, 0.0]})
        facet.upsert("c", {"id": "a", "vector": [0.0, 0.0, 1.0]})
        assert ids_of(facet.search("c", [0.0, 0.0, 1.0], {"minScore": 0.99})) == ["a"]
        assert facet.remove("c", "a") is True
        assert facet.remove("c", "a") is False
        assert ids_of(facet.search("c", [0.0, 0.0, 1.0], {"minScore": -1})) == ["b"]
        assert facet.count("c") == 1
    finally:
        connection.close()


def test_a_fallback_written_file_is_backfilled_into_vec0(tmp_path: Path) -> None:
    db = str(tmp_path / "backfill.db")
    written, write_connection = open_facet(db, dimensions=3, force_js_cosine=True)
    written.upsert("c", {"id": "a", "vector": [1.0, 0.0, 0.0]})
    written.upsert("c", {"id": "zero", "vector": [0.0, 0.0, 0.0]})
    write_connection.close()

    reopened, read_connection = open_facet(db)
    try:
        if not reopened.meta["accelerated"]:
            pytest.skip("sqlite-vec is not loadable in this interpreter")
        assert ids_of(reopened.search("c", [1.0, 0.0, 0.0], {"minScore": -1})) == ["a"]
    finally:
        read_connection.close()


# ── dimensions ───────────────────────────────────────────────────────────────


def test_dimensions_persist_across_a_reopen(tmp_path: Path) -> None:
    db = str(tmp_path / "dims.db")
    first, first_connection = open_facet(db)
    assert first.meta["dimensions"] == 0
    first.upsert("c", {"id": "a", "vector": [1.0, 0.0, 0.0, 0.0]})
    assert first.meta["dimensions"] == 4
    first_connection.close()

    second, second_connection = open_facet(db)
    try:
        assert second.meta["dimensions"] == 4
        with pytest.raises(ValueError) as mismatch:
            second.upsert("c", {"id": "b", "vector": [1.0, 0.0, 0.0]})
        assert str(mismatch.value) == dimension_mismatch_message(4, 3)
        doc = second.get("c", "a")
        assert doc is not None and doc["vector"] == [1.0, 0.0, 0.0, 0.0]
    finally:
        second_connection.close()

    with pytest.raises(ValueError) as conflict:
        open_facet(db, dimensions=3)
    assert str(conflict.value) == dimensions_conflict_message(db, 4, 3)


def test_search_before_any_dimensions_are_known_raises() -> None:
    facet, connection = open_facet(":memory:")
    try:
        with pytest.raises(ValueError) as info:
            facet.search("c", [1.0, 0.0, 0.0])
        assert str(info.value) == NO_DIMENSIONS_MESSAGE
        assert facet.meta["dimensions"] == 0
    finally:
        connection.close()


def test_zero_dimensions_are_rejected() -> None:
    facet, connection = open_facet(":memory:")
    try:
        with pytest.raises(ValueError) as info:
            facet.configure_dimensions(0)
        assert str(info.value) == positive_dimensions_message(0)
    finally:
        connection.close()


def test_a_failed_upsert_many_persists_neither_rows_nor_dimensions(tmp_path: Path) -> None:
    db = str(tmp_path / "atomic.db")
    facet, connection = open_facet(db)
    try:
        with pytest.raises(ValueError):
            facet.upsertMany(
                "c",
                [
                    {"id": "a", "vector": [1.0, 0.0, 0.0]},
                    {"id": "b", "vector": [1.0, 0.0]},
                ],
            )
        assert facet.count("c") == 0
        assert facet.meta["dimensions"] == 0
        facet.upsertMany("c", [{"id": "c", "vector": [1.0, 0.0]}])
        assert facet.meta["dimensions"] == 2
    finally:
        connection.close()


def test_a_mid_array_mismatch_inserts_nothing_in_memory() -> None:
    store = InMemoryVectorStore(2)
    store.upsert("c", {"id": "kept", "vector": [1.0, 0.0]})
    with pytest.raises(ValueError):
        store.upsertMany(
            "c",
            [
                {"id": "a", "vector": [0.0, 1.0]},
                {"id": "b", "vector": [0.0, 1.0, 0.0]},
            ],
        )
    assert store.count("c") == 1
    assert store.has("c", "a") is False


def test_an_empty_upsert_many_touches_nothing() -> None:
    facet, connection = open_facet(":memory:")
    try:
        facet.upsertMany("c", [])
        assert facet.meta["dimensions"] == 0
        assert facet.count("c") == 0
    finally:
        connection.close()


# ── wiring ───────────────────────────────────────────────────────────────────


def test_connection_of_reaches_the_store_handle(tmp_path: Path) -> None:
    from mirk.store import SqliteStore

    store = SqliteStore(str(tmp_path / "handle.db"))
    try:
        assert isinstance(connection_of(store), sqlite3.Connection)
    finally:
        store.close()
    with pytest.raises(TypeError):
        connection_of(object())
