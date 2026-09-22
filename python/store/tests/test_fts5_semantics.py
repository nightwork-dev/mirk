"""The probe that settled what SQLite's `bm25()` actually computes.

Both the plan brief and `docs/python-port/digests/store-vector-search.md` section
B.5 described FTS5's ranking in ways real FTS5 contradicts. This file is the
probe that found that, promoted from a scratchpad script into the suite so the
finding is re-checked on every run rather than remembered.

It talks to `sqlite3` directly rather than through `SqliteSearchFacet`, building
the same FTS5 layout the facet builds. That independence is the point: the
in-memory reference is checked against the facet in `test_search.py`, and the
facet's own layout is checked against a hand-built one here, so neither test can
launder an error in the other.

Each fact is asserted twice: the candidate formula reproduces FTS5's score, and
the rejected alternative does not. A probe that cannot fail proves nothing.

Reference: `docs/evidence/python-port/2026-09-01-fts5-bm25-probe.md`.
"""

from __future__ import annotations

import math
import sqlite3

import pytest

K1 = 1.2
B = 0.75
IDF_FLOOR = 1e-6

Doc = tuple[str, list[str]]


def _tokens(text: str) -> list[str]:
    return [token for token in text.lower().split() if token]


def _fts_scores(
    docs: list[Doc], columns: list[str], match: str, weights: list[float]
) -> list[tuple[str, float]]:
    """Score a corpus with real FTS5, in the layout the sqlite facet uses."""
    connection = sqlite3.connect(":memory:")
    try:
        column_defs = ", ".join(f'"{name}" TEXT NOT NULL' for name in columns)
        column_refs = ", ".join(f'"{name}"' for name in columns)
        new_refs = ", ".join(f'new."{name}"' for name in columns)
        connection.executescript(
            f"""
            CREATE TABLE d (id TEXT PRIMARY KEY, {column_defs});
            CREATE VIRTUAL TABLE f USING fts5(
              {column_refs}, content='d', content_rowid='rowid', tokenize='unicode61'
            );
            CREATE TRIGGER d_ai AFTER INSERT ON d BEGIN
              INSERT INTO f(rowid, {column_refs}) VALUES (new.rowid, {new_refs});
            END;
            """
        )
        placeholders = ", ".join("?" * len(columns))
        for doc_id, values in docs:
            connection.execute(
                f"INSERT INTO d(id, {column_refs}) VALUES (?, {placeholders})", (doc_id, *values)
            )
        weight_args = "".join(f", {float(weight)}" for weight in weights)
        rows = connection.execute(
            f"SELECT d.id, bm25(f{weight_args}) FROM f JOIN d ON d.rowid = f.rowid"
            f" WHERE f MATCH ? ORDER BY bm25(f{weight_args}), d.id",
            (match,),
        ).fetchall()
        return [(str(row[0]), -float(row[1])) for row in rows]
    finally:
        connection.close()


def _whole_document(
    docs: list[Doc],
    columns: list[str],
    terms: list[str],
    weights: list[float],
    *,
    floor: float = IDF_FLOOR,
) -> list[tuple[str, float]]:
    """The candidate that wins: whole-document length normalization, weighted tf."""
    n = len(docs)
    tokens = {doc_id: [_tokens(value) for value in values] for doc_id, values in docs}
    total = sum(sum(len(column) for column in tokens[doc_id]) for doc_id in tokens)
    avgdl = total / n if n else 0.0
    out: list[tuple[str, float]] = []
    for doc_id, _ in docs:
        matched = False
        score = 0.0
        dl = sum(len(column) for column in tokens[doc_id])
        for term in terms:
            df = sum(1 for other in tokens if any(term in column for column in tokens[other]))
            if df == 0 or not any(term in column for column in tokens[doc_id]):
                continue
            matched = True
            weighted_tf = sum(
                weights[index] * tokens[doc_id][index].count(term) for index in range(len(columns))
            )
            idf = math.log((n - df + 0.5) / (df + 0.5))
            if idf <= 0:
                idf = floor
                if floor == 0:
                    continue
            denominator = weighted_tf + K1 * (1 - B + B * (dl / avgdl if avgdl else 0.0))
            score += idf * (weighted_tf * (K1 + 1)) / denominator
        if matched:
            out.append((doc_id, score))
    out.sort(key=lambda row: (-row[1], row[0]))
    return out


def _per_column(
    docs: list[Doc], columns: list[str], terms: list[str], weights: list[float]
) -> list[tuple[str, float]]:
    """The candidate the brief described: per-column tf and per-column average length."""
    n = len(docs)
    tokens = {doc_id: [_tokens(value) for value in values] for doc_id, values in docs}
    column_avg = [
        sum(len(tokens[doc_id][index]) for doc_id in tokens) / n if n else 0.0
        for index in range(len(columns))
    ]
    out: list[tuple[str, float]] = []
    for doc_id, _ in docs:
        matched = False
        score = 0.0
        for term in terms:
            df = sum(1 for other in tokens if any(term in column for column in tokens[other]))
            if df == 0:
                continue
            idf = math.log((n - df + 0.5) / (df + 0.5))
            idf = max(idf, 0.0)
            for index in range(len(columns)):
                tf = tokens[doc_id][index].count(term)
                if tf == 0:
                    continue
                matched = True
                length = len(tokens[doc_id][index])
                average = column_avg[index]
                denominator = tf + K1 * (1 - B + B * (length / average if average else 0.0))
                score += weights[index] * idf * (tf * (K1 + 1)) / denominator
        if matched:
            out.append((doc_id, score))
    out.sort(key=lambda row: (-row[1], row[0]))
    return out


