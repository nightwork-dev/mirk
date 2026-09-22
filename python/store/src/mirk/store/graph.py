"""Graph traversal over the store port. A synchronous port of ``graph.ts``.

Edges are flat collection records, so any field is matchable through
``StoreFilter.where``. There is no edge table and no node table: nodes exist
only as the string ids appearing in ``from``/``to``. Policy stays out of the
primitive — the caller supplies ``edgeFilter`` and it is applied at load.

Method names keep the TypeScript camelCase spelling (``traverseFrontierBatched``,
``edgeTypes``) wherever the conformance corpus names them, so one ``op`` string
dispatches in both languages. The module-level functions use Python spelling.
"""

from __future__ import annotations

import math
from typing import Any, Literal, TypedDict, cast

from .types import StoreFilter

__all__ = [
    "Direction",
    "Edge",
    "GraphTraversalOptions",
    "GraphTraversalResult",
    "NeighborsOptions",
    "conformance_target",
    "neighbors",
    "traverse",
    "traverse_frontier_batched",
]

Direction = Literal["out", "in", "both"]

Edge = TypedDict("Edge", {"id": str, "from": str, "to": str, "type": str})
"""A directed edge stored as a flat collection record.

The four structural fields are named here; arbitrary extra fields (``weight``,
``published``, ``from_type``) ride along on the real record and are never
projected away.
"""

_NeighborsRequired = TypedDict("_NeighborsRequired", {"from": str})


class NeighborsOptions(_NeighborsRequired, total=False):
    """Options for a single hop. ``from`` is required."""

    direction: Direction
    edgeTypes: list[str]
    edgeFilter: StoreFilter


class _TraversalRequired(TypedDict):
    start: str
    depth: float


class GraphTraversalOptions(_TraversalRequired, total=False):
    """Options for a walk. ``start`` and ``depth`` are required."""

    direction: Direction
    edgeTypes: list[str]
    edgeFilter: StoreFilter


class GraphTraversalResult(TypedDict):
    """Reached node ids (``start`` excluded) and every traversed edge."""

    nodes: list[str]
    edges: list[Edge]


_Record = dict[str, Any]


# ── Capability probes: duck-typed, exactly like the TypeScript `typeof` checks ─


def _method(store: object, name: str) -> Any:
    candidate = getattr(store, name, None)
    return candidate if callable(candidate) else None


def _native_traversal(store: object, collection: str) -> Any:
    """The store's own ``traverseGraph`` when it is configured for ``collection``."""
    can = _method(store, "canTraverseGraph")
    traverse_graph = _method(store, "traverseGraph")
    if can is None or traverse_graph is None:
        return None
    return traverse_graph if bool(can(collection)) else None


# ── Filter plumbing ──────────────────────────────────────────────────────────


def _with_where(filter: StoreFilter | None, override: dict[str, Any]) -> StoreFilter:
    """Merge a caller filter with an override, keeping the override authoritative."""
    merged = cast(StoreFilter, dict(filter) if filter is not None else {})
    where: dict[str, Any] = dict(filter.get("where") or {}) if filter is not None else {}
    where.update(override)
    merged["where"] = where
    return merged


def _without_where_field(filter: StoreFilter | None, field: str) -> StoreFilter | None:
    """Drop a same-named caller ``where`` field; the structural IN query replaces it."""
    if filter is None:
        return None
    where = filter.get("where")
    if not where or field not in where:
        return filter
    clone = cast(StoreFilter, dict(filter))
    narrowed = dict(where)
    del narrowed[field]
    clone["where"] = narrowed
    return clone


def _filter_by_types(edges: list[_Record], edge_types: list[str] | None) -> list[_Record]:
    """Keep edges whose ``type`` is named. A missing or empty list is a no-op."""
    if not edge_types:
        return edges
    wanted = set(edge_types)
    return [edge for edge in edges if edge.get("type") in wanted]


def _dedup_by_id(edges: list[_Record]) -> list[_Record]:
    """Dedup by edge id, first occurrence wins, order preserved."""
    seen: set[Any] = set()
    out: list[_Record] = []
    for edge in edges:
        edge_id = edge.get("id")
        if edge_id in seen:
            continue
        seen.add(edge_id)
        out.append(edge)
    return out


def _direction_of(options: Any) -> Direction:
    value = options.get("direction")
    if value == "in":
        return "in"
    if value == "both":
        return "both"
    return "out"


def _hops(depth: Any) -> int:
    """How many BFS levels ``depth`` buys.

    TypeScript loops while ``hop < depth`` after rejecting a non-finite depth, so
    a positive fractional depth rounds up and ``NaN``/infinity yield nothing.
    Anything that is not a real number yields nothing too.
    """
    if isinstance(depth, bool) or not isinstance(depth, int | float):
        return 0
    numeric = float(depth)
    if not math.isfinite(numeric) or numeric <= 0:
        return 0
    return math.ceil(numeric)


