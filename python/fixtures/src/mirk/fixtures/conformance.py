"""Conformance target for the `fixtures` port.

The runner resolves `mirk.store.fixtures` first and `mirk.fixtures` second, so
this factory is re-exported from the package root. One target is built per
scenario per backend; the first step is always `configure(spec)`, which builds
the registry and the sources declared as JSON, writing store-source items
through the backend store before the source is constructed.

The JSON Schema engine is injected here, never imported by the package: the
corpus compares the *set of failing instance paths*, so `jsonschema` and Ajv
only have to agree about which parts of a document are wrong, not about how to
word it.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Sequence
from typing import Any

from .loader import FixtureLoader
from .registry import FixtureRegistry
from .sources.memory import MemoryFixtureSource
from .sources.store import StoreFixtureSource, seed_store_from_fixtures
from .types import (
    FixtureSource,
    FixtureTypeDefinition,
    JsonSchemaDocument,
    LayeredSource,
    SchemaIssue,
)

__all__ = ["conformance_target", "json_schema_validator_factory"]

# `anyOf`, `oneOf`, `if` and `not` report "some combination failed" at a path
# the two engines spell differently, so the aggregate is dropped whenever the
# branch failures underneath say the same thing. When there are none — an
# overlapping `oneOf`, a `not` whose subschema matched — dropping it would
# report zero issues and call an invalid document valid, so it is kept.
_AGGREGATE_KEYWORDS = frozenset({"anyOf", "oneOf", "if", "not"})

_DECLARABLE_FIELDS = (
    "extensions",
    "document",
    "purpose",
    "referenceMode",
    "mergeStrategy",
)


def json_schema_validator_factory(
    document: JsonSchemaDocument,
) -> Callable[[Any], Sequence[SchemaIssue]]:
    """Compile a schema document with `jsonschema`'s draft 2020-12 validator."""
    from jsonschema.validators import Draft202012Validator

    validator: Any = Draft202012Validator(document)

    def validate(value: Any) -> list[SchemaIssue]:
        issues: list[SchemaIssue] = []
        for error in validator.iter_errors(value):
            for leaf in _leaf_errors(error):
                issues.append({"message": str(leaf.message), "path": list(leaf.absolute_path)})
        return issues

    return validate


def _leaf_errors(error: Any) -> Iterator[Any]:
    """The errors an aggregate stands for, or the error itself.

    An aggregate keyword nests its branch failures in ``context``. Flatten
    those and report them instead of the aggregate, which is the path spelling
    the two engines share. An aggregate with nothing underneath it — ``not``
    never has context, and an overlapping ``oneOf`` reports only that too many
    branches matched — is yielded as itself, because dropping it would erase
    the only evidence the document is invalid.
    """
    context: Any = getattr(error, "context", None)
    if error.validator in _AGGREGATE_KEYWORDS:
        nested: list[Any] = list(context) if context else []
        leaves = [leaf for sub in nested for leaf in _leaf_errors(sub)]
        if leaves:
            yield from leaves
            return
        yield error
        return
    if context:
        for sub in context:
            yield from _leaf_errors(sub)
        return
    yield error


