"""Graph traversal parity: every assertion of the TypeScript graph suite.

Each behavioral case runs against both real backends, an `InMemoryStore` and a
`SqliteStore(":memory:")`, and every graph in the fixture set also asserts that
the frontier-batched walk equals the load-once walk. The capability-ladder cases
use probe stores, because a ladder rung is only observable by counting the calls
a store receives.
"""

from __future__ import annotations

from typing import Any

import pytest

from mirk.store import InMemoryStore, SqliteStore
from mirk.store.graph import (
    Direction,
    GraphTraversalOptions,
    conformance_target,
    neighbors,
    traverse,
    traverse_frontier_batched,
)
from mirk.store.types import StoreFilter

COLLECTION = "edges"


def edge(id: str, frm: str, to: str, type: str, published: bool = True) -> dict[str, Any]:
    return {"id": id, "from": frm, "to": to, "type": type, "published": published}


#   a → b (follows)   b → c (follows)   c → a (follows)   ← cycle a→b→c→a
#   a → d (mentions)  d → e (follows)   a → x (follows, unpublished)
#   node z is isolated.
EDGES: list[dict[str, Any]] = [
    edge("e_ab", "a", "b", "follows"),
    edge("e_bc", "b", "c", "follows"),
    edge("e_ca", "c", "a", "follows"),
    edge("e_ad", "a", "d", "mentions"),
    edge("e_de", "d", "e", "follows"),
    edge("e_ax", "a", "x", "follows", False),
]


def _make(backend: str) -> Any:
    return InMemoryStore() if backend == "memory" else SqliteStore(":memory:")


@pytest.fixture(params=["memory", "sqlite"])
def store(request: pytest.FixtureRequest) -> Any:
    handle = _make(str(request.param))
    for item in EDGES:
        handle.put(COLLECTION, item)
    yield handle
    close = getattr(handle, "close", None)
    if callable(close):
        close()


@pytest.fixture(params=["memory", "sqlite"])
def empty_store(request: pytest.FixtureRequest) -> Any:
    handle = _make(str(request.param))
    yield handle
    close = getattr(handle, "close", None)
    if callable(close):
        close()


def ids(edges: list[Any]) -> list[str]:
    return [str(item["id"]) for item in edges]


# ── neighbors ────────────────────────────────────────────────────────────────


def test_neighbors_out_returns_direct_outgoing_edges(store: Any) -> None:
    result = neighbors(store, COLLECTION, {"from": "a"})
    assert sorted(ids(result)) == ["e_ab", "e_ad", "e_ax"]


def test_neighbors_in_returns_direct_incoming_edges(store: Any) -> None:
    result = neighbors(store, COLLECTION, {"from": "a", "direction": "in"})
    assert ids(result) == ["e_ca"]


def test_neighbors_both_unions_and_dedups_by_id(store: Any) -> None:
    result = neighbors(store, COLLECTION, {"from": "a", "direction": "both"})
    assert sorted(ids(result)) == ["e_ab", "e_ad", "e_ax", "e_ca"]


def test_neighbors_edge_types_restrict_by_relation_kind(store: Any) -> None:
    result = neighbors(store, COLLECTION, {"from": "a", "edgeTypes": ["mentions"]})
    assert ids(result) == ["e_ad"]


def test_neighbors_edge_filter_prunes_at_the_store(store: Any) -> None:
    result = neighbors(
        store, COLLECTION, {"from": "a", "edgeFilter": {"where": {"published": True}}}
    )
    assert sorted(ids(result)) == ["e_ab", "e_ad"]


def test_neighbors_edge_filter_and_edge_types_compose(store: Any) -> None:
    result = neighbors(
        store,
        COLLECTION,
        {
            "from": "a",
            "edgeTypes": ["follows"],
            "edgeFilter": {"where": {"published": True}},
        },
    )
    assert ids(result) == ["e_ab"]


def test_neighbors_of_an_isolated_node_is_empty(store: Any) -> None:
    assert neighbors(store, COLLECTION, {"from": "z"}) == []


def test_structural_from_overrides_a_caller_where_on_from(store: Any) -> None:
    result = neighbors(store, COLLECTION, {"from": "a", "edgeFilter": {"where": {"from": "zzz"}}})
    assert sorted(ids(result)) == ["e_ab", "e_ad", "e_ax"]


