"""Full-text search port: the ``SearchStore`` Protocol and its in-memory reference.

Ranking is bm25 with the FTS5 default parameters (k1 = 1.2, b = 0.75). The
reference reproduces what SQLite's ``bm25()`` actually computes, verified
against a real FTS5 table in ``tests/test_search.py``:

- length normalization is over the whole document, not per column, and the term
  frequency is weighted before the row-level denominator is applied;
- a duplicated query token is scored once per occurrence, because ``bm25()``
  sums over MATCH phrases and ``"fox" OR "fox"`` is two phrases;
- the inverse document frequency is clamped to ``1e-6``, not to zero, so a term
  carried by every document still ranks by term frequency;
- a document matches when any field contains a query term, whatever that
  field's weight, because FTS5's MATCH runs before any weight is applied.

The cross-backend contract is ranking order and the matching set. Exact float
scores are not contractual, though this reference in fact reproduces FTS5's to
within one unit in the last place.
"""

from __future__ import annotations

import math
import unicodedata
from typing import Any, Protocol, TypedDict, cast, runtime_checkable

from .filter import matches_where
from .types import StoreFilter

__all__ = [
    "DEFAULT_SEARCH_FIELD",
    "IDF_FLOOR",
    "K1",
    "B",
    "InMemorySearchStore",
    "SearchDocument",
    "SearchOptions",
    "SearchResult",
    "SearchStore",
    "assert_same_search_fields",
    "assert_valid_field_weight_values",
    "conformance_target",
    "field_weights_for",
    "normalize_search_document",
    "sanitize_fts_query",
    "search_field_order",
    "tokenize",
]

DEFAULT_SEARCH_FIELD = "text"
K1 = 1.2
B = 0.75
IDF_FLOOR = 1e-6
"""FTS5's floor for a non-positive idf. It is 1e-6, not 0, and the difference is
observable in ranking: a term present in every document still orders by term
frequency instead of collapsing to an id tie-break."""


class SearchDocument(TypedDict, total=False):
    """A document to index. Provide either ``text`` or ``fields``, never both."""

    id: str
    text: str
    fields: dict[str, str]
    meta: dict[str, Any]


class SearchOptions(TypedDict, total=False):
    """Query options. Only ``filter.where`` is read; sorting and offset are not."""

    limit: float
    filter: StoreFilter
    fieldWeights: dict[str, float]


class SearchResult(TypedDict):
    """A ranked hit. ``meta`` is always present, ``{}`` when none was indexed."""

    id: str
    score: float
    meta: dict[str, Any]


@runtime_checkable
class SearchStore(Protocol):
    """A synchronous bm25 search store. Method names keep the TypeScript spelling."""

    def index(self, collection: str, doc: SearchDocument) -> None: ...
    def indexMany(self, collection: str, docs: list[SearchDocument]) -> None: ...
    def remove(self, collection: str, id: str) -> bool: ...
    def search(
        self, collection: str, query: str, opts: SearchOptions | None = None
    ) -> list[SearchResult]: ...


# ── Tokenizer ────────────────────────────────────────────────────────────────


def tokenize(text: Any) -> list[str]:
    """Lowercase, then split into maximal runs of Unicode letters and numbers.

    The token class is general category ``L*`` or ``N*``, which is wider than
    ``str.isalnum`` in one direction and narrower in another: ``Nl`` (Ⅷ) and
    ``No`` (²) are token characters, combining marks are separators. Written
    against ``unicodedata`` rather than a regex so the package keeps its zero
    runtime dependencies; ``re`` has no Unicode property classes.
    """
    if not text or not isinstance(text, str):
        return []
    tokens: list[str] = []
    current: list[str] = []
    for char in text.lower():
        if unicodedata.category(char)[0] in ("L", "N"):
            current.append(char)
        elif current:
            tokens.append("".join(current))
            current = []
    if current:
        tokens.append("".join(current))
    return tokens


def sanitize_fts_query(query: str) -> str:
    """Turn a raw query into an FTS5 MATCH expression: quoted tokens ORed together.

    Returns ``""`` for a query with no tokens; callers treat that as no results.
    A token can never contain a quote, so the doubling is defensive.
    """
    tokens = tokenize(query)
    if not tokens:
        return ""
    return " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens)


