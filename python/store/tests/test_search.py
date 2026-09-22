"""Search port tests: what the corpus cannot express, plus the ranking parity proof.

The corpus pins behavior the two languages share. Three things live here instead:

- **Ranking parity between the in-memory reference and real FTS5.** Until the
  `search/*` scenarios land this is the only evidence that the Python reference
  ranks the way SQLite does, and it stays useful afterwards because it compares
  the two implementations directly on constructed corpora rather than on
  recorded expectations.
- **Reopen persistence and schema pinning across a close**, which a single
  in-process scenario sequence cannot reach.
- **Tokenizer behavior on Unicode categories**, where the interesting characters
  (² and Ⅷ, both `N*` but not decimal digits) are the ones a corpus of JSON
  strings would carry into FTS5's `unicode61`, which classifies them differently.

Parity cases stay ASCII on purpose: `unicode61` folds diacritics by default and
this package's tokenizer does not, a documented backend divergence rather than a
bug in either one.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from mirk.store import SqliteStore
from mirk.store.search import (
    InMemorySearchStore,
    SearchDocument,
    SearchOptions,
    SearchResult,
    sanitize_fts_query,
    search_field_order,
    tokenize,
)
from mirk.store.sqlite_search import (
    SqliteSearchFacet,
    legacy_search_docs_table,
    search_column_name,
    search_fts_table,
)

# ── Parity harness ───────────────────────────────────────────────────────────

Case = tuple[str, list[SearchDocument], str, SearchOptions]


def _sqlite_facet(path: str = ":memory:") -> tuple[SqliteSearchFacet, SqliteStore]:
    store = SqliteStore(path)
    return (SqliteSearchFacet(store), store)


def _run(
    target: InMemorySearchStore | SqliteSearchFacet,
    docs: list[SearchDocument],
    query: str,
    opts: SearchOptions,
) -> list[SearchResult]:
    target.indexMany("c", docs)
    return target.search("c", query, opts)


def _text_docs(pairs: list[tuple[str, str]]) -> list[SearchDocument]:
    return [{"id": id, "text": text} for id, text in pairs]


def _fields_docs(rows: list[tuple[str, str, str]]) -> list[SearchDocument]:
    return [{"id": id, "fields": {"title": title, "body": body}} for id, title, body in rows]


FILLER = _text_docs([(f"fill{index}", "zeta zeta") for index in range(8)])
FIELD_FILLER = _fields_docs([(f"fill{index}", "zeta", "zeta") for index in range(8)])
LONG = " ".join(["walrus"] * 60)


def _case(
    name: str,
    docs: list[SearchDocument],
    query: str,
    opts: SearchOptions | None = None,
) -> Case:
    return (name, docs, query, opts or {})


TITLE_BODY_5_1: SearchOptions = {"fieldWeights": {"title": 5, "body": 1}}
TITLE_BODY_6_1: SearchOptions = {"fieldWeights": {"title": 6, "body": 1}}
TITLE_ZERO: SearchOptions = {"fieldWeights": {"title": 0, "body": 1}}
BOTH_ZERO: SearchOptions = {"fieldWeights": {"title": 0, "body": 0}}
CAT_FILTER: SearchOptions = {"filter": {"where": {"type": "cat"}}}

PARITY_CASES: list[Case] = [
    # Term frequency: three mentions outrank one.
    _case("tf-beats-single", _text_docs([("a", "fox fox fox"), ("b", "fox")]) + FILLER, "fox"),
    # Length normalization: the same single mention in a short document wins.
    _case(
        "length-normalization",
        _text_docs([("short", "fox"), ("long", f"fox {LONG}")]) + FILLER,
        "fox",
    ),
    # Every document carries the term, so the idf floor decides the order.
    _case(
        "idf-clamped-all-docs",
        _text_docs([("a", "fox"), ("b", "fox"), ("c", "fox fox")]),
        "fox",
    ),
    # The floor again, with the most frequent document in the middle.
    _case(
        "idf-clamped-tf-order",
        _text_docs([("a", "fox"), ("b", "fox fox fox"), ("c", "fox fox")]),
        "fox",
    ),
    # Two columns, no weights: the denominator normalizes by the whole document.
    _case(
        "two-columns-unweighted",
        _fields_docs([("s", "fox", LONG), ("l", LONG, "fox")]) + FIELD_FILLER,
        "fox",
    ),
    # A weighted title hit outranks a weighted body hit.
    _case(
        "weights-title-over-body",
        _fields_docs([("t", "fox", "x y z"), ("b", "x", "fox y z")]) + FIELD_FILLER,
        "fox",
        TITLE_BODY_5_1,
    ),
    # A heavy title weight against a long body, the case the digest calls out.
    _case(
        "weights-long-body",
        _fields_docs([("title-short", "fox", LONG), ("body-short", LONG, "fox")]) + FIELD_FILLER,
        "fox",
        TITLE_BODY_6_1,
    ),
    # Fractional weights are legal weights.
    _case(
        "weights-fractional",
        _fields_docs([("t", "fox", "x"), ("b", "x", "fox")]) + FIELD_FILLER,
        "fox",
        {"fieldWeights": {"title": 0.5, "body": 2.5}},
    ),
    # A large weight does not change which documents match.
    _case(
        "weights-large",
        _fields_docs([("t", "fox", "x"), ("b", "x", "fox")]) + FIELD_FILLER,
        "fox",
        {"fieldWeights": {"title": 100, "body": 1}},
    ),
    # Zero weight: the document still matches, contributing nothing.
    _case(
        "weight-zero-one-field",
        _fields_docs([("z1", "fox", "dog"), ("z2", "dog", "fox")]) + FIELD_FILLER,
        "fox",
        TITLE_ZERO,
    ),
    # Zero on both fields: both match, both score zero, the ids decide.
    _case(
        "weight-zero-both-fields",
        _fields_docs([("z2", "fox", "dog"), ("z1", "dog", "fox")]) + FIELD_FILLER,
        "fox",
        BOTH_ZERO,
    ),
    # A repeated query token scores once per occurrence, as bm25 sums phrases.
    _case(
        "duplicate-query-token",
        _text_docs([("a", "fox fox"), ("b", "fox cat")]) + FILLER,
        "fox fox",
    ),
    # Duplicating one of two terms shifts the ranking toward the duplicated one.
    _case(
        "duplicate-one-of-two",
        _text_docs([("a", "fox cat cat"), ("b", "cat fox fox")]) + FILLER,
        "fox fox cat",
    ),
    # OR semantics: the document carrying both terms leads.
    _case(
        "or-two-terms",
        _text_docs([("a", "fox brown"), ("b", "fox"), ("c", "brown")]) + FILLER,
        "fox brown",
    ),
    # A term in no document matches nothing.
    _case("term-absent", _text_docs([("a", "fox"), ("b", "hound")]), "aardvark"),
    # One present and one absent term behave like the present term alone.
    _case("one-term-absent", _text_docs([("a", "fox"), ("b", "hound")]) + FILLER, "fox aardvark"),
    # Limit truncates the ranked list, it does not reorder it.
    _case(
        "limit-two",
        _text_docs([("a", "fox fox fox"), ("b", "fox fox"), ("c", "fox")]) + FILLER,
        "fox",
        {"limit": 2},
    ),
    # Twelve matching documents and no limit: the default of ten applies.
    _case(
        "default-limit-ten",
        _text_docs([(f"d{index:02d}", "fox") for index in range(12)]),
        "fox",
    ),
    # Identical texts inserted out of order tie on score and break by id.
    _case("id-tiebreak", _text_docs([("c", "fox"), ("a", "fox"), ("b", "fox")]) + FILLER, "fox"),
    # Code point order puts every uppercase id before every lowercase one.
    _case(
        "id-tiebreak-case",
        _text_docs([("a", "fox"), ("B", "fox"), ("A", "fox"), ("b", "fox")]) + FILLER,
        "fox",
    ),
    # Three clear relevance tiers.
    _case(
        "three-tiers",
        _text_docs(
            [
                ("high", "matcha matcha matcha tea"),
                ("mid", "matcha tea leaves and more words here"),
                ("low", f"matcha {LONG}"),
            ]
        )
        + FILLER,
        "matcha",
    ),
    # Punctuation in the query is tokenized away rather than read as syntax.
    _case(
        "query-punctuation",
        _text_docs([("a", "shell scripting guide"), ("b", "python guide")]) + FILLER,
        'shell "OR" scripting;',
    ),
    # A dotted term splits into two tokens on both sides.
    _case(
        "query-dotted-term",
        _text_docs([("a", "version v1 2 notes"), ("b", "version v2 notes")]) + FILLER,
        "v1.2",
    ),
    # An empty field value indexes as the empty string, not as a missing column.
    _case(
        "empty-field-value",
        _fields_docs([("a", "", "fox"), ("b", "fox", "")]) + FIELD_FILLER,
        "fox",
    ),
    # A meta filter narrows the ranked list.
    _case(
        "meta-filter",
        [
            {"id": "a", "text": "fox fox", "meta": {"type": "cat"}},
            {"id": "b", "text": "fox", "meta": {"type": "cat"}},
            {"id": "c", "text": "fox fox fox", "meta": {"type": "dog"}},
            *FILLER,
        ],
        "fox",
        CAT_FILTER,
    ),
    # The filter runs before the limit, so the limit applies to the survivors.
    _case(
        "meta-filter-before-limit",
        [
            {"id": "a", "text": "fox fox fox", "meta": {"type": "dog"}},
            {"id": "b", "text": "fox fox", "meta": {"type": "cat"}},
            {"id": "c", "text": "fox", "meta": {"type": "cat"}},
            *FILLER,
        ],
        "fox",
        {"limit": 1, "filter": {"where": {"type": "cat"}}},
    ),
    # A document indexed without meta is excluded by any filter.
    _case(
        "meta-filter-excludes-metaless",
        [
            {"id": "a", "text": "fox", "meta": {"type": "cat"}},
            {"id": "b", "text": "fox"},
            *FILLER,
        ],
        "fox",
        CAT_FILTER,
    ),
]


@pytest.mark.parametrize("case", PARITY_CASES, ids=[case[0] for case in PARITY_CASES])
def test_memory_ranking_matches_fts5(case: Case) -> None:
    """The in-memory reference ranks exactly as SQLite's `bm25()` does.

    Ranking order and the matching set are the contract. Scores are asserted too
    because they do in fact agree here, and a drift in either implementation is
    worth seeing before it becomes an ordering difference.
    """
    _, docs, query, opts = case
    facet, store = _sqlite_facet()
    try:
        memory_hits = _run(InMemorySearchStore(), docs, query, opts)
        sqlite_hits = _run(facet, docs, query, opts)
    finally:
        store.close()

    assert [hit["id"] for hit in memory_hits] == [hit["id"] for hit in sqlite_hits]
    assert {hit["id"] for hit in memory_hits} == {hit["id"] for hit in sqlite_hits}
    for mine, theirs in zip(memory_hits, sqlite_hits, strict=True):
        assert mine["score"] == pytest.approx(theirs["score"], rel=1e-9, abs=1e-12)
        assert mine["meta"] == theirs["meta"]


def test_parity_corpus_is_broad_enough() -> None:
    """The parity proof is only as good as its case count; hold the floor at 20."""
    assert len(PARITY_CASES) >= 20
    assert len({case[0] for case in PARITY_CASES}) == len(PARITY_CASES)


def test_zero_weight_document_still_matches() -> None:
    """A weight of zero scales a hit to nothing; it does not unmatch the document."""
    docs = _fields_docs([("z1", "fox", "dog"), ("z2", "dog", "fox")])
    opts: SearchOptions = {"fieldWeights": {"title": 0, "body": 1}}
    facet, store = _sqlite_facet()
    try:
        memory_hits = _run(InMemorySearchStore(), docs, "fox", opts)
        sqlite_hits = _run(facet, docs, "fox", opts)
    finally:
        store.close()
    assert [hit["id"] for hit in memory_hits] == ["z2", "z1"]
    assert [hit["id"] for hit in sqlite_hits] == ["z2", "z1"]
    assert memory_hits[1]["score"] == 0.0


def test_idf_clamp_orders_by_frequency_when_every_document_matches() -> None:
    """With the term everywhere the idf floor is 1e-6, not 0, so frequency still ranks."""
    docs = _text_docs([("a", "fox"), ("b", "fox fox fox"), ("c", "fox fox")])
    memory_hits = _run(InMemorySearchStore(), docs, "fox", {})
    assert [hit["id"] for hit in memory_hits] == ["b", "c", "a"]
    assert memory_hits[0]["score"] > 0


# ── Reopen persistence ───────────────────────────────────────────────────────


def test_documents_and_meta_survive_a_reopen(tmp_path: Path) -> None:
    path = str(tmp_path / "search.db")
    facet, store = _sqlite_facet(path)
    facet.index("notes", {"id": "n1", "text": "persisted fox", "meta": {"kind": "note"}})
    store.close()

    reopened_facet, reopened = _sqlite_facet(path)
    try:
        hits = reopened_facet.search("notes", "fox")
        assert [hit["id"] for hit in hits] == ["n1"]
        assert hits[0]["meta"] == {"kind": "note"}
        assert reopened_facet.search("notes", "absent") == []
    finally:
        reopened.close()


def test_field_list_stays_pinned_across_a_reopen(tmp_path: Path) -> None:
    """The schema registry row, not the in-process cache, is what pins the fields."""
    path = str(tmp_path / "fielded.db")
    facet, store = _sqlite_facet(path)
    facet.index("docs", {"id": "d1", "fields": {"title": "fox", "body": "hound"}})
    store.close()

    reopened_facet, reopened = _sqlite_facet(path)
    try:
        assert [hit["id"] for hit in reopened_facet.search("docs", "fox")] == ["d1"]
        assert [
            hit["id"]
            for hit in reopened_facet.search("docs", "fox", {"fieldWeights": {"title": 4}})
        ] == ["d1"]
        with pytest.raises(ValueError, match="was initialized with fields"):
            reopened_facet.index("docs", {"id": "d2", "text": "fox"})
        with pytest.raises(ValueError, match="was initialized with fields"):
            reopened_facet.index("docs", {"id": "d3", "fields": {"title": "fox"}})
    finally:
        reopened.close()


def test_reindex_and_remove_survive_a_reopen(tmp_path: Path) -> None:
    path = str(tmp_path / "churn.db")
    facet, store = _sqlite_facet(path)
    facet.index("c", {"id": "x", "text": "original fox"})
    facet.index("c", {"id": "x", "text": "replacement hound"})
    store.close()

    reopened_facet, reopened = _sqlite_facet(path)
    try:
        assert reopened_facet.search("c", "fox") == []
        assert [hit["id"] for hit in reopened_facet.search("c", "hound")] == ["x"]
        assert reopened_facet.remove("c", "x") is True
        assert reopened_facet.remove("c", "x") is False
        assert reopened_facet.search("c", "hound") == []
    finally:
        reopened.close()


def test_unknown_collection_needs_no_tables(tmp_path: Path) -> None:
    path = str(tmp_path / "empty.db")
    facet, store = _sqlite_facet(path)
    try:
        assert facet.remove("never-written", "x") is False
        assert facet.search("never-written", "fox") == []
        names = [
            str(row[0])
            for row in store._db.execute(  # pyright: ignore[reportPrivateUsage]
                "SELECT name FROM sqlite_master WHERE name LIKE 'search_%'"
            )
        ]
        assert names == []
    finally:
        store.close()


# ── Tokenizer ────────────────────────────────────────────────────────────────


def test_tokenizer_splits_on_unicode_categories() -> None:
    """Token characters are general category L* or N*, and nothing else."""
    assert tokenize("The Quick Brown Fox") == ["the", "quick", "brown", "fox"]
    assert tokenize("v1.2") == ["v1", "2"]
    assert tokenize("don't") == ["don", "t"]
    assert tokenize("snake_case-and.dots") == ["snake", "case", "and", "dots"]
    assert tokenize("  spaced \t out \n ") == ["spaced", "out"]
    assert tokenize("") == []
    assert tokenize("!!!") == []
    assert tokenize("🔥 emoji 🔥") == ["emoji"]


def test_tokenizer_keeps_non_decimal_numerals() -> None:
    """`No` (²) and `Nl` (Ⅷ) are numbers, so they are token characters.

    `str.isdigit` and `\\w` both get this wrong in one direction or the other,
    which is why the tokenizer reads `unicodedata.category` directly.
    """
    assert tokenize("x² area") == ["x²", "area"]
    assert tokenize("²") == ["²"]
    assert tokenize("chapter Ⅷ") == ["chapter", "ⅷ"]
    assert tokenize("½ cup") == ["½", "cup"]
    assert tokenize("Ⅷ² together") == ["ⅷ²", "together"]


def test_tokenizer_lowercases_before_splitting() -> None:
    """Greek final sigma is the case that proves lowercasing runs first."""
    assert tokenize("ΟΔΟΣ") == ["οδος"]
    assert tokenize("ΑΣ") == ["ας"]
    assert tokenize("Σοφία") == ["σοφία"]
    assert tokenize("ΑΣ ΑΣ") == ["ας", "ας"]


def test_tokenizer_treats_combining_marks_as_separators() -> None:
    """Precomposed and decomposed é are different token streams, as in TypeScript."""
    assert tokenize("café") == ["café"]
    assert tokenize("café") == ["cafe"]


def test_sanitize_builds_an_or_expression() -> None:
    assert sanitize_fts_query("fox") == '"fox"'
    assert sanitize_fts_query("quick brown fox") == '"quick" OR "brown" OR "fox"'
    assert sanitize_fts_query('shell "OR" scripting;') == '"shell" OR "or" OR "scripting"'
    assert sanitize_fts_query("   ") == ""
    assert sanitize_fts_query("!!!") == ""


# ── Field naming and validation ──────────────────────────────────────────────


def test_field_order_uses_utf16_code_units() -> None:
    """Column order has to match the TypeScript writer's, which compares code units."""
    assert search_field_order(["title", "body"]) == ["body", "title"]
    assert search_field_order(["text", "author"]) == ["author", "text"]
    # A surrogate pair leads with 0xD83D, which is below 0xFB00, so code unit
    # order and code point order disagree on exactly this pair.
    assert search_field_order(["\ufb00", "\U0001f525"]) == ["\U0001f525", "\ufb00"]
    assert sorted(["\ufb00", "\U0001f525"]) == ["\ufb00", "\U0001f525"]


