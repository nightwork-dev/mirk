"""Build the reference graph from loaded entries.

A malformed ref stays visible as a node with type `<malformed>` rather than
being dropped, so a broken pack shows the broken edge instead of a gap.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, NamedTuple

from .errors import FixtureError
from .refs import parse_ref
from .types import Diagnostic, ExtractedReference, ReferenceGraph, ReferenceGraphNode

__all__ = ["GraphBuildEntry", "build_reference_graph"]


class GraphBuildEntry(NamedTuple):
    ref: str
    value: Any
    resolved: bool
    refs: Sequence[ExtractedReference]


def build_reference_graph(
    entries: Sequence[GraphBuildEntry],
    diagnostics: Sequence[Diagnostic] = (),
) -> ReferenceGraph:
    nodes: dict[str, ReferenceGraphNode] = {}
    edges: list[Any] = []

    for entry in entries:
        _add_node(nodes, entry.ref, entry.resolved)
        if not entry.resolved:
            continue
        for reference in entry.refs:
            _add_node(nodes, reference["ref"], False)
            edges.append(
                {"from": entry.ref, "to": reference["ref"], "fieldPath": reference["fieldPath"]}
            )

    resolved = {entry.ref for entry in entries if entry.resolved}
    for node in nodes.values():
        if node["ref"] in resolved:
            node["resolved"] = True

    return {"nodes": nodes, "edges": edges, "diagnostics": list(diagnostics)}


def _add_node(nodes: dict[str, ReferenceGraphNode], ref: str, resolved: bool) -> None:
    existing = nodes.get(ref)
    if existing is not None:
        if resolved:
            existing["resolved"] = True
        return

    type_name = "<malformed>"
    identifier = ref
    try:
        parsed = parse_ref(ref)
    except FixtureError:
        pass
    else:
        type_name = parsed.type
        identifier = parsed.id

    nodes[ref] = {"ref": ref, "type": type_name, "id": identifier, "resolved": resolved}