FILLER_1 = [(f"fill{index}", ["zeta"]) for index in range(8)]
FILLER_2 = [(f"fill{index}", ["zeta", "zeta"]) for index in range(8)]
LONG = " ".join(["walrus"] * 40)


def _assert_scores(actual: list[tuple[str, float]], expected: list[tuple[str, float]]) -> None:
    assert [row[0] for row in actual] == [row[0] for row in expected]
    for got, want in zip(actual, expected, strict=True):
        assert got[1] == pytest.approx(want[1], rel=1e-12, abs=1e-15)


def test_length_normalization_is_over_the_whole_document() -> None:
    """FTS5's `D` is the row's total token count across columns, not per column.

    The digest and the brief both said per column. A two-column corpus where the
    hit sits in the short column of one document and the long column of the other
    separates the two: whole-document normalization scores them equally, per
    column does not.
    """
    docs: list[Doc] = [("s", ["fox", LONG]), ("l", [LONG, "fox"]), *FILLER_2]
    columns = ["a", "b"]
    actual = _fts_scores(docs, columns, "fox", [1.0, 1.0])

    _assert_scores(actual, _whole_document(docs, columns, ["fox"], [1.0, 1.0]))

    rejected = _per_column(docs, columns, ["fox"], [1.0, 1.0])
    assert [row[1] for row in rejected] != pytest.approx([row[1] for row in actual])
    assert rejected[0][1] > actual[0][1] * 3


def test_weighted_term_frequency_enters_before_the_denominator() -> None:
    docs: list[Doc] = [("t", ["fox", "x y z"]), ("b", ["x", "fox y z"]), *FILLER_2]
    columns = ["a", "b"]
    weights = [5.0, 1.0]
    actual = _fts_scores(docs, columns, "fox", weights)
    _assert_scores(actual, _whole_document(docs, columns, ["fox"], weights))
    assert [row[0] for row in actual] == ["t", "b"]


def test_idf_is_floored_at_1e_6_not_dropped() -> None:
    """A term in every document still ranks by frequency, so the floor is positive.

    With the floor at zero every matching document scores 0 and the order
    collapses to the id tie-break, which is not what FTS5 does.
    """
    docs: list[Doc] = [("a", ["fox"]), ("b", ["fox fox fox"]), ("c", ["fox fox"])]
    columns = ["text"]
    actual = _fts_scores(docs, columns, "fox", [1.0])

    assert [row[0] for row in actual] == ["b", "c", "a"]
    assert actual[0][1] > 0
    _assert_scores(actual, _whole_document(docs, columns, ["fox"], [1.0]))

    dropped = _whole_document(docs, columns, ["fox"], [1.0], floor=0)
    assert [row[0] for row in dropped] == ["a", "b", "c"]
    assert {row[1] for row in dropped} == {0.0}


def test_duplicate_query_phrases_are_counted_twice() -> None:
    """`bm25()` sums over MATCH phrases, so `"fox" OR "fox"` doubles the score."""
    docs: list[Doc] = [("a", ["fox fox"]), ("b", ["fox cat"]), *FILLER_1]
    columns = ["text"]
    single = _fts_scores(docs, columns, '"fox"', [1.0])
    doubled = _fts_scores(docs, columns, '"fox" OR "fox"', [1.0])

    assert [row[0] for row in doubled] == [row[0] for row in single]
    for twice, once in zip(doubled, single, strict=True):
        assert twice[1] == pytest.approx(once[1] * 2, rel=1e-12)
    _assert_scores(doubled, _whole_document(docs, columns, ["fox", "fox"], [1.0]))


def test_duplicating_one_of_two_terms_changes_the_ranking() -> None:
    """Deduplicating query tokens is therefore observable, not just a score scale."""
    docs: list[Doc] = [("a", ["fox cat cat"]), ("b", ["cat fox fox"]), *FILLER_1]
    columns = ["text"]
    plain = _fts_scores(docs, columns, '"fox" OR "cat"', [1.0])
    weighted = _fts_scores(docs, columns, '"fox" OR "fox" OR "cat"', [1.0])
    assert [row[0] for row in plain] == ["a", "b"]
    assert [row[0] for row in weighted] == ["b", "a"]


def test_a_zero_weighted_hit_still_matches() -> None:
    """MATCH runs before the weights, so a zero weight scores 0 rather than unmatching."""
    docs: list[Doc] = [("z1", ["fox", "dog"]), ("z2", ["dog", "fox"]), *FILLER_2]
    actual = _fts_scores(docs, ["a", "b"], "fox", [0.0, 1.0])
    assert [row[0] for row in actual] == ["z2", "z1"]
    assert actual[1][1] == 0.0