def test_column_names_hash_everything_but_text() -> None:
    assert search_column_name("text", 0) == "text"
    assert search_column_name("title.with.dot", 1).startswith("f1_")
    assert search_column_name("emoji \U0001f525", 0).startswith("f0_")


def test_odd_field_names_round_trip_through_sqlite(tmp_path: Path) -> None:
    path = str(tmp_path / "odd.db")
    facet, store = _sqlite_facet(path)
    doc: SearchDocument = {
        "id": "d1",
        "fields": {"title.with.dot": "fox", "emoji \U0001f525": "hound", "text": "badger"},
    }
    facet.index("odd", doc)
    store.close()

    reopened_facet, reopened = _sqlite_facet(path)
    try:
        weights: dict[str, float] = {"title.with.dot": 3, "emoji \U0001f525": 1, "text": 1}
        for term in ("fox", "hound", "badger"):
            assert [
                hit["id"] for hit in reopened_facet.search("odd", term, {"fieldWeights": weights})
            ] == ["d1"]
    finally:
        reopened.close()


@pytest.mark.parametrize(
    ("doc", "message"),
    [
        ({"id": "x", "text": "a", "fields": {"t": "b"}}, "not both"),
        ({"id": "x"}, "must provide `text` or `fields`"),
        ({"id": "x", "fields": {}}, "at least one field"),
        ({"id": "x", "fields": {"title": 5}}, 'field "title" must be a string'),
    ],
)
def test_document_validation_messages(doc: Any, message: str) -> None:
    """Both backends raise the same message, so a corpus `throws` step matches either."""
    facet, store = _sqlite_facet()
    try:
        with pytest.raises(ValueError, match=message):
            InMemorySearchStore().index("c", doc)
        with pytest.raises(ValueError, match=message):
            facet.index("c", doc)
    finally:
        store.close()