# ── Field normalization ──────────────────────────────────────────────────────


def _utf16_units(value: str) -> tuple[int, ...]:
    """The string as UTF-16 code units, the order JavaScript's ``<`` compares in.

    Field order fixes the physical column order of a collection's SQLite tables,
    so it has to agree with the TypeScript writer for an astral-plane field name
    too, where code point order and code unit order disagree.
    """
    encoded = value.encode("utf-16-le")
    return tuple(encoded[index] | (encoded[index + 1] << 8) for index in range(0, len(encoded), 2))


def search_field_order(names: list[str]) -> list[str]:
    """Sort field names the way the TypeScript normalizer does."""
    return sorted(names, key=_utf16_units)


def normalize_search_document(doc: SearchDocument) -> tuple[list[str], dict[str, str]]:
    """Reduce a document to its sorted field names and their values."""
    record: dict[str, Any] = dict(doc)
    has_text = "text" in record
    has_fields = "fields" in record
    if has_text and has_fields:
        raise ValueError("SearchDocument must provide either `text` or `fields`, not both.")
    if has_text:
        return ([DEFAULT_SEARCH_FIELD], {DEFAULT_SEARCH_FIELD: record["text"]})
    if not has_fields:
        raise ValueError("SearchDocument must provide `text` or `fields`.")
    fields: dict[str, Any] = record["fields"]
    names = search_field_order(list(fields.keys()))
    if not names:
        raise ValueError("SearchDocument.fields must contain at least one field.")
    values: dict[str, str] = {}
    for name in names:
        value = fields[name]
        if not isinstance(value, str):
            raise ValueError(f'SearchDocument field "{name}" must be a string.')
        values[name] = value
    return (names, values)


def assert_same_search_fields(existing: list[str], incoming: list[str], collection: str) -> None:
    """A collection is pinned to the field list of its first document."""
    if existing != incoming:
        raise ValueError(
            f'Search collection "{collection}" was initialized with fields '
            f"[{', '.join(existing)}], got [{', '.join(incoming)}]."
        )


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def assert_valid_field_weight_values(weights: dict[str, float] | None) -> None:
    """Every weight must be a finite, non-negative number. Zero is allowed."""
    for field, weight in (weights or {}).items():
        if not _is_number(weight) or not math.isfinite(weight) or weight < 0:
            raise ValueError(
                f'Search field weight for "{field}" must be a non-negative finite number.'
            )


def field_weights_for(fields: list[str], weights: dict[str, float] | None) -> list[float]:
    """One weight per collection field, in field order. Unlisted fields weigh 1.

    Weight *values* are validated before the field names, which is why a bad
    weight throws even for a collection that does not exist while an unknown
    field name does not.
    """
    assert_valid_field_weight_values(weights)
    known = set(fields)
    for field in weights or {}:
        if field not in known:
            raise ValueError(f'Unknown search field weight "{field}".')
    return [float((weights or {}).get(field, 1)) for field in fields]


# ── In-memory reference ──────────────────────────────────────────────────────


class _IndexedDoc:
    __slots__ = ("dl", "id", "meta", "terms", "tf_by_field")

    def __init__(
        self,
        id: str,
        meta: dict[str, Any],
        tf_by_field: dict[str, dict[str, int]],
        dl: int,
        terms: set[str],
    ) -> None:
        self.id = id
        self.meta = meta
        self.tf_by_field = tf_by_field
        self.dl = dl
        self.terms = terms


class _Collection:
    __slots__ = ("df", "docs", "fields", "total_len")

    def __init__(self, fields: list[str]) -> None:
        self.fields = list(fields)
        self.docs: dict[str, _IndexedDoc] = {}
        self.df: dict[str, int] = {}
        self.total_len = 0