def test_the_full_edge_record_survives_both_primitives(empty_store: Any) -> None:
    rich = {
        "id": "e_ft",
        "from": "a",
        "to": "b",
        "type": "ref",
        "from_type": "doc",
        "to_type": "term",
        "weight": 3,
    }
    empty_store.put("rich", rich)

    found = neighbors(empty_store, "rich", {"from": "a"})
    assert found == [rich]

    walked = traverse(empty_store, "rich", {"start": "a", "depth": 1})
    assert walked["edges"] == [rich]


# ── traverse ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("depth", [0, -3])
def test_non_positive_depth_yields_nothing(store: Any, depth: int) -> None:
    assert traverse(store, COLLECTION, {"start": "a", "depth": depth}) == {
        "nodes": [],
        "edges": [],
    }


@pytest.mark.parametrize("depth", [float("nan"), float("inf")])
def test_non_finite_depth_yields_nothing(store: Any, depth: float) -> None:
    """NaN and infinity fail the finite guard rather than hanging or throwing."""
    assert traverse(store, COLLECTION, {"start": "a", "depth": depth}) == {
        "nodes": [],
        "edges": [],
    }


def test_depth_one_reaches_direct_neighbors_and_excludes_the_start(store: Any) -> None:
    result = traverse(store, COLLECTION, {"start": "a", "depth": 1})
    assert result["nodes"] == ["b", "d", "x"]
    assert ids(result["edges"]) == ["e_ab", "e_ad", "e_ax"]


def test_depth_two_walks_two_hops(store: Any) -> None:
    result = traverse(store, COLLECTION, {"start": "a", "depth": 2})
    assert result["nodes"] == ["b", "c", "d", "e", "x"]
    assert ids(result["edges"]) == ["e_ab", "e_ad", "e_ax", "e_bc", "e_de"]


def test_depth_three_closes_the_cycle_without_re_expanding_the_start(store: Any) -> None:
    result = traverse(store, COLLECTION, {"start": "a", "depth": 3})
    assert result["nodes"] == ["b", "c", "d", "e", "x"]
    assert ids(result["edges"]) == ["e_ab", "e_ad", "e_ax", "e_bc", "e_ca", "e_de"]


def test_a_tight_cycle_terminates_at_large_depth(empty_store: Any) -> None:
    for item in (edge("c_pq", "p", "q", "link"), edge("c_qp", "q", "p", "link")):
        empty_store.put("c", item)
    result = traverse(empty_store, "c", {"start": "p", "depth": 100})
    assert result["nodes"] == ["q"]
    assert ids(result["edges"]) == ["c_pq", "c_qp"]


def test_direction_in_walks_edges_backward(store: Any) -> None:
    result = traverse(store, COLLECTION, {"start": "a", "depth": 3, "direction": "in"})
    assert result["nodes"] == ["b", "c"]
    assert ids(result["edges"]) == ["e_ab", "e_bc", "e_ca"]


def test_direction_both_makes_edges_bidirectional(store: Any) -> None:
    result = traverse(store, COLLECTION, {"start": "e", "depth": 1, "direction": "both"})
    assert result["nodes"] == ["d"]
    assert ids(result["edges"]) == ["e_de"]


def test_edge_types_restrict_the_walk(store: Any) -> None:
    result = traverse(store, COLLECTION, {"start": "a", "depth": 5, "edgeTypes": ["follows"]})
    assert result["nodes"] == ["b", "c", "x"]
    assert ids(result["edges"]) == ["e_ab", "e_ax", "e_bc", "e_ca"]


def test_edge_filter_prunes_before_the_walk(store: Any) -> None:
    result = traverse(
        store,
        COLLECTION,
        {"start": "a", "depth": 5, "edgeFilter": {"where": {"published": True}}},
    )
    assert result["nodes"] == ["b", "c", "d", "e"]
    assert ids(result["edges"]) == ["e_ab", "e_ad", "e_bc", "e_ca", "e_de"]


def test_an_isolated_start_yields_nothing(store: Any) -> None:
    assert traverse(store, COLLECTION, {"start": "z", "depth": 5}) == {"nodes": [], "edges": []}