@pytest.mark.parametrize(
    ("weights", "message"),
    [
        ({"text": -1}, "non-negative finite number"),
        ({"text": float("inf")}, "non-negative finite number"),
        ({"text": float("nan")}, "non-negative finite number"),
        ({"unknown": 1}, "Unknown search field weight"),
    ],
)
def test_weight_validation_messages(weights: dict[str, float], message: str) -> None:
    docs = _text_docs([("a", "fox")])
    facet, store = _sqlite_facet()
    try:
        memory = InMemorySearchStore()
        memory.indexMany("c", docs)
        facet.indexMany("c", docs)
        with pytest.raises(ValueError, match=message):
            memory.search("c", "fox", {"fieldWeights": weights})
        with pytest.raises(ValueError, match=message):
            facet.search("c", "fox", {"fieldWeights": weights})
    finally:
        store.close()


def test_bad_weight_values_throw_for_a_missing_collection_but_names_do_not() -> None:
    """Weight values are validated before the collection is looked up; names after."""
    facet, store = _sqlite_facet()
    try:
        for target in (InMemorySearchStore(), facet):
            with pytest.raises(ValueError, match="non-negative finite number"):
                target.search("absent", "fox", {"fieldWeights": {"text": -1}})
            assert target.search("absent", "fox", {"fieldWeights": {"text": 2}}) == []
    finally:
        store.close()