class _FixturesTarget:
    """One scenario's loader, plus the backend store it seeds into."""

    def __init__(self, connection: Any) -> None:
        self._store = connection
        self._loader: FixtureLoader | None = None
        self._types: list[str] = []

    # ── Setup ────────────────────────────────────────────────────────────

    def configure(self, spec: dict[str, Any]) -> None:
        if self._loader is not None:
            raise RuntimeError("fixtures target: configure(spec) was already called.")
        registry = FixtureRegistry()
        for declared in spec.get("types", []):
            registry.register(_type_definition(declared))
        self._types = registry.types()

        sources: list[FixtureSource | LayeredSource] = []
        for declared in spec.get("sources", []):
            sources.append(self._build_source(declared))

        self._loader = FixtureLoader(
            registry,
            sources,
            reference_mode=spec.get("referenceMode"),
            json_schema_validator=json_schema_validator_factory,
        )

    def _build_source(self, declared: dict[str, Any]) -> LayeredSource:
        kind = declared["kind"]
        name = str(declared["name"])
        if kind == "memory":
            source: FixtureSource = MemoryFixtureSource(name, dict(declared.get("files", {})))
        elif kind == "store":
            collection = str(declared["collection"])
            for item in declared.get("items", []):
                self._store.put(collection, _store_row(declared, item))
            source = StoreFixtureSource(
                name,
                self._store,
                collection,
                path_prefix=declared.get("pathPrefix"),
            )
        else:
            raise ValueError(f"unknown source kind: {kind!r}")
        return LayeredSource(source, name, float(declared["priority"]))

    # ── Ops ──────────────────────────────────────────────────────────────

    @property
    def _ready(self) -> FixtureLoader:
        if self._loader is None:
            raise RuntimeError("configure(spec) must run before any other fixtures op")
        return self._loader

    def load(self, ref: str) -> Any:
        return self._ready.load(ref)

    def list(self, type_name: str | None = None) -> list[str]:
        return self._ready.list(type_name)

    def types(self) -> list[str]:
        return list(self._types)

    def validate(self, ref: str | None = None) -> dict[str, Any]:
        return dict(self._ready.validate(ref))

    def validateDiagnostics(self, ref: str | None = None) -> list[Any]:
        """The report's diagnostics alone, so the `values` form can compare
        them with `ignoreFields: ["message"]`. That is how a `parse-failed`
        diagnostic is pinned without the host parser's wording reaching the
        corpus."""
        return list(self._ready.validate(ref)["diagnostics"])

    def explain(self, ref: str) -> dict[str, Any]:
        return dict(self._ready.loadRaw(ref)["provenance"])

    def referenceGraph(self) -> dict[str, Any]:
        """A JavaScript `Map` has no JSON form, so `nodes` becomes an array
        sorted by ref, and every field path segment is rendered as text: an
        array index is a number in memory and a string on the wire, and the
        corpus compares the wire form."""
        graph = self._ready.referenceGraph()
        edges = [
            {
                "from": edge["from"],
                "to": edge["to"],
                "fieldPath": [str(part) for part in edge["fieldPath"]],
            }
            for edge in graph["edges"]
        ]
        return {
            "nodes": sorted(graph["nodes"].values(), key=lambda node: node["ref"]),
            "edges": sorted(edges, key=_edge_key),
            "diagnostics": list(graph["diagnostics"]),
        }

    def resolveRef(self, value: Any, expectedType: str | None = None) -> Any:
        return self._ready.resolveRef(value, expectedType)

    def invalidate(self, ref: str | None = None) -> None:
        self._ready.invalidate(ref)

    def seedStore(self, options: dict[str, Any]) -> dict[str, Any]:
        return seed_store_from_fixtures(
            self._ready,
            self._store,
            targets=dict(options["targets"]),
            mode=str(options.get("mode", "upsert")),
            include_provenance=bool(options.get("includeProvenance", False)),
            validate_before_write=bool(options.get("validateBeforeWrite", True)),
        )

    def readSeeded(self, collection: str, id: str) -> Any:
        return self._store.getById(collection, id)


def _edge_key(edge: dict[str, Any]) -> str:
    field_path = ".".join(str(part) for part in edge["fieldPath"])
    return f"{edge['from']}\u0000{edge['to']}\u0000{field_path}"


def _store_row(source: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    """One row as the backend store will hold it.

    Parsers are JSON only in the corpus, so an item that declares no extension
    gets `.json`; without a default the derived path would end in the text
    "undefined", which is what TypeScript builds from a missing extension.
    """
    row: dict[str, Any] = {
        "id": item["id"],
        "content": item["content"],
        "extension": item.get("extension", source.get("extension", ".json")),
    }
    if "relativePath" in item:
        row["relativePath"] = item["relativePath"]
    return row


def _type_definition(declared: dict[str, Any]) -> FixtureTypeDefinition:
    """Turn a corpus type declaration into a definition.

    `jsonSchema` defaults to the document `true`, which accepts everything, so
    a scenario that does not care about validation declares nothing.
    """
    definition: FixtureTypeDefinition = {
        "type": str(declared["type"]),
        "directory": str(declared["directory"]),
    }
    # An explicit null declares NO schema, which is how a scenario reaches the
    # registry's `missing-schema` rejection. Omitted means the document `true`.
    if declared.get("jsonSchema", True) is not None:
        definition["jsonSchema"] = declared.get("jsonSchema", True)
    for field in _DECLARABLE_FIELDS:
        if field in declared:
            definition[field] = declared[field]  # type: ignore[literal-required]
    return definition


def conformance_target(backend: str, connection: object) -> object:
    """`backend` is informational; both backends run the same fixtures code
    over whichever store the runner opened."""
    del backend
    return _FixturesTarget(connection)