def test_a_self_loop_is_recorded_while_the_start_stays_out_of_nodes(store: Any) -> None:
    store.put(COLLECTION, edge("e_aa", "a", "a", "self"))
    result = traverse(store, COLLECTION, {"start": "a", "depth": 3})
    assert "a" not in result["nodes"]
    assert "e_aa" in ids(result["edges"])


def test_both_direction_over_a_directed_chain_reaches_each_side(empty_store: Any) -> None:
    empty_store.put("chain", edge("e_ab", "a", "b", "link"))
    empty_store.put("chain", edge("e_bc", "b", "c", "link"))
    result = traverse(empty_store, "chain", {"start": "b", "depth": 2, "direction": "both"})
    assert result["nodes"] == ["a", "c"]
    assert ids(result["edges"]) == ["e_ab", "e_bc"]


# ── the two strategies agree ─────────────────────────────────────────────────

STRATEGY_OPTIONS: list[GraphTraversalOptions] = [
    {"start": "a", "depth": 1},
    {"start": "a", "depth": 2},
    {"start": "a", "depth": 3},
    {"start": "a", "depth": 5, "direction": "in"},
    {"start": "e", "depth": 5, "direction": "both"},
    {"start": "a", "depth": 5, "direction": "both", "edgeFilter": {"where": {"published": True}}},
    {"start": "a", "depth": 5, "edgeTypes": ["follows"]},
    {"start": "z", "depth": 5},
    {"start": "a", "depth": 0},
]


@pytest.mark.parametrize("opts", STRATEGY_OPTIONS, ids=lambda o: f"{o['start']}-{o['depth']}")
def test_frontier_batched_equals_load_once_on_the_fixture_graph(
    store: Any, opts: GraphTraversalOptions
) -> None:
    store.put(COLLECTION, edge("noise", "unrelated", "sink", "follows"))
    assert traverse_frontier_batched(store, COLLECTION, opts) == traverse(store, COLLECTION, opts)


def test_frontier_batched_equals_load_once_on_a_cycle_and_a_self_loop(empty_store: Any) -> None:
    for item in (
        edge("c_pq", "p", "q", "link"),
        edge("c_qp", "q", "p", "link"),
        edge("c_pp", "p", "p", "self"),
    ):
        empty_store.put("c", item)
    directions: tuple[Direction, ...] = ("out", "in", "both")
    for direction in directions:
        opts: GraphTraversalOptions = {"start": "p", "depth": 100, "direction": direction}
        assert traverse_frontier_batched(empty_store, "c", opts) == traverse(empty_store, "c", opts)


# ── the capability ladder, observed by counting calls ────────────────────────


def _matches_where(record: dict[str, Any], where: dict[str, Any] | None) -> bool:
    if not where:
        return True
    return all(record.get(field) == value for field, value in where.items())


class BatchOnlyStore:
    """A store whose only query capability is ``listWhereIn``, logging every call."""

    def __init__(self, edges: list[dict[str, Any]]) -> None:
        self._edges = edges
        self.queries: list[dict[str, Any]] = []

    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]:
        raise AssertionError("traverseFrontierBatched must not call list() when listWhereIn exists")

    def listWhereIn(
        self,
        collection: str,
        field: str,
        values: list[Any],
        filter: StoreFilter | None = None,
    ) -> list[Any]:
        self.queries.append({"field": field, "values": list(values), "filter": filter})
        wanted = set(values)
        where = filter.get("where") if filter else None
        return [
            item
            for item in self._edges
            if item.get(field) in wanted and _matches_where(item, where)
        ]


def test_frontier_batched_queries_once_per_hop_and_pushes_the_edge_filter_down() -> None:
    probe = BatchOnlyStore([*EDGES, edge("noise", "unrelated", "sink", "follows")])
    result = traverse_frontier_batched(
        probe,
        COLLECTION,
        {"start": "a", "depth": 2, "edgeFilter": {"where": {"published": True}}},
    )

    assert result["nodes"] == ["b", "c", "d", "e"]
    assert ids(result["edges"]) == ["e_ab", "e_ad", "e_bc", "e_de"]
    assert [query["field"] for query in probe.queries] == ["from", "from"]
    assert [query["values"] for query in probe.queries] == [["a"], ["b", "d"]]
    assert all(query["filter"]["where"]["published"] is True for query in probe.queries)