def test_meta_defaults_to_an_empty_object() -> None:
    """`meta` is always present on a result, unlike the vector port's `metadata`."""
    docs: list[SearchDocument] = [{"id": "a", "text": "fox"}]
    facet, store = _sqlite_facet()
    try:
        assert _run(InMemorySearchStore(), docs, "fox", {})[0]["meta"] == {}
        assert _run(facet, docs, "fox", {})[0]["meta"] == {}
    finally:
        store.close()


def test_collections_do_not_alias() -> None:
    facet, store = _sqlite_facet()
    try:
        for target in (InMemorySearchStore(), facet):
            target.index("a", {"id": "x", "text": "fox"})
            target.index("b", {"id": "y", "text": "fox"})
            assert [hit["id"] for hit in target.search("a", "fox")] == ["x"]
            assert [hit["id"] for hit in target.search("b", "fox")] == ["y"]
    finally:
        store.close()


# ── Physical table registry (MR-21) ──────────────────────────────────────────
# The same colliding pair as the collection tests: identical sanitized name,
# identical FNV hash, so the pre-registry docs table aliased the two.
SEARCH_COLLIDING_A = "%$;**@"
SEARCH_COLLIDING_B = "~,~$(*"
SEARCH_COLLIDING_TABLE = "search_docs________jqoxun"