def _far_endpoint(edge: _Record, node: Any) -> Any:
    """The endpoint of ``edge`` away from ``node``, for every direction."""
    return edge.get("to") if edge.get("from") == node else edge.get("from")


def _empty_result() -> GraphTraversalResult:
    return {"nodes": [], "edges": []}


def _sorted_result(nodes: list[Any], edges: list[_Record]) -> GraphTraversalResult:
    """Terminal sort: node ids, then edge ids, in Unicode code point order."""
    ordered_nodes = sorted(nodes, key=_sort_key)
    ordered_edges = sorted(edges, key=lambda edge: _sort_key(edge.get("id")))
    return {
        "nodes": cast(list[str], ordered_nodes),
        "edges": cast(list[Edge], ordered_edges),
    }


def _sort_key(value: Any) -> str:
    return value if isinstance(value, str) else str(value)


# ── The three primitives ─────────────────────────────────────────────────────


def neighbors(store: Any, collection: str, opts: NeighborsOptions) -> list[Edge]:
    """Single-hop adjacent edges of ``opts["from"]``, as full stored records.

    ``edgeFilter`` is pushed to the store; the structural ``from``/``to``
    constraint overrides a same-named caller ``where``. ``edgeTypes`` is applied
    in memory because the port's ``where`` is exact-match only. The result is
    returned in store order, out-edges before in-edges for ``"both"``, deduped by
    id. There is no terminal sort here.
    """
    direction = _direction_of(opts)
    node = opts["from"]
    edge_filter = opts.get("edgeFilter")

    edges: list[_Record]
    if direction == "out":
        edges = store.list(collection, _with_where(edge_filter, {"from": node}))
    elif direction == "in":
        edges = store.list(collection, _with_where(edge_filter, {"to": node}))
    else:
        out_edges: list[_Record] = store.list(collection, _with_where(edge_filter, {"from": node}))
        in_edges: list[_Record] = store.list(collection, _with_where(edge_filter, {"to": node}))
        edges = _dedup_by_id([*out_edges, *in_edges])

    return cast(list[Edge], _filter_by_types(edges, opts.get("edgeTypes")))


def traverse(store: Any, collection: str, opts: GraphTraversalOptions) -> GraphTraversalResult:
    """Load-once BFS to ``depth`` hops from ``start``.

    One store call loads the candidate edges with the caller's ``edgeFilter``
    applied; everything after is in memory. ``start`` is pre-seeded into the
    visited set, so it is never re-expanded and never appears in ``nodes``. An
    edge is recorded the first time it is traversed, even when its far endpoint
    was already reached, which is how a cycle-closing edge appears while its
    endpoint does not. Both arrays are sorted by id.
    """
    native = _native_traversal(store, collection)
    if native is not None:
        return cast(GraphTraversalResult, native(collection, opts))

    direction = _direction_of(opts)
    hops = _hops(opts.get("depth"))
    if hops == 0:
        return _empty_result()

    loaded: list[_Record] = store.list(collection, opts.get("edgeFilter"))
    all_edges = _filter_by_types(loaded, opts.get("edgeTypes"))

    adjacency: dict[Any, list[_Record]] = {}

    def add_adjacency(node: Any, edge: _Record) -> None:
        adjacency.setdefault(node, []).append(edge)

    for edge in all_edges:
        if direction == "out":
            add_adjacency(edge.get("from"), edge)
        elif direction == "in":
            add_adjacency(edge.get("to"), edge)
        else:
            add_adjacency(edge.get("from"), edge)
            add_adjacency(edge.get("to"), edge)

    start = opts["start"]
    visited: set[Any] = {start}
    reached: list[Any] = []
    traversed: list[_Record] = []
    seen_edge_ids: set[Any] = set()

    frontier: list[Any] = [start]
    for _ in range(hops):
        if not frontier:
            break
        following: list[Any] = []
        for node in frontier:
            for edge in adjacency.get(node, []):
                edge_id = edge.get("id")
                if edge_id not in seen_edge_ids:
                    seen_edge_ids.add(edge_id)
                    traversed.append(edge)
                neighbor = _far_endpoint(edge, node)
                if neighbor not in visited:
                    visited.add(neighbor)
                    reached.append(neighbor)
                    following.append(neighbor)
        frontier = following

    return _sorted_result(reached, traversed)