class NativeGraphStore:
    """An in-memory store that also claims native traversal for named collections."""

    def __init__(self, collections: list[str], result: dict[str, Any]) -> None:
        self._store = InMemoryStore()
        self._configured = set(collections)
        self._result = result
        self.traversals: list[dict[str, Any]] = []
        self.list_where_in_calls = 0

    def canTraverseGraph(self, collection: str) -> bool:
        return collection in self._configured

    def traverseGraph(self, collection: str, options: dict[str, Any]) -> dict[str, Any]:
        self.traversals.append({"collection": collection, "options": options})
        return self._result

    def put(self, collection: str, item: dict[str, Any]) -> dict[str, Any]:
        return self._store.put(collection, item)

    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]:
        return self._store.list(collection, filter)

    def listWhereIn(
        self,
        collection: str,
        field: str,
        values: list[Any],
        filter: StoreFilter | None = None,
    ) -> list[Any]:
        self.list_where_in_calls += 1
        return self._store.listWhereIn(collection, field, values, filter)


def test_traverse_delegates_to_a_native_capable_store_verbatim() -> None:
    native_result = {
        "nodes": ["native-node"],
        "edges": [edge("native-edge", "a", "native-node", "link")],
    }
    native = NativeGraphStore(["native-edges"], native_result)
    opts: GraphTraversalOptions = {"start": "a", "depth": 2, "edgeTypes": ["link"]}

    assert traverse(native, "native-edges", opts) == native_result
    assert native.traversals == [{"collection": "native-edges", "options": opts}]


class NativeOnlyStore:
    """Native traversal and nothing else: ``list`` is a trap, ``listWhereIn`` absent."""

    def __init__(self, result: dict[str, Any]) -> None:
        self._result = result
        self.traversals: list[dict[str, Any]] = []

    def canTraverseGraph(self, collection: str) -> bool:
        return collection == "native-edges"

    def traverseGraph(self, collection: str, options: dict[str, Any]) -> dict[str, Any]:
        self.traversals.append({"collection": collection, "options": options})
        return self._result

    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]:
        raise AssertionError("native traversal must not call list()")


def test_frontier_batched_delegates_when_native_is_the_only_fast_path() -> None:
    native_result = {"nodes": ["b"], "edges": [edge("e_ab", "a", "b", "follows")]}
    probe = NativeOnlyStore(native_result)
    opts: GraphTraversalOptions = {"start": "a", "depth": 1}

    assert traverse_frontier_batched(probe, "native-edges", opts) == native_result
    assert probe.traversals == [{"collection": "native-edges", "options": opts}]


def test_native_traversal_wins_over_list_where_in() -> None:
    native = NativeGraphStore(
        ["native-edges"], {"nodes": ["b"], "edges": [edge("e_ab", "a", "b", "follows")]}
    )
    native.put("native-edges", edge("fallback", "a", "fallback", "follows"))

    result = traverse_frontier_batched(native, "native-edges", {"start": "a", "depth": 1})

    assert result["nodes"] == ["b"]
    assert len(native.traversals) == 1
    assert native.list_where_in_calls == 0


def test_an_unconfigured_collection_uses_list_where_in_not_native() -> None:
    native = NativeGraphStore(
        ["native-edges"], {"nodes": ["wrong"], "edges": [edge("wrong", "a", "wrong", "link")]}
    )
    for item in EDGES:
        native.put("flat-edges", item)

    result = traverse_frontier_batched(
        native,
        "flat-edges",
        {"start": "a", "depth": 2, "edgeFilter": {"where": {"published": True}}},
    )

    assert result["nodes"] == ["b", "c", "d", "e"]
    assert ids(result["edges"]) == ["e_ab", "e_ad", "e_bc", "e_de"]
    assert native.traversals == []
    assert native.list_where_in_calls == 2


class LoadOnceStore:
    """Neither native traversal nor ``listWhereIn``: the load-once fallback."""

    def __init__(self, edges: list[dict[str, Any]]) -> None:
        self._edges = edges
        self.list_calls = 0

    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]:
        self.list_calls += 1
        return list(self._edges)


