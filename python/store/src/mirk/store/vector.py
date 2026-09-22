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
from typing import TYPE_CHECKING, Any, Protocol, Required, TypedDict, cast, runtime_checkable

from .filter import dumps_json

if TYPE_CHECKING:
    from .sqlite_vector import SqliteVectorFacet

__all__ = [
    "InMemoryVectorStore",
    "VectorDocument",
    "VectorSearchOptions",
    "VectorSearchResult",
    "VectorSearchResultList",
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
    "vector_to_bytes",
]

DEFAULT_TOP_K = 10


class VectorStoreMeta(TypedDict):
    """What a store reports about itself. ``accelerated`` is informational."""

    backend: str
    dimensions: int
    accelerated: bool


class VectorDocument(TypedDict, total=False):
    """A stored embedding. ``metadata`` is absent, never null, when unset."""

    id: Required[str]
    vector: Required[list[float]]
    metadata: dict[str, Any]


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

    def upsert(self, collection: str, doc: VectorDocument) -> None: ...
    def upsertMany(self, collection: str, docs: list[VectorDocument]) -> None: ...
    def get(self, collection: str, id: str) -> VectorDocument | None: ...
    def has(self, collection: str, id: str) -> bool: ...
    def remove(self, collection: str, id: str) -> bool: ...
    def count(self, collection: str) -> int: ...
    def search(
        self, collection: str, query: list[float], opts: VectorSearchOptions | None = None
    ) -> VectorSearchResultList: ...


def dimension_mismatch_message(expected: int, got: int) -> str:
    """The one dimension-mismatch message, shared by every backend."""
    return f"Vector dimension mismatch: expected {expected}, got {got}"


def assert_dimensions(vector: list[float], dimensions: int) -> None:
    """Raise when a vector's length does not match the store's dimensions."""
    if len(vector) != dimensions:
        raise ValueError(dimension_mismatch_message(dimensions, len(vector)))


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

    def __init__(self, dimensions: int) -> None:
        self._dimensions = dimensions
        self._collections: dict[str, dict[str, VectorDocument]] = {}

    @property
    def meta(self) -> VectorStoreMeta:
        return {"backend": "memory", "dimensions": self._dimensions, "accelerated": False}

    @property
    def dimensions(self) -> int:
        return self._dimensions

    def _store_doc(self, doc: VectorDocument) -> VectorDocument:
        stored: VectorDocument = {"id": doc["id"], "vector": to_float32(doc["vector"])}
        metadata = _metadata_of(doc)
        if metadata is not None:
            stored["metadata"] = metadata
        return stored

    def upsert(self, collection: str, doc: VectorDocument) -> None:
        assert_dimensions(doc["vector"], self._dimensions)
        self._collections.setdefault(collection, {})[doc["id"]] = self._store_doc(doc)

    def upsertMany(self, collection: str, docs: list[VectorDocument]) -> None:
        # Validate every vector before mutating: a mid-array mismatch must insert
        # nothing, matching the SQLite backend's one transaction.
        for doc in docs:
            assert_dimensions(doc["vector"], self._dimensions)
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
        self, collection: str, query: list[float], opts: VectorSearchOptions | None = None
    ) -> VectorSearchResultList:
        assert_dimensions(query, self._dimensions)
        collection_docs = self._collections.get(collection)
        if collection_docs is None:
            return []
        minimum = min_score_of(opts)
        rounded_query = to_float32(query)
        scored: VectorSearchResultList = []
        for doc in collection_docs.values():
            metadata = _metadata_of(doc)
            if not keeps_metadata(metadata, opts):
                continue
            score = score_of(rounded_query, doc["vector"], minimum)
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


def _dimensions_in(args: tuple[Any, ...]) -> int | None:
    """The length of the first vector-shaped argument, as the TypeScript harness reads it.

    The generator sizes a scenario's store from the first vector argument in step
    order; reading the first vector argument at call time finds the same one,
    because steps run in the order the generator scanned them.
    """
    for arg in args:
        if is_vector_argument(arg):
            return len(cast(list[Any], arg))
        candidates: list[Any] = cast(list[Any], arg) if isinstance(arg, list) else [arg]
        for candidate in candidates:
            if isinstance(candidate, dict):
                vector: Any = cast(dict[str, Any], candidate).get("vector")
                if is_vector_argument(vector):
                    return len(cast(list[Any], vector))
    return None


class _ScenarioVectorTarget:
    """Adopt the store's dimensions from the scenario, the way the generator does.

    The corpus runner builds a target before it has seen a step, while the
    TypeScript generator sizes its store from the scenario's first vector. This
    target closes that gap: it configures dimensions from the first vector
    argument it is handed and then delegates every call unchanged.
    """

    def __init__(self, backend: str, connection: object) -> None:
        self._backend = backend
        self._connection = connection
        self._store: VectorStore | None = None
        self._sqlite: SqliteVectorFacet | None = None
        self._sized = False
        if backend == "sqlite":
            from .sqlite_vector import SqliteVectorFacet as Facet
            from .sqlite_vector import connection_of

            self._sqlite = Facet(connection_of(connection), path=":memory:")
            self._store = self._sqlite
        elif backend != "memory":
            raise ValueError(f"unknown vector backend {backend!r}")

    def _bind(self, *args: Any) -> VectorStore | None:
        # Sizing happens once, from the scenario's first vector, exactly as the
        # generator sizes its store. A later mismatched vector must reach the
        # store and raise the mismatch, not be read as a second configuration.
        if self._sized:
            return self._store
        dimensions = _dimensions_in(args)
        if dimensions is None:
            return self._store
        self._sized = True
        if self._sqlite is not None:
            self._sqlite.configure_dimensions(dimensions)
            return self._sqlite
        self._store = InMemoryVectorStore(dimensions)
        return self._store

    @property
    def meta(self) -> VectorStoreMeta:
        if self._store is None:
            return {"backend": self._backend, "dimensions": 0, "accelerated": False}
        return self._store.meta

    def upsert(self, collection: str, doc: VectorDocument) -> None:
        store = self._bind(doc)
        assert store is not None
        store.upsert(collection, doc)

    def upsertMany(self, collection: str, docs: list[VectorDocument]) -> None:
        store = self._bind(docs)
        if store is None:
            return
        store.upsertMany(collection, docs)

    def get(self, collection: str, id: str) -> VectorDocument | None:
        return self._store.get(collection, id) if self._store else None

    def has(self, collection: str, id: str) -> bool:
        return self._store.has(collection, id) if self._store else False

    def remove(self, collection: str, id: str) -> bool:
        return self._store.remove(collection, id) if self._store else False

    def count(self, collection: str) -> int:
        return self._store.count(collection) if self._store else 0

    def search(
        self, collection: str, query: list[float], opts: VectorSearchOptions | None = None
    ) -> VectorSearchResultList:
        store = self._bind(query)
        assert store is not None
        return store.search(collection, query, opts)


def conformance_target(backend: str, connection: object) -> object:
    """Build the object the corpus runner dispatches ``vector/*`` steps onto."""
    return _ScenarioVectorTarget(backend, connection)