def test_hash_colliding_search_collections_stay_independent(tmp_path: Path) -> None:
    path = str(tmp_path / "collide-search.db")
    facet, store = _sqlite_facet(path)
    try:
        assert legacy_search_docs_table(SEARCH_COLLIDING_A) == SEARCH_COLLIDING_TABLE
        assert legacy_search_docs_table(SEARCH_COLLIDING_B) == SEARCH_COLLIDING_TABLE
        facet.index(SEARCH_COLLIDING_A, {"id": "a1", "text": "the quick brown fox"})
        facet.index(SEARCH_COLLIDING_B, {"id": "b1", "text": "a slow grey badger"})

        assert [hit["id"] for hit in facet.search(SEARCH_COLLIDING_A, "fox")] == ["a1"]
        assert facet.search(SEARCH_COLLIDING_A, "badger") == []
        assert [hit["id"] for hit in facet.search(SEARCH_COLLIDING_B, "badger")] == ["b1"]
        assert facet.search(SEARCH_COLLIDING_B, "fox") == []

        recorded = dict(
            store.connection.execute(
                "SELECT name, table_name FROM _mirk_tables WHERE kind = 'search'"
            ).fetchall()
        )
        assert recorded == {
            SEARCH_COLLIDING_A: SEARCH_COLLIDING_TABLE,
            SEARCH_COLLIDING_B: f"{SEARCH_COLLIDING_TABLE}_2",
        }
        # The FTS index of the suffixed docs table follows its name.
        assert search_fts_table(f"{SEARCH_COLLIDING_TABLE}_2") == "search_fts________jqoxun_2"
        assert store.connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = 'search_fts________jqoxun_2'"
        ).fetchone() == (1,)
    finally:
        store.close()