def test_a_store_with_neither_capability_falls_back_to_load_once() -> None:
    probe = LoadOnceStore(EDGES)
    result = traverse_frontier_batched(probe, COLLECTION, {"start": "a", "depth": 2})

    assert result["nodes"] == ["b", "c", "d", "e", "x"]
    assert probe.list_calls == 1


def test_a_record_that_merely_has_from_and_to_is_not_a_configured_graph() -> None:
    native = NativeGraphStore(
        ["native-edges"], {"nodes": ["wrong"], "edges": [edge("wrong", "source", "wrong", "link")]}
    )
    native.put(
        "notes",
        {
            "id": "note-1",
            "from": "source",
            "to": "target",
            "type": "mentions",
            "body": "plain collection record",
        },
    )

    result = traverse(native, "notes", {"start": "source", "depth": 1})

    assert result["nodes"] == ["target"]
    assert ids(result["edges"]) == ["note-1"]
    assert native.traversals == []


# ── the corpus facade ────────────────────────────────────────────────────────


@pytest.mark.parametrize("backend", ["memory", "sqlite"])
def test_the_conformance_target_seeds_and_walks_under_typescript_op_names(backend: str) -> None:
    connection = _make(backend)
    try:
        target = conformance_target(backend, connection)
        for item in EDGES:
            target.put(COLLECTION, item)

        assert target.count(COLLECTION) == len(EDGES)
        assert ids(target.neighbors(COLLECTION, {"from": "a", "direction": "in"})) == ["e_ca"]

        opts: GraphTraversalOptions = {"start": "a", "depth": 3}
        walked = target.traverse(COLLECTION, opts)
        assert walked["nodes"] == ["b", "c", "d", "e", "x"]
        assert target.traverseFrontierBatched(COLLECTION, opts) == walked
    finally:
        close = getattr(connection, "close", None)
        if callable(close):
            close()


@pytest.mark.parametrize("backend", ["memory", "sqlite"])
def test_the_runner_resolves_the_graph_port_by_convention(backend: str) -> None:
    """The real dispatch path, exercised before any ``graph/*`` scenario exists.

    A synthetic scenario in the corpus's own shape goes through the runner's
    port resolution and step dispatch, so the facade is proven against the
    machinery that will replay the generated files, not against a stand-in.
    """
    from pathlib import Path

    from mirk.store.conformance import Scenario, resolve_target, run_scenario, scenario_port

    data: dict[str, Any] = {
        "id": "graph/synthetic-runner-check",
        "ports": ["collection", "graph"],
        "capabilities": ["listWhereIn"],
        "steps": [{"op": "put", "args": [COLLECTION, item]} for item in EDGES]
        + [
            {
                "op": "neighbors",
                "args": [COLLECTION, {"from": "a", "edgeTypes": ["mentions"]}],
                "expect": {"value": [edge("e_ad", "a", "d", "mentions")]},
            },
            {
                "op": "traverse",
                "args": [COLLECTION, {"start": "a", "depth": 1}],
                "expect": {
                    "value": {
                        "nodes": ["b", "d", "x"],
                        "edges": [
                            edge("e_ab", "a", "b", "follows"),
                            edge("e_ad", "a", "d", "mentions"),
                            edge("e_ax", "a", "x", "follows", False),
                        ],
                    }
                },
            },
            {
                "op": "traverseFrontierBatched",
                "args": [COLLECTION, {"start": "a", "depth": 1}],
                "expect": {
                    "value": {
                        "nodes": ["b", "d", "x"],
                        "edges": [
                            edge("e_ab", "a", "b", "follows"),
                            edge("e_ad", "a", "d", "mentions"),
                            edge("e_ax", "a", "x", "follows", False),
                        ],
                    }
                },
            },
        ],
    }
    scenario = Scenario(id=data["id"], path=Path("synthetic.json"), data=data)
    assert scenario_port(scenario) == "graph"

    connection = _make(backend)
    try:
        target = resolve_target("graph", backend, connection)
        assert run_scenario(target, scenario) == []
    finally:
        close = getattr(connection, "close", None)
        if callable(close):
            close()