class InMemorySearchStore:
    """Pure-Python bm25 reference. Non-persistent, zero dependencies."""

    def __init__(self) -> None:
        self._collections: dict[str, _Collection] = {}

    def index(self, collection: str, doc: SearchDocument) -> None:
        names, values = normalize_search_document(doc)
        coll = self._collection_for(collection, names)
        assert_same_search_fields(coll.fields, names, collection)
        record: dict[str, Any] = dict(doc)
        doc_id = str(record["id"])
        self._remove_from(coll, doc_id)

        tf_by_field: dict[str, dict[str, int]] = {}
        terms: set[str] = set()
        dl = 0
        for field in coll.fields:
            tokens = tokenize(values.get(field, ""))
            dl += len(tokens)
            tf: dict[str, int] = {}
            for token in tokens:
                tf[token] = tf.get(token, 0) + 1
                terms.add(token)
            tf_by_field[field] = tf
        coll.total_len += dl

        raw_meta: Any = record.get("meta")
        meta: dict[str, Any] = cast(dict[str, Any], raw_meta) if isinstance(raw_meta, dict) else {}
        coll.docs[doc_id] = _IndexedDoc(doc_id, meta, tf_by_field, dl, terms)
        for term in terms:
            coll.df[term] = coll.df.get(term, 0) + 1

    def indexMany(self, collection: str, docs: list[SearchDocument]) -> None:
        for doc in docs:
            self.index(collection, doc)

    def remove(self, collection: str, id: str) -> bool:
        coll = self._collections.get(collection)
        if coll is None:
            return False
        return self._remove_from(coll, id)

    def search(
        self, collection: str, query: str, opts: SearchOptions | None = None
    ) -> list[SearchResult]:
        options: SearchOptions = opts or {}
        q_tokens = tokenize(query)
        assert_valid_field_weight_values(options.get("fieldWeights"))
        coll = self._collections.get(collection)
        if coll is None or not q_tokens:
            return []
        limit = options.get("limit", 10)
        where = (options.get("filter") or {}).get("where")
        weights = field_weights_for(coll.fields, options.get("fieldWeights"))
        n = len(coll.docs)
        avgdl = coll.total_len / n if n > 0 else 0.0

        scored: list[SearchResult] = []
        for doc in coll.docs.values():
            if where and not matches_where(doc.meta, where):
                continue
            matched = False
            score = 0.0
            for token in q_tokens:
                df = coll.df.get(token, 0)
                if df == 0:
                    continue
                if token not in doc.terms:
                    continue
                # FTS5 MATCHes on the raw presence of the term; the weights only
                # scale the contribution, so a zero-weighted hit still matches
                # and contributes exactly zero.
                matched = True
                weighted_tf = 0.0
                for index, field in enumerate(coll.fields):
                    weighted_tf += weights[index] * doc.tf_by_field[field].get(token, 0)
                idf = math.log((n - df + 0.5) / (df + 0.5))
                if idf <= 0:
                    idf = IDF_FLOOR
                denominator = weighted_tf + K1 * (
                    1 - B + B * (doc.dl / avgdl if avgdl > 0 else 0.0)
                )
                score += idf * (weighted_tf * (K1 + 1)) / denominator
            if not matched:
                continue
            scored.append({"id": doc.id, "score": score, "meta": doc.meta})

        # Score descending, then id in Unicode code point order, which is
        # exactly what Python's `<` on str compares and what SQLite's BINARY
        # collation gives the sqlite facet.
        scored.sort(key=lambda result: (-result["score"], result["id"]))
        return scored[: math.trunc(limit)]

    def _remove_from(self, coll: _Collection, id: str) -> bool:
        doc = coll.docs.pop(id, None)
        if doc is None:
            return False
        coll.total_len -= doc.dl
        for term in doc.terms:
            remaining = coll.df.get(term, 0) - 1
            if remaining <= 0:
                coll.df.pop(term, None)
            else:
                coll.df[term] = remaining
        return True

    def _collection_for(self, name: str, fields: list[str]) -> _Collection:
        coll = self._collections.get(name)
        if coll is None:
            coll = _Collection(fields)
            self._collections[name] = coll
        return coll


def conformance_target(backend: str, connection: object) -> object:
    """Build the search target the corpus runner dispatches ``search/*`` steps onto."""
    if backend == "sqlite":
        from .sqlite_search import SqliteSearchFacet

        return SqliteSearchFacet(connection)
    return InMemorySearchStore()