def test_the_search_registry_survives_a_reopen(tmp_path: Path) -> None:
    path = str(tmp_path / "collide-search.db")
    facet, store = _sqlite_facet(path)
    facet.index(SEARCH_COLLIDING_A, {"id": "a1", "text": "the quick brown fox"})
    facet.index(SEARCH_COLLIDING_B, {"id": "b1", "text": "a slow grey badger"})
    store.close()

    reopened_facet, reopened = _sqlite_facet(path)
    try:
        # Reversed order on the new connection: the recorded mapping decides, not
        # the order of first use.
        assert [hit["id"] for hit in reopened_facet.search(SEARCH_COLLIDING_B, "badger")] == ["b1"]
        assert reopened_facet.search(SEARCH_COLLIDING_B, "fox") == []
        assert [hit["id"] for hit in reopened_facet.search(SEARCH_COLLIDING_A, "fox")] == ["a1"]
        recorded = dict(
            reopened.connection.execute(
                "SELECT name, table_name FROM _mirk_tables WHERE kind = 'search'"
            ).fetchall()
        )
        assert recorded == {
            SEARCH_COLLIDING_A: SEARCH_COLLIDING_TABLE,
            SEARCH_COLLIDING_B: f"{SEARCH_COLLIDING_TABLE}_2",
        }
    finally:
        reopened.close()


