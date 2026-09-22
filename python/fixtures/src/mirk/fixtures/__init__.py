"""Mirk fixtures: authored documents, layered, validated, explained.

The Python port of `@mirk/fixtures`. Zero runtime dependencies: the JSON Schema
engine is injected into the loader, never imported here, so this package stays
as free of an engine choice as `@mirk/fixtures` is of Ajv.

``mirk`` is a PEP 420 namespace package — there is no ``mirk/__init__.py`` in
either distribution — so ``mirk.store`` and ``mirk.fixtures`` install side by
side without shadowing one another.
"""

from .conformance import conformance_target, json_schema_validator_factory
from .errors import (
    FixtureError,
    FixtureValidationError,
    diagnostics_from_error,
    format_issue_path,
)
from .layering import (
    clone_jsonish,
    is_patch_document,
    is_plain_object,
    js_entries,
    merge_with_strategy,
    normalize_layers,
    patch_body,
)
from .loader import FixtureLoader, create_fixture_loader
from .reference_graph import GraphBuildEntry, build_reference_graph
from .refs import (
    ParsedRef,
    format_ref,
    is_canonical_ref,
    is_explicit_ref,
    parse_ref,
    ref_string,
)
from .registry import FixtureRegistry, create_fixture_registry
from .types import (
    Diagnostic,
    ExtractedReference,
    FixtureProvenance,
    FixtureProvenanceLayer,
    FixtureSource,
    FixtureSourceEntry,
    FixtureTypeDefinition,
    JsonSchemaDocument,
    JsonSchemaValidatorFactory,
    LayeredSource,
    LoadedFixture,
    ReferenceGraph,
    ReferenceMode,
    SchemaIssue,
    SchemaResult,
    ValidationReport,
)

__all__ = [
    "Diagnostic",
    "ExtractedReference",
    "FixtureError",
    "FixtureLoader",
    "FixtureProvenance",
    "FixtureProvenanceLayer",
    "FixtureRegistry",
    "FixtureSource",
    "FixtureSourceEntry",
    "FixtureTypeDefinition",
    "FixtureValidationError",
    "GraphBuildEntry",
    "JsonSchemaDocument",
    "JsonSchemaValidatorFactory",
    "LayeredSource",
    "LoadedFixture",
    "ParsedRef",
    "ReferenceGraph",
    "ReferenceMode",
    "SchemaIssue",
    "SchemaResult",
    "ValidationReport",
    "build_reference_graph",
    "clone_jsonish",
    "conformance_target",
    "create_fixture_loader",
    "create_fixture_registry",
    "diagnostics_from_error",
    "format_issue_path",
    "format_ref",
    "is_canonical_ref",
    "is_explicit_ref",
    "is_patch_document",
    "is_plain_object",
    "js_entries",
    "json_schema_validator_factory",
    "merge_with_strategy",
    "normalize_layers",
    "parse_ref",
    "patch_body",
    "ref_string",
]