def traverse_frontier_batched(
    store: Any, collection: str, opts: GraphTraversalOptions
) -> GraphTraversalResult:
    """Frontier-IN batched BFS: one ``listWhereIn`` query per hop, per direction.

    Same result contract as :func:`traverse`, different fetch strategy. Stores
    without ``listWhereIn`` fall back to the load-once walk. The structural
    frontier field is removed from the caller's ``where`` before the query, since
    the field/values pair expresses it, so the structural constraint still wins.
    """
    native = _native_traversal(store, collection)
    if native is not None:
        return cast(GraphTraversalResult, native(collection, opts))

    list_where_in = _method(store, "listWhereIn")
    if list_where_in is None:
        return traverse(store, collection, opts)

    direction = _direction_of(opts)
    hops = _hops(opts.get("depth"))
    if hops == 0:
        return _empty_result()

    edge_filter = opts.get("edgeFilter")
    edge_types = opts.get("edgeTypes")

    def fetch(field: str, frontier: list[Any]) -> list[_Record]:
        narrowed = _without_where_field(edge_filter, field)
        return cast(list[_Record], list_where_in(collection, field, frontier, narrowed))

    def frontier_edges(frontier: list[Any]) -> list[_Record]:
        if direction == "out":
            return fetch("from", frontier)
        if direction == "in":
            return fetch("to", frontier)
        return _dedup_by_id([*fetch("from", frontier), *fetch("to", frontier)])

    start = opts["start"]
    visited: set[Any] = {start}
    reached: list[Any] = []
    traversed: list[_Record] = []
    seen_edge_ids: set[Any] = set()

    frontier: list[Any] = [start]
    for _ in range(hops):
        if not frontier:
            break
        edges = _filter_by_types(frontier_edges(frontier), edge_types)
        following: list[Any] = []
        for node in frontier:
            for edge in edges:
                if direction == "out":
                    adjacent = edge.get("from") == node
                elif direction == "in":
                    adjacent = edge.get("to") == node
                else:
                    adjacent = edge.get("from") == node or edge.get("to") == node
                if not adjacent:
                    continue
                edge_id = edge.get("id")
                if edge_id not in seen_edge_ids:
                    seen_edge_ids.add(edge_id)
                    traversed.append(edge)
                neighbor = _far_endpoint(edge, node)
                if neighbor not in visited:
                    visited.add(neighbor)
                    reached.append(neighbor)
                    following.append(neighbor)
        frontier = following

    return _sorted_result(reached, traversed)


# ── Conformance target ───────────────────────────────────────────────────────


class GraphTarget:
    """The corpus-facing graph facade: the store surface plus the three walks.

    It mirrors the TypeScript ``graphApi`` exactly — the same eleven store
    methods a scenario uses to seed its edge collection, and the three traversal
    ops under their TypeScript names.
    """

    def __init__(self, store: Any) -> None:
        self._store = store

    # Store surface, so a scenario can seed edges through the same target.
    def get(self, key: str) -> Any:
        return self._store.get(key)

    def set(self, key: str, value: Any) -> None:
        self._store.set(key, value)

    def has(self, key: str) -> bool:
        return cast(bool, self._store.has(key))

    def delete(self, key: str) -> bool:
        return cast(bool, self._store.delete(key))

    def keys(self, prefix: str | None = None) -> list[str]:
        return cast(list[str], self._store.keys(prefix))

    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]:
        return cast(list[Any], self._store.list(collection, filter))

    def getById(self, collection: str, id: str) -> Any:
        return self._store.getById(collection, id)

    def put(self, collection: str, item: dict[str, Any]) -> dict[str, Any]:
        return cast(dict[str, Any], self._store.put(collection, item))

    def remove(self, collection: str, id: str) -> bool:
        return cast(bool, self._store.remove(collection, id))

    def count(self, collection: str, filter: StoreFilter | None = None) -> int:
        return cast(int, self._store.count(collection, filter))

    def listWhereIn(
        self,
        collection: str,
        field: str,
        values: list[Any],
        filter: StoreFilter | None = None,
    ) -> list[Any]:
        return cast(list[Any], self._store.listWhereIn(collection, field, values, filter))

    # Graph surface.
    def neighbors(self, collection: str, opts: NeighborsOptions) -> list[Edge]:
        return neighbors(self._store, collection, opts)

    def traverse(self, collection: str, opts: GraphTraversalOptions) -> GraphTraversalResult:
        return traverse(self._store, collection, opts)

    def traverseFrontierBatched(
        self, collection: str, opts: GraphTraversalOptions
    ) -> GraphTraversalResult:
        return traverse_frontier_batched(self._store, collection, opts)


def conformance_target(backend: str, connection: object) -> GraphTarget:
    """Build the graph target the corpus runner dispatches ``graph/*`` steps onto."""
    del backend
    return GraphTarget(connection)
