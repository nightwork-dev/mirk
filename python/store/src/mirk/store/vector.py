"""Vector similarity port: the in-memory reference and the shared primitives.

Cosine similarity in float64 over components rounded to float32 on store. The
rounding is not cosmetic: a float64 value that survives in Python but underflows
to zero in a ``Float32Array`` would change ``is_usable_vector`` and every score's
last digits, so a stored vector is rounded once, on write, in both languages.

The metadata field is ``metadata`` here; the search port calls its own ``meta``.
They are different fields with different absent-value rules, so the two filters
are separate functions on purpose.
"""

from __future__ import annotations

import math
import struct
from typing import (
    Any,
    Literal,
    NotRequired,
    Protocol,
    Required,
    TypedDict,
    cast,
    runtime_checkable,
)

from .filter import dumps_json

__all__ = [
    "InMemoryVectorStore",
    "VectorDocument",
    "VectorInputError",
    "VectorInputErrorCode",
    "VectorQuery",
    "VectorSearchOptions",
    "VectorSearchResult",
    "VectorSearchResultList",
    "VectorSpace",
    "VectorSpaceOptions",
    "VectorStore",
    "VectorStoreMeta",
    "assert_dimensions",
    "bytes_to_vector",
    "conformance_target",
    "cosine_similarity",
    "dimension_mismatch_message",
    "finish_search",
    "is_usable_vector",
    "is_vector_argument",
    "keeps_metadata",
    "matches_where",
    "min_score_of",
    "score_of",
    "sort_results",
    "to_float32",
    "top_k_of",
    "validate_space",
    "vector_to_bytes",
]

DEFAULT_TOP_K = 10


class VectorStoreMeta(TypedDict):
    """What a store reports about itself. ``accelerated`` is informational."""

    backend: str
    engine: NotRequired[str]
    accelerated: bool


class VectorDocument(TypedDict, total=False):
    """A stored embedding. ``metadata`` is absent, never null, when unset."""

    id: Required[str]
    vectors: Required[dict[str, list[float]]]
    metadata: dict[str, Any]


class VectorSpace(TypedDict):
    name: str
    dimensions: int
    metric: Literal["cosine"]
    encoding: Literal["float32"]


class VectorSpaceOptions(TypedDict):
    dimensions: int


class VectorQuery(TypedDict):
    space: str
    vector: list[float]


class VectorSearchResult(TypedDict, total=False):
    """One hit. ``score`` is cosine similarity in [-1, 1], higher is nearer."""

    id: Required[str]
    score: Required[float]
    metadata: dict[str, Any]


VectorSearchResultList = list[VectorSearchResult]


class VectorSearchOptions(TypedDict, total=False):
    """Search options, spelled as the corpus spells them."""

    topK: float
    minScore: float
    where: dict[str, Any]
    whereNot: dict[str, Any]


@runtime_checkable
class VectorStore(Protocol):
    """A synchronous vector store. Method names keep the TypeScript spelling."""

    @property
    def meta(self) -> VectorStoreMeta: ...

    def ensureSpace(self, name: str, options: VectorSpaceOptions) -> None: ...
    def listSpaces(self) -> list[VectorSpace]: ...

    def upsert(self, collection: str, doc: VectorDocument) -> None: ...
    def upsertMany(self, collection: str, docs: list[VectorDocument]) -> None: ...
    def get(self, collection: str, id: str) -> VectorDocument | None: ...
    def has(self, collection: str, id: str) -> bool: ...
    def remove(self, collection: str, id: str) -> bool: ...
    def count(self, collection: str) -> int: ...
    def search(
        self, collection: str, query: VectorQuery, opts: VectorSearchOptions | None = None
    ) -> VectorSearchResultList: ...


VectorInputErrorCode = Literal[
    "unknown-space",
    "space-definition-conflict",
    "invalid-space",
    "empty-vectors",
    "dimension-mismatch",
    "invalid-dimensions",
    "dimensions-changed",
    "dimensions-unknown",
]


