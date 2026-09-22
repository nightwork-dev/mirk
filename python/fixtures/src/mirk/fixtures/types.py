"""Public types for `mirk.fixtures`.

Two conventions carry over from `mirk.store` and are load-bearing:

- **Method names keep the TypeScript camelCase spelling** (`loadRaw`,
  `referenceGraph`), so the conformance corpus dispatches an `op` string
  straight onto a loader with no translation table.
- **Every structured result is a plain `dict` with the TypeScript key
  spelling** (`fieldPath`, `sourceId`, `finalRef`). A port that renamed these
  would need a mapping layer at the corpus boundary, and the mapping is where
  the two languages would drift.

A fixture type definition is a `TypedDict` for the same reason: the corpus
declares one as JSON, so the in-memory shape and the wire shape are the same
object.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any, Literal, Protocol, TypedDict, runtime_checkable

__all__ = [
    "BuiltinMergeStrategy",
    "Diagnostic",
    "DiagnosticSeverity",
    "ExtractedReference",
    "FixtureMapDocument",
    "FixtureProvenance",
    "FixtureProvenanceLayer",
    "FixtureProvenanceLayerKind",
    "FixturePurpose",
    "FixtureSource",
    "FixtureSourceEntry",
    "FixtureTypeDefinition",
    "JsonSchemaDocument",
    "JsonSchemaValidatorFactory",
    "LayeredSource",
    "LoadedFixture",
    "MaterializationContext",
    "MergeContext",
    "MergeStrategy",
    "Parser",
    "PathSegment",
    "ReferenceGraph",
    "ReferenceGraphEdge",
    "ReferenceGraphNode",
    "ReferenceMode",
    "SchemaIssue",
    "SchemaResult",
    "ValidationContext",
    "ValidationReport",
]

DiagnosticSeverity = Literal["info", "warning", "error"]
FixturePurpose = Literal["archetype", "component", "lookup", "factory", "raw"]
BuiltinMergeStrategy = Literal["replace", "deep", "array-replace"]
ReferenceMode = Literal["explicit-only", "explicit-and-bare"]
FixtureProvenanceLayerKind = Literal["base", "replace", "patch", "shadowed"]

PathSegment = str | int
"""One step of a field path. Object keys are strings, array indices are ints."""

JsonSchemaDocument = dict[str, Any] | bool
"""A JSON Schema document. `True` accepts everything, `False` rejects everything."""


class _DiagnosticBase(TypedDict):
    severity: DiagnosticSeverity
    code: str
    message: str


class Diagnostic(_DiagnosticBase, total=False):
    """One reported problem. `range` is deliberately absent: no parser here
    produces source positions, so the field would never be populated."""

    fixture: str
    source: str
    path: str
    fieldPath: str
    hint: str


class SchemaIssue(TypedDict, total=False):
    """One validation failure, shaped like a Standard Schema issue."""

    message: str
    path: Sequence[PathSegment]


class SchemaResult(TypedDict, total=False):
    """What a `schema` callable returns: a transformed value, or issues."""

    value: Any
    issues: Sequence[SchemaIssue]


JsonSchemaValidatorFactory = Callable[[JsonSchemaDocument], Callable[[Any], Sequence[SchemaIssue]]]
"""Compiles a schema document once into a reusable validator.

Injected, never imported: `mirk.fixtures` has no runtime dependency on a JSON
Schema engine, exactly as `@mirk/fixtures` has none on Ajv.
"""

Parser = Callable[[str], Any]


class FixtureSourceEntry(TypedDict):
    """`relativePath` is public and normalized; `locator` is opaque to the loader."""

    relativePath: str
    locator: str


@runtime_checkable
class FixtureSource(Protocol):
    """Where authored documents come from. Synchronous, like every Mirk port."""

    @property
    def id(self) -> str: ...

    def list(self) -> list[FixtureSourceEntry]: ...

    def read(self, entry: FixtureSourceEntry) -> str: ...


class FixtureMapDocument(TypedDict, total=False):
    """Opt in to one file producing one fixture per top-level key."""

    kind: Literal["map"]
    idField: str


class MergeContext(TypedDict):
    """Handed to a callable merge strategy. `layers` excludes the layer being applied."""

    fixture: str
    layers: list[dict[str, Any]]


MergeStrategy = BuiltinMergeStrategy | Callable[[Any, Any, MergeContext], Any]


class ExtractedReference(TypedDict):
    ref: str
    fieldPath: list[PathSegment]


class _FixtureTypeDefinitionBase(TypedDict):
    type: str
    directory: str


class FixtureTypeDefinition(_FixtureTypeDefinitionBase, total=False):
    """The authored-data contract for one fixture type.

    The first block is serializable, so the conformance corpus can declare a
    type as JSON. The hook block is code and cannot cross a language boundary;
    each language pins those with its own tests.
    """

    extensions: list[str]
    jsonSchema: JsonSchemaDocument
    schema: Callable[[Any], SchemaResult]
    document: FixtureMapDocument
    purpose: FixturePurpose
    mergeStrategy: MergeStrategy
    referenceMode: ReferenceMode
    validateReferences: Callable[[Any, ValidationContext], Sequence[Diagnostic]]
    extractReferences: Callable[[Any], Sequence[ExtractedReference]]
    materialize: Callable[[Any, MaterializationContext], Any]


class ValidationContext(TypedDict):
    ref: str
    has: Callable[[str], bool]
    loadRaw: Callable[[str], Any]


class MaterializationContext(TypedDict):
    ref: str
    loadRaw: Callable[[str], Any]
    materialize: Callable[[str], Any]


class FixtureProvenanceLayer(TypedDict):
    sourceId: str
    layer: str
    priority: float
    path: str
    kind: FixtureProvenanceLayerKind


class FixtureProvenance(TypedDict):
    finalRef: str
    layers: list[FixtureProvenanceLayer]


class LoadedFixture(TypedDict):
    ref: str
    type: str
    id: str
    value: Any
    provenance: FixtureProvenance


class ReferenceGraphNode(TypedDict):
    ref: str
    type: str
    id: str
    resolved: bool


# `from` is a Python keyword, so this one key can only be spelled functionally.
# The TypeScript spelling is kept because the corpus compares the key.
ReferenceGraphEdge = TypedDict(
    "ReferenceGraphEdge", {"from": str, "to": str, "fieldPath": list[PathSegment]}
)


class ReferenceGraph(TypedDict):
    """`nodes` is keyed by ref and preserves insertion order, mirroring the
    TypeScript `Map`."""

    nodes: dict[str, ReferenceGraphNode]
    edges: list[ReferenceGraphEdge]
    diagnostics: list[Diagnostic]


class ValidationReport(TypedDict):
    ok: bool
    diagnostics: list[Diagnostic]


class LayeredSource:
    """A source with an explicit layer name and priority.

    Bare sources get a layer of `source.id` and a priority of their declaration
    index, so mixing the two forms is legal and the implicit priorities are
    indexes, not zeros.
    """

    __slots__ = ("layer", "priority", "source")

    def __init__(self, source: FixtureSource, layer: str, priority: float) -> None:
        self.source = source
        self.layer = layer
        self.priority = priority