def test_a_legacy_search_file_has_its_tables_adopted(tmp_path: Path) -> None:
    """A file written before the registry keeps its docs table and gains a row for it."""
    path = str(tmp_path / "legacy-search.db")
    facet, store = _sqlite_facet(path)
    facet.index("notes", {"id": "n1", "text": "a badger writes python"})
    store.close()

    stripped = sqlite3.connect(path, isolation_level=None)
    stripped.execute("DELETE FROM _mirk_tables")
    stripped.execute("DELETE FROM _mirk_meta")
    stripped.close()

    reopened_facet, reopened = _sqlite_facet(path)
    try:
        assert [hit["id"] for hit in reopened_facet.search("notes", "badger")] == ["n1"]
        row = reopened.connection.execute(
            "SELECT table_name FROM _mirk_tables WHERE kind = 'search' AND name = 'notes'"
        ).fetchone()
        assert row is not None and row[0] == legacy_search_docs_table("notes")
    finally:
        reopened.close()


def test_an_unclaimed_search_table_on_a_suffixed_candidate_is_skipped(tmp_path: Path) -> None:
    """The docs table and its FTS index move to ``_3`` together."""
    path = str(tmp_path / "occupied-search.db")
    facet, store = _sqlite_facet(path)
    facet.index(SEARCH_COLLIDING_A, {"id": "a1", "text": "the quick brown fox"})
    store.close()

    squatter = f"{SEARCH_COLLIDING_TABLE}_2"
    connection = sqlite3.connect(path, isolation_level=None)
    connection.execute(
        f'CREATE TABLE "{squatter}" (id TEXT PRIMARY KEY, text TEXT, meta_json TEXT)'
    )
    connection.execute(f"INSERT INTO \"{squatter}\" (id, text) VALUES ('foreign', 'badger')")
    connection.close()

    reopened_facet, reopened = _sqlite_facet(path)
    try:
        reopened_facet.index(SEARCH_COLLIDING_B, {"id": "b1", "text": "a slow grey badger"})
        assert [hit["id"] for hit in reopened_facet.search(SEARCH_COLLIDING_B, "badger")] == ["b1"]
        assert [hit["id"] for hit in reopened_facet.search(SEARCH_COLLIDING_A, "fox")] == ["a1"]
        row = reopened.connection.execute(
            "SELECT table_name FROM _mirk_tables WHERE kind = 'search' AND name = ?",
            (SEARCH_COLLIDING_B,),
        ).fetchone()
        assert row is not None and row[0] == f"{SEARCH_COLLIDING_TABLE}_3"
        assert reopened.connection.execute(
            "SELECT 1 FROM sqlite_master WHERE name = ?", ("search_fts________jqoxun_3",)
        ).fetchone() == (1,)
        assert reopened.connection.execute(f'SELECT id FROM "{squatter}"').fetchall() == [
            ("foreign",)
        ]
    finally:
        reopened.close()