class VectorInputError(ValueError):
    """Raised when a vector or a store's dimensionality is invalid."""

    def __init__(self, code: VectorInputErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: VectorInputErrorCode = code


def dimension_mismatch_message(expected: int, got: int) -> str:
    """The one dimension-mismatch message, shared by every backend."""
    return f"Vector dimension mismatch: expected {expected}, got {got}"


def assert_dimensions(vector: list[float], dimensions: int) -> None:
    """Raise when a vector's length does not match the store's dimensions."""
    if len(vector) != dimensions:
        raise VectorInputError(
            "dimension-mismatch", dimension_mismatch_message(dimensions, len(vector))
        )


def _round_f32(value: float) -> float:
    """One component, rounded the way assignment into a ``Float32Array`` rounds.

    A magnitude above the float32 range packs as an error in ``struct`` but as an
    infinity in JavaScript; keep the JavaScript answer.
    """
    try:
        return cast(float, struct.unpack("<f", struct.pack("<f", value))[0])
    except OverflowError:
        return math.copysign(math.inf, value)


def to_float32(values: list[float]) -> list[float]:
    """Round every component to float32, as storing into a Float32Array does."""
    return [_round_f32(float(value)) for value in values]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity in float64. Zero for a length mismatch or a zero vector.

    The denominator is ``sqrt(an) * sqrt(bn)``, not ``sqrt(an * bn)``: the two
    forms differ in the last unit in the last place and the corpus tolerance is
    tighter than that difference for large magnitudes.
    """
    if len(a) != len(b):
        return 0.0
    dot = 0.0
    an = 0.0
    bn = 0.0
    for index in range(len(a)):
        av = a[index]
        bv = b[index]
        dot += av * bv
        an += av * av
        bn += bv * bv
    if an == 0 or bn == 0:
        return 0.0
    return dot / (math.sqrt(an) * math.sqrt(bn))


def vector_to_bytes(vector: list[float]) -> bytes:
    """Little-endian float32 BLOB. Explicit LE, so host byte order is irrelevant."""
    return struct.pack(f"<{len(vector)}f", *to_float32(vector))


def bytes_to_vector(blob: bytes) -> list[float]:
    """Inverse of :func:`vector_to_bytes`. Trailing partial floats are dropped."""
    count = len(blob) // 4
    if count == 0:
        return []
    return [float(value) for value in struct.unpack_from(f"<{count}f", blob, 0)]


def is_usable_vector(vector: list[float]) -> bool:
    """All-finite with a non-zero magnitude, so cosine has a direction.

    An unusable stored vector is still stored, fetched and counted; it is only
    kept out of search results, on every backend and every path.
    """
    non_zero = False
    for value in vector:
        if not math.isfinite(value):
            return False
        if value != 0:
            non_zero = True
    return non_zero


_MISSING = object()


def matches_where(metadata: dict[str, Any] | None, where: dict[str, Any]) -> bool:
    """True when ``metadata`` satisfies ALL conditions in ``where``.

    Absent metadata never matches, not even an empty filter. Comparison is
    JSON-text equality, so it is key-order and array-order sensitive, and a
    missing key never matches a JSON-representable expected value.
    """
    if metadata is None:
        return False
    for key, expected in where.items():
        actual: Any = metadata.get(key, _MISSING)
        if actual is _MISSING:
            return False
        if dumps_json(actual) != dumps_json(expected):
            return False
    return True


def sort_results(results: VectorSearchResultList) -> None:
    """Score descending, ties by id in Unicode code point order. In place."""
    results.sort(key=lambda row: (-row["score"], row["id"]))


def top_k_of(opts: VectorSearchOptions | None) -> int:
    raw = opts.get("topK", DEFAULT_TOP_K) if opts else DEFAULT_TOP_K
    return int(raw)


def min_score_of(opts: VectorSearchOptions | None) -> float | None:
    if not opts or "minScore" not in opts:
        return None
    return float(opts["minScore"])


def _metadata_of(doc: VectorDocument) -> dict[str, Any] | None:
    return doc.get("metadata")


def keeps_metadata(metadata: dict[str, Any] | None, opts: VectorSearchOptions | None) -> bool:
    """Pre-KNN metadata gate. ``whereNot`` excludes when ALL its conditions hold."""
    if not opts:
        return True
    where = opts.get("where")
    if where is not None and not matches_where(metadata, where):
        return False
    where_not = opts.get("whereNot")
    return not (where_not is not None and matches_where(metadata, where_not))


def finish_search(
    scored: VectorSearchResultList, opts: VectorSearchOptions | None
) -> VectorSearchResultList:
    """Order, then cut to ``topK``.

    ``minScore`` is already applied by the caller: filtering before the cut is
    what makes a filtered search return up to ``topK`` surviving documents
    rather than the ``topK`` nearest documents minus the rejects.
    """
    sort_results(scored)
    return scored[: top_k_of(opts)]


def score_of(
    query: list[float],
    vector: list[float],
    minimum: float | None,
) -> float | None:
    """The score to record for one candidate, or None when it is excluded."""
    if not is_usable_vector(vector):
        return None
    score = cosine_similarity(query, vector)
    if not math.isfinite(score):
        return None
    if minimum is not None and score < minimum:
        return None
    return score


class InMemoryVectorStore:
    """Brute-force exact cosine search. The reference implementation."""

    def __init__(self) -> None:
        self._spaces: dict[str, VectorSpace] = {}
        self._collections: dict[str, dict[str, VectorDocument]] = {}

    @property
    def meta(self) -> VectorStoreMeta:
        return {"backend": "memory", "accelerated": False}

    def ensureSpace(self, name: str, options: VectorSpaceOptions) -> None:
        validate_space(name, options)
        found = self._spaces.get(name)
        if found is not None and found["dimensions"] != options["dimensions"]:
            raise VectorInputError(
                "space-definition-conflict",
                f"Space {name} already has {found['dimensions']} dimensions",
            )
        self._spaces[name] = {
            "name": name,
            "dimensions": options["dimensions"],
            "metric": "cosine",
            "encoding": "float32",
        }

    def listSpaces(self) -> list[VectorSpace]:
        return [cast(VectorSpace, dict(self._spaces[name])) for name in sorted(self._spaces)]

    def _require_space(self, name: str) -> VectorSpace:
        found = self._spaces.get(name)
        if found is None:
            raise VectorInputError("unknown-space", f"Unknown vector space: {name}")
        return found

    def _validate(self, doc: VectorDocument) -> None:
        if not doc["vectors"]:
            raise VectorInputError("empty-vectors", "A document needs at least one vector")
        for name, vector in doc["vectors"].items():
            assert_dimensions(vector, self._require_space(name)["dimensions"])

    def _store_doc(self, doc: VectorDocument) -> VectorDocument:
        stored: VectorDocument = {
            "id": doc["id"],
            "vectors": {name: to_float32(vector) for name, vector in doc["vectors"].items()},
        }
        metadata = _metadata_of(doc)
        if metadata is not None:
            stored["metadata"] = metadata
        return stored

    def upsert(self, collection: str, doc: VectorDocument) -> None:
        self._validate(doc)
        self._collections.setdefault(collection, {})[doc["id"]] = self._store_doc(doc)

    def upsertMany(self, collection: str, docs: list[VectorDocument]) -> None:
        # Validate every vector before mutating: a mid-array mismatch must insert
        # nothing, matching the SQLite backend's one transaction.
        for doc in docs:
            self._validate(doc)
        target = self._collections.setdefault(collection, {})
        for doc in docs:
            target[doc["id"]] = self._store_doc(doc)

    def get(self, collection: str, id: str) -> VectorDocument | None:
        doc = self._collections.get(collection, {}).get(id)
        if doc is None:
            return None
        return self._store_doc(doc)

    def has(self, collection: str, id: str) -> bool:
        return id in self._collections.get(collection, {})

    def remove(self, collection: str, id: str) -> bool:
        return self._collections.get(collection, {}).pop(id, None) is not None

    def count(self, collection: str) -> int:
        return len(self._collections.get(collection, {}))

    def search(
        self, collection: str, query: VectorQuery, opts: VectorSearchOptions | None = None
    ) -> VectorSearchResultList:
        assert_dimensions(query["vector"], self._require_space(query["space"])["dimensions"])
        collection_docs = self._collections.get(collection)
        if collection_docs is None:
            return []
        minimum = min_score_of(opts)
        rounded_query = to_float32(query["vector"])
        scored: VectorSearchResultList = []
        for doc in collection_docs.values():
            metadata = _metadata_of(doc)
            if not keeps_metadata(metadata, opts):
                continue
            vector = doc["vectors"].get(query["space"])
            if vector is None:
                continue
            score = score_of(rounded_query, vector, minimum)
            if score is None:
                continue
            hit: VectorSearchResult = {"id": doc["id"], "score": score}
            if metadata is not None:
                hit["metadata"] = metadata
            scored.append(hit)
        return finish_search(scored, opts)


def is_vector_argument(value: Any) -> bool:
    """A JSON vector: a non-empty array of numbers, booleans excluded."""
    if not isinstance(value, list):
        return False
    items = cast(list[Any], value)
    if not items:
        return False
    return all(isinstance(item, int | float) and not isinstance(item, bool) for item in items)


def validate_space(name: str, options: VectorSpaceOptions) -> None:
    if not name:
        raise VectorInputError("invalid-space", "Space name must be nonempty")
    dimensions = options["dimensions"]
    if isinstance(dimensions, bool) or dimensions <= 0:
        raise VectorInputError(
            "invalid-dimensions", f"Vector dimensions must be a positive integer; got {dimensions}."
        )


def conformance_target(backend: str, connection: object) -> object:
    if backend == "memory":
        return InMemoryVectorStore()
    if backend == "sqlite":
        from .sqlite import connection_of
        from .sqlite_vector import SqliteVectorFacet

        return SqliteVectorFacet(connection_of(connection), path=":memory:")
    raise ValueError(f"unknown vector backend {backend!r}")
