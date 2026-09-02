"""The fixture loader: matching, map expansion, layering, validation, references.

Synchronous by design, like every Mirk port. The TypeScript loader is `async`
only because its suspension points (source I/O, parsers, the schema validator,
the user hooks) are declared `MaybePromise`; nothing in the semantics needs it.

The whole pipeline is pure above the source boundary, which is what makes the
shared conformance corpus possible.
"""

from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any, NamedTuple, cast

from mirk.store.filter import normalize_json_numbers

from .errors import FixtureError, FixtureValidationError, diagnostics_from_error
from .layering import (
    NormalizedLayeredSource,
    is_patch_document,
    js_entries,
    merge_with_strategy,
    normalize_layers,
    patch_body,
    provenance_ctx,
)
from .reference_graph import GraphBuildEntry, build_reference_graph
from .refs import is_canonical_ref, is_explicit_ref, parse_ref
from .types import (
    Diagnostic,
    ExtractedReference,
    FixtureProvenanceLayer,
    FixtureSource,
    FixtureSourceEntry,
    FixtureTypeDefinition,
    JsonSchemaValidatorFactory,
    LayeredSource,
    LoadedFixture,
    Parser,
    PathSegment,
    ReferenceGraph,
    ReferenceMode,
    SchemaIssue,
    ValidationReport,
)

__all__ = ["FixtureLoader", "create_fixture_loader", "parse_json_document"]

_MAX_REFERENCE_DEPTH = 32
_MISSING = object()


def _reject_json_constant(constant: str) -> Any:
    raise ValueError(f"Unexpected token {constant[0]!r} in JSON")


def parse_json_document(text: str) -> Any:
    """Parse a fixture document the way `JSON.parse` does.

    `json.loads` differs from the JavaScript parser in two ways that change what
    a document MEANS, so both are corrected here rather than left as a silent
    per-language reading of one file:

    * `NaN`, `Infinity` and `-Infinity` are bare literals CPython accepts and
      JavaScript rejects, so they raise and become a `parse-failed` diagnostic.
    * An integer above 2^53 stays exact in Python and rounds to the nearest
      float64 in JavaScript. `normalize_json_numbers` applies the same rounding
      the store already applies on its write path.
    """
    return normalize_json_numbers(json.loads(text, parse_constant=_reject_json_constant))


class _FileCandidate(NamedTuple):
    layered: NormalizedLayeredSource
    entry: FixtureSourceEntry
    ext: str
    fileId: str


class _ParsedLayer(NamedTuple):
    layered: NormalizedLayeredSource
    entry: FixtureSourceEntry
    ext: str
    fileId: str
    id: str
    parsed: Any
    sourcePath: str


class FixtureLoader:
    """Loads, layers, validates and explains authored fixtures.

    Method names keep the TypeScript spelling so a corpus `op` dispatches
    directly onto this object.
    """

    def __init__(
        self,
        registry: Any,
        sources: Sequence[FixtureSource | LayeredSource],
        parsers: dict[str, Parser] | None = None,
        reference_mode: ReferenceMode | None = None,
        json_schema_validator: JsonSchemaValidatorFactory | None = None,
    ) -> None:
        self._registry = registry
        self._layered = normalize_layers(sources)
        _assert_distinct_source_ids(self._layered)
        self._parsers: dict[str, Parser] = {".json": parse_json_document}
        if parsers:
            self._parsers.update(parsers)
        self._reference_mode: ReferenceMode | None = reference_mode
        self._json_schema_validator = json_schema_validator
        self._compiled: dict[str, Callable[[Any], Sequence[SchemaIssue]]] = {}
        self._raw_cache: dict[str, LoadedFixture] = {}
        self._material_cache: dict[str, Any] = {}
        self._parsed_document_cache: dict[str, Any] = {}

    # ── Type and entry matching ──────────────────────────────────────────

    def _def_or_throw(self, type_name: str, ref_for_error: str) -> FixtureTypeDefinition:
        definition = self._registry.get(type_name)
        if definition is None:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "unknown-type",
                    "message": f'Unknown fixture type "{type_name}".',
                    "fixture": ref_for_error,
                    "hint": f'Register fixture type "{type_name}" before loading it.',
                }
            )
        return definition

    def _extensions_for(self, definition: FixtureTypeDefinition) -> list[str]:
        declared = definition.get("extensions")
        if declared:
            return list(declared)
        return list(self._parsers)

    def _dir_prefix(self, definition: FixtureTypeDefinition) -> str:
        directory = definition["directory"]
        if directory in ("", "/"):
            return ""
        return directory if directory.endswith("/") else f"{directory}/"

    def _match_entry(
        self,
        definition: FixtureTypeDefinition,
        entry: FixtureSourceEntry,
        target_id: str | None = None,
    ) -> tuple[str, str] | None:
        """Match one source entry to a fixture id and the extension that won.

        First-match-wins over an ordered extension list, compared with
        `endswith`, so declaring `[".json", ".min.json"]` parses `a.min.json`
        as `a.min` and the reversed list parses it as `a`.
        """
        prefix = self._dir_prefix(definition)
        relative_path = entry["relativePath"]
        if prefix and not relative_path.startswith(prefix):
            return None

        tail = relative_path[len(prefix) :] if prefix else relative_path
        if "/" in tail:
            return None

        ext = next((c for c in self._extensions_for(definition) if tail.endswith(c)), None)
        if ext is None:
            return None

        identifier = tail[: len(tail) - len(ext)]
        if not identifier:
            return None
        if target_id is not None and identifier != target_id:
            return None
        return (identifier, ext)

    def _no_parser_diagnostic(
        self,
        definition: FixtureTypeDefinition,
        entry: FixtureSourceEntry,
        source_id: str,
    ) -> Diagnostic | None:
        prefix = self._dir_prefix(definition)
        relative_path = entry["relativePath"]
        if prefix and not relative_path.startswith(prefix):
            return None
        tail = relative_path[len(prefix) :] if prefix else relative_path
        if not tail or "/" in tail:
            return None
        dot = tail.rfind(".")
        if dot <= 0:
            return None
        ext = tail[dot:]
        if ext in self._parsers:
            return None
        return {
            "severity": "error",
            "code": "no-parser",
            "message": f'No parser registered for "{ext}".',
            "source": source_id,
            "path": relative_path,
            "hint": f'Pass a parser for "{ext}" to createFixtureLoader().',
        }

    def _list_entries(self, layered: NormalizedLayeredSource) -> list[FixtureSourceEntry]:
        try:
            return list(layered.source.list())
        except Exception as error:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "source-list-failed",
                    "message": (
                        f'Source "{layered.source.id}" failed to list entries: {_message_of(error)}'
                    ),
                    "source": layered.source.id,
                }
            ) from error

    def _find_candidates(
        self, type_name: str, identifier: str, skip_sources: frozenset[str]
    ) -> list[_FileCandidate]:
        definition = self._def_or_throw(type_name, f"{type_name}:{identifier}")
        out: list[_FileCandidate] = []
        for layered in self._layered:
            if layered.source.id in skip_sources:
                continue
            for entry in self._list_entries(layered):
                match = self._match_entry(
                    definition,
                    entry,
                    None if definition.get("document") is not None else identifier,
                )
                if match is None:
                    continue
                out.append(_FileCandidate(layered, entry, match[1], match[0]))
        return out

    def _find_all_file_candidates(
        self, definition: FixtureTypeDefinition, skip_sources: frozenset[str]
    ) -> list[_FileCandidate]:
        out: list[_FileCandidate] = []
        for layered in self._layered:
            if layered.source.id in skip_sources:
                continue
            for entry in self._list_entries(layered):
                match = self._match_entry(definition, entry)
                if match is not None:
                    out.append(_FileCandidate(layered, entry, match[1], match[0]))
        return out

    # ── Reading and parsing ──────────────────────────────────────────────

    def _read_and_parse(self, candidate: _FileCandidate) -> Any:
        # The matched EXTENSION is part of the key. Two types can match the
        # same file through different extension lists, and so through
        # different parsers; without the extension the second type would read
        # the first one's parse.
        cache_key = "\u0000".join(
            [
                candidate.layered.source.id,
                candidate.entry["locator"],
                candidate.entry["relativePath"],
                candidate.ext,
            ]
        )
        cached = self._parsed_document_cache.get(cache_key, _MISSING)
        if cached is not _MISSING:
            return cached

        parser = self._parsers.get(candidate.ext)
        if parser is None:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "no-parser",
                    "message": f'No parser registered for "{candidate.ext}".',
                    "source": candidate.layered.source.id,
                    "path": candidate.entry["relativePath"],
                    "hint": (f'Pass a parser for "{candidate.ext}" to createFixtureLoader().'),
                }
            )

        try:
            content = candidate.layered.source.read(candidate.entry)
        except Exception as error:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "source-read-failed",
                    "message": (
                        f'Source "{candidate.layered.source.id}" failed to read '
                        f'"{candidate.entry["relativePath"]}": {_message_of(error)}'
                    ),
                    "source": candidate.layered.source.id,
                    "path": candidate.entry["relativePath"],
                }
            ) from error

        try:
            value = parser(content)
        except Exception as error:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "parse-failed",
                    "message": f"Parse error: {_message_of(error)}",
                    "source": candidate.layered.source.id,
                    "path": candidate.entry["relativePath"],
                }
            ) from error
        self._parsed_document_cache[cache_key] = value
        return value

    def _expand_map_document(
        self, definition: FixtureTypeDefinition, candidate: _FileCandidate
    ) -> list[_ParsedLayer]:
        parsed = self._read_and_parse(candidate)
        document = definition.get("document")
        if document is None:
            return [
                _ParsedLayer(
                    candidate.layered,
                    candidate.entry,
                    candidate.ext,
                    candidate.fileId,
                    candidate.fileId,
                    parsed,
                    candidate.entry["relativePath"],
                )
            ]

        if not isinstance(parsed, dict):
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "invalid-map-document",
                    "message": (
                        "Fixture map documents must parse to an object keyed by fixture id."
                    ),
                    "source": candidate.layered.source.id,
                    "path": candidate.entry["relativePath"],
                }
            )

        layers: list[_ParsedLayer] = []
        id_field = document.get("idField")
        for identifier, raw_value in js_entries(cast(dict[str, Any], parsed)):
            value: Any = raw_value
            if id_field:
                if not isinstance(value, dict):
                    raise FixtureError(
                        {
                            "severity": "error",
                            "code": "invalid-map-fixture",
                            "message": (
                                f'Fixture "{definition["type"]}:{identifier}" must be an '
                                f'object to inject "{id_field}".'
                            ),
                            "fixture": f"{definition['type']}:{identifier}",
                            "source": candidate.layered.source.id,
                            "path": f"{candidate.entry['relativePath']}#{identifier}",
                        }
                    )
                record = cast(dict[str, Any], value)
                explicit_id = record.get(id_field, _MISSING)
                if explicit_id is not _MISSING and explicit_id != identifier:
                    raise FixtureError(
                        {
                            "severity": "error",
                            "code": "map-id-mismatch",
                            "message": (
                                f'Map key "{identifier}" does not match explicit '
                                f'{id_field} "{_js_string(explicit_id)}".'
                            ),
                            "fixture": f"{definition['type']}:{identifier}",
                            "source": candidate.layered.source.id,
                            "path": f"{candidate.entry['relativePath']}#{identifier}",
                        }
                    )
                if not is_patch_document(value) and explicit_id is _MISSING:
                    # Prepended, so the injected id lands first in key order.
                    value = {id_field: identifier, **record}
            layers.append(
                _ParsedLayer(
                    candidate.layered,
                    candidate.entry,
                    candidate.ext,
                    candidate.fileId,
                    identifier,
                    value,
                    f"{candidate.entry['relativePath']}#{identifier}",
                )
            )
        return layers

    def _parsed_candidates(
        self,
        type_name: str,
        target_id: str | None,
        skip_sources: frozenset[str] = frozenset(),
    ) -> list[_ParsedLayer]:
        definition = self._def_or_throw(
            type_name, f"{type_name}:{target_id}" if target_id else type_name
        )
        candidates = (
            self._find_candidates(type_name, target_id, skip_sources)
            if target_id
            else self._find_all_file_candidates(definition, skip_sources)
        )
        parsed: list[_ParsedLayer] = []
        seen: set[str] = set()
        for candidate in candidates:
            for layer in self._expand_map_document(definition, candidate):
                if target_id is not None and layer.id != target_id:
                    continue
                key = "\u0000".join(
                    [
                        layer.layered.source.id,
                        layer.layered.layer,
                        _js_string(layer.layered.priority),
                        layer.id,
                    ]
                )
                if key in seen:
                    raise FixtureError(
                        {
                            "severity": "error",
                            "code": "duplicate-map-fixture",
                            "message": (
                                f'Fixture "{type_name}:{layer.id}" appears more than once '
                                f"in the same source layer."
                            ),
                            "fixture": f"{type_name}:{layer.id}",
                            "source": layer.layered.source.id,
                            "path": layer.sourcePath,
                        }
                    )
                seen.add(key)
                parsed.append(layer)
        return parsed

    # ── Validation ───────────────────────────────────────────────────────

    def _validator_for(
        self, definition: FixtureTypeDefinition
    ) -> Callable[[Any], Sequence[SchemaIssue]]:
        type_name = definition["type"]
        compiled = self._compiled.get(type_name)
        if compiled is not None:
            return compiled
        if self._json_schema_validator is None:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "no-json-schema-validator",
                    "message": (
                        f'Fixture type "{type_name}" declares "jsonSchema" but no '
                        f"JSON Schema validator was supplied."
                    ),
                    "hint": "Pass jsonSchemaValidator to createFixtureLoader().",
                }
            )
        compiled = self._json_schema_validator(definition.get("jsonSchema", True))
        self._compiled[type_name] = compiled
        return compiled

    def _validate_against_schema(
        self,
        ref: str,
        source_id: str,
        relative_path: str,
        parsed: Any,
        definition: FixtureTypeDefinition,
    ) -> Any:
        """The JSON Schema document runs first; the Standard-Schema-style
        callable runs second and its **output** becomes the value."""
        value = parsed
        if definition.get("jsonSchema") is not None:
            issues = self._validator_for(definition)(value)
            if issues:
                raise FixtureValidationError(ref, source_id, relative_path, issues)

        schema = definition.get("schema")
        if callable(schema):
            result = schema(value)
            result_issues = result.get("issues")
            if result_issues:
                raise FixtureValidationError(ref, source_id, relative_path, result_issues)
            value = result.get("value")
        return value

    # ── Loading ──────────────────────────────────────────────────────────

    def loadRaw(self, ref: str) -> LoadedFixture:
        return self._load_raw_internal(ref, frozenset())

    def load(self, ref: str) -> Any:
        return self.loadRaw(ref)["value"]

    def _load_raw_internal(self, ref: str, skip_sources: frozenset[str]) -> LoadedFixture:
        can_cache = not skip_sources
        if can_cache:
            cached = self._raw_cache.get(ref)
            if cached is not None:
                return cached

        type_name, identifier = parse_ref(ref)
        definition = self._def_or_throw(type_name, ref)
        parsed_layers = self._parsed_candidates(type_name, identifier, skip_sources)

        if not parsed_layers:
            extensions = ", ".join(self._extensions_for(definition))
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "not-found",
                    "message": f'Fixture "{ref}" not found in any registered source.',
                    "fixture": ref,
                    "hint": (
                        f'Looked under "{self._dir_prefix(definition)}{identifier}" '
                        f"with extensions {extensions}."
                    ),
                }
            )

        # Every patch is checked against the ref before base selection, so a
        # patch that would be shadowed still reports a mismatched $patch.
        for layer in parsed_layers:
            if is_patch_document(layer.parsed) and layer.parsed["$patch"] != ref:
                raise FixtureError(
                    {
                        "severity": "error",
                        "code": "patch-ref-mismatch",
                        "message": (
                            f'Patch declares "$patch: {layer.parsed["$patch"]}" but is '
                            f'being applied to "{ref}".'
                        ),
                        "fixture": ref,
                        "source": layer.layered.source.id,
                        "path": layer.sourcePath,
                    }
                )

        base_idx = -1
        for index in range(len(parsed_layers) - 1, -1, -1):
            if not is_patch_document(parsed_layers[index].parsed):
                base_idx = index
                break

        if base_idx < 0:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "patch-without-base",
                    "message": f'Fixture "{ref}" has patches but no base document.',
                    "fixture": ref,
                    "hint": (
                        "At least one layer must contain a full fixture document without $patch."
                    ),
                }
            )

        base_layer = parsed_layers[base_idx]
        current = self._validate_against_schema(
            ref, base_layer.layered.source.id, base_layer.sourcePath, base_layer.parsed, definition
        )

        provenance: list[FixtureProvenanceLayer] = []
        for layer in parsed_layers[:base_idx]:
            provenance.append(
                {
                    "sourceId": layer.layered.source.id,
                    "layer": layer.layered.layer,
                    "priority": layer.layered.priority,
                    "path": layer.sourcePath,
                    "kind": "shadowed" if is_patch_document(layer.parsed) else "replace",
                }
            )

        provenance.append(
            {
                "sourceId": base_layer.layered.source.id,
                "layer": base_layer.layered.layer,
                "priority": base_layer.layered.priority,
                "path": base_layer.sourcePath,
                "kind": "base",
            }
        )

        for layer in parsed_layers[base_idx + 1 :]:
            if not is_patch_document(layer.parsed):
                continue
            if layer.layered.priority <= base_layer.layered.priority:
                provenance.append(
                    {
                        "sourceId": layer.layered.source.id,
                        "layer": layer.layered.layer,
                        "priority": layer.layered.priority,
                        "path": layer.sourcePath,
                        "kind": "shadowed",
                    }
                )
                continue

            merged = merge_with_strategy(
                definition.get("mergeStrategy"),
                current,
                patch_body(layer.parsed),
                {"fixture": ref, "layers": provenance_ctx(provenance)},
            )
            current = self._validate_against_schema(
                ref, layer.layered.source.id, layer.sourcePath, merged, definition
            )
            provenance.append(
                {
                    "sourceId": layer.layered.source.id,
                    "layer": layer.layered.layer,
                    "priority": layer.layered.priority,
                    "path": layer.sourcePath,
                    "kind": "patch",
                }
            )

        loaded: LoadedFixture = {
            "ref": ref,
            "type": type_name,
            "id": identifier,
            "value": current,
            "provenance": {"finalRef": ref, "layers": provenance},
        }
        if can_cache:
            self._raw_cache[ref] = loaded
        return loaded

    def list(self, type_name: str | None = None) -> list[str]:
        refs: set[str] = set()
        if type_name is not None:
            types = [type_name] if self._registry.has(type_name) else []
        else:
            types = self._registry.types()

        for name in types:
            if self._registry.get(name) is None:
                continue
            for candidate in self._parsed_candidates(name, None):
                refs.add(f"{name}:{candidate.id}")

        return sorted(refs)

    def resolveRef(self, value: Any, expectedType: str | None = None) -> Any:
        if is_explicit_ref(value):
            ref = str(value["$ref"])
            type_name = parse_ref(ref).type
            if expectedType and type_name != expectedType:
                raise _type_mismatch(expectedType, type_name, ref)
            return self.load(ref)

        if (
            isinstance(value, str)
            and is_canonical_ref(value)
            and self._bare_refs_enabled_for(value, expectedType)
        ):
            type_name = parse_ref(value).type
            if expectedType and type_name != expectedType:
                raise _type_mismatch(expectedType, type_name, value)
            return self.load(value)

        if expectedType:
            definition = self._def_or_throw(expectedType, f"<inline {expectedType}>")
            return self._validate_against_schema(
                f"<inline {expectedType}>", "<inline>", "<inline>", value, definition
            )

        return value

    def validate(self, ref: str | None = None) -> ValidationReport:
        diagnostics: list[Diagnostic] = []
        skipped: set[str] = set()
        refs = [ref] if ref else self._discover_refs_for_validation(diagnostics, skipped)

        for current_ref in refs:
            try:
                loaded = self._load_raw_internal(current_ref, frozenset(skipped))
                definition = self._registry.get(loaded["type"])
                diagnostics.extend(
                    self._validate_extracted_references(
                        loaded["ref"], loaded["value"], definition, frozenset(skipped)
                    )
                )
                hook = definition.get("validateReferences") if definition else None
                if hook is not None:
                    issues = hook(
                        loaded["value"],
                        self._validation_context(loaded["ref"], frozenset(skipped)),
                    )
                    for issue in issues:
                        stamped: Diagnostic = {"fixture": loaded["ref"], **issue}  # type: ignore[typeddict-item]
                        diagnostics.append(stamped)
            except Exception as error:
                diagnostics.extend(diagnostics_from_error(current_ref, error))

        ok = all(diagnostic["severity"] != "error" for diagnostic in diagnostics)
        return {"ok": ok, "diagnostics": diagnostics}

    def referenceGraph(self) -> ReferenceGraph:
        entries: list[GraphBuildEntry] = []
        for ref in self.list():
            try:
                loaded = self.loadRaw(ref)
            except Exception:
                entries.append(GraphBuildEntry(ref, None, False, []))
                continue
            definition = self._registry.get(loaded["type"])
            entries.append(
                GraphBuildEntry(
                    ref,
                    loaded["value"],
                    True,
                    self._extract_references(loaded["value"], definition),
                )
            )

        diagnostics: list[Diagnostic] = []
        for entry in entries:
            if not entry.resolved:
                continue
            for extracted in entry.refs:
                try:
                    parse_ref(extracted["ref"])
                except FixtureError:
                    diagnostics.append(
                        {
                            "severity": "error",
                            "code": "invalid-ref",
                            "message": f'Invalid fixture ref "{extracted["ref"]}".',
                            "fixture": entry.ref,
                            "fieldPath": _path_string(extracted["fieldPath"]),
                        }
                    )

        return build_reference_graph(entries, diagnostics)

    def materialize(self, ref: str) -> Any:
        return self._materialize_internal(ref, [])

    def _materialize_internal(self, ref: str, stack: list[str]) -> Any:
        cached = self._material_cache.get(ref, _MISSING)
        if cached is not _MISSING:
            return cached
        if ref in stack:
            cycle = [*stack[stack.index(ref) :], ref]
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "materialization-cycle",
                    "message": f"Materialization cycle detected: {' -> '.join(cycle)}.",
                    "fixture": ref,
                }
            )

        next_stack = [*stack, ref]
        loaded = self.loadRaw(ref)
        definition = self._registry.get(loaded["type"])

        def materialize_child(child: str) -> Any:
            return self._materialize_internal(child, next_stack)

        hook = definition.get("materialize") if definition else None
        if hook is not None:
            value = hook(
                loaded["value"],
                {
                    # `loadRaw` returns the fixture VALUE here, not a
                    # LoadedFixture. The TypeScript name is wrong the same way.
                    "ref": ref,
                    "loadRaw": self.load,
                    "materialize": materialize_child,
                },
            )
        else:
            value = loaded["value"]
        self._material_cache[ref] = value
        return value

    def invalidate(self, ref: str | None = None) -> None:
        """Clear caches. A single ref still clears the materialization and
        parsed-document caches whole: a materialized value may depend on any
        other fixture."""
        if not ref:
            self._raw_cache.clear()
        else:
            self._raw_cache.pop(ref, None)
        self._material_cache.clear()
        self._parsed_document_cache.clear()

    # ── References ───────────────────────────────────────────────────────

    def _bare_refs_enabled_for(self, ref: str, expected_type: str | None) -> bool:
        if self._reference_mode == "explicit-and-bare":
            return True
        type_name = expected_type if expected_type else parse_ref(ref).type
        definition = self._registry.get(type_name)
        return bool(definition) and definition.get("referenceMode") == "explicit-and-bare"

    def _extract_references(
        self, value: Any, definition: FixtureTypeDefinition | None
    ) -> list[ExtractedReference]:
        mode: ReferenceMode = "explicit-only"
        declared = definition.get("referenceMode") if definition is not None else None
        if declared is not None:
            mode = declared
        elif self._reference_mode is not None:
            mode = self._reference_mode

        out: list[ExtractedReference] = []
        _walk_refs(value, [], out, mode, set(), 0)
        if definition is not None:
            hook = definition.get("extractReferences")
            if hook is not None:
                out.extend(hook(value))
        return _dedupe_references(out)

    def _validate_extracted_references(
        self,
        fixture: str,
        value: Any,
        definition: FixtureTypeDefinition | None,
        skip_sources: frozenset[str],
    ) -> list[Diagnostic]:
        out: list[Diagnostic] = []
        for extracted in self._extract_references(value, definition):
            try:
                parse_ref(extracted["ref"])
            except FixtureError:
                out.append(
                    {
                        "severity": "error",
                        "code": "invalid-ref",
                        "message": f'Invalid fixture ref "{extracted["ref"]}".',
                        "fixture": fixture,
                        "fieldPath": _path_string(extracted["fieldPath"]),
                    }
                )
                continue

            try:
                self._load_raw_internal(extracted["ref"], skip_sources)
            except FixtureError as error:
                if error.diagnostic["code"] != "not-found":
                    raise
                out.append(
                    {
                        "severity": "error",
                        "code": "missing-reference",
                        "message": f'Missing referenced fixture "{extracted["ref"]}".',
                        "fixture": fixture,
                        "fieldPath": _path_string(extracted["fieldPath"]),
                    }
                )
        return out

    def _validation_context(self, ref: str, skip_sources: frozenset[str]) -> dict[str, Any]:
        def has(other_ref: str) -> bool:
            try:
                self._load_raw_internal(other_ref, skip_sources)
            except FixtureError as error:
                if error.diagnostic["code"] == "not-found":
                    return False
                raise
            return True

        def load_raw(other_ref: str) -> Any:
            return self._load_raw_internal(other_ref, skip_sources)["value"]

        return {"ref": ref, "has": has, "loadRaw": load_raw}

    def _discover_refs_for_validation(
        self, diagnostics: list[Diagnostic], skipped: set[str]
    ) -> list[str]:
        """Discover every ref, degrading one broken source at a time.

        A source that fails is added to `skipped` and the type is retried once
        without it, so one bad source yields a diagnostic instead of aborting
        the whole report.
        """
        refs: set[str] = set()
        seen_no_parser: set[str] = set()
        for type_name in self._registry.types():
            definition = self._registry.get(type_name)
            if definition is None:
                continue
            try:
                for candidate in self._parsed_candidates(type_name, None, frozenset(skipped)):
                    refs.add(f"{type_name}:{candidate.id}")
            except Exception as error:
                broken = error.diagnostic.get("source") if isinstance(error, FixtureError) else None
                if broken:
                    skipped.add(broken)
                diagnostics.extend(diagnostics_from_error(type_name, error))
                try:
                    for candidate in self._parsed_candidates(type_name, None, frozenset(skipped)):
                        refs.add(f"{type_name}:{candidate.id}")
                except Exception as remaining:
                    diagnostics.extend(diagnostics_from_error(type_name, remaining))

            for layered in self._layered:
                if layered.source.id in skipped:
                    continue
                try:
                    entries = list(layered.source.list())
                except Exception as error:
                    skipped.add(layered.source.id)
                    diagnostics.append(
                        {
                            "severity": "error",
                            "code": "source-list-failed",
                            "message": (
                                f'Source "{layered.source.id}" failed to list entries: '
                                f"{_message_of(error)}"
                            ),
                            "source": layered.source.id,
                        }
                    )
                    continue
                for entry in entries:
                    if self._match_entry(definition, entry) is not None:
                        continue
                    no_parser = self._no_parser_diagnostic(definition, entry, layered.source.id)
                    if no_parser is None:
                        continue
                    key = "\u0000".join(
                        [
                            no_parser.get("source", ""),
                            no_parser.get("path", ""),
                            no_parser["message"],
                        ]
                    )
                    if key in seen_no_parser:
                        continue
                    seen_no_parser.add(key)
                    diagnostics.append(no_parser)
        return sorted(refs)


def _assert_distinct_source_ids(layers: Sequence[Any]) -> None:
    """Source ids must be distinct across the layer stack.

    The parsed-document cache, the skipped-source set and every diagnostic key
    a source by its id, so two layers sharing one id collapse into each other:
    the lower layer's document is served for the higher one and a source
    skipped for a read error takes its namesake down with it. That is a data
    bug with no local symptom, so it is refused where it is introduced.
    """
    seen: set[str] = set()
    for layered in layers:
        source_id = layered.source.id
        if source_id in seen:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "duplicate-source",
                    "message": f'Duplicate fixture source id "{source_id}".',
                    "source": source_id,
                    "hint": (
                        "Give every fixture source a distinct id; layer order is set "
                        "by priority, not by id."
                    ),
                }
            )
        seen.add(source_id)


def create_fixture_loader(
    registry: Any,
    sources: Sequence[FixtureSource | LayeredSource],
    parsers: dict[str, Parser] | None = None,
    reference_mode: ReferenceMode | None = None,
    json_schema_validator: JsonSchemaValidatorFactory | None = None,
) -> FixtureLoader:
    return FixtureLoader(
        registry,
        sources,
        parsers=parsers,
        reference_mode=reference_mode,
        json_schema_validator=json_schema_validator,
    )


def _walk_refs(
    value: Any,
    field_path: list[PathSegment],
    out: list[ExtractedReference],
    mode: ReferenceMode,
    seen: set[int],
    depth: int,
) -> None:
    if depth > _MAX_REFERENCE_DEPTH or value is None:
        return

    if isinstance(value, str):
        if mode == "explicit-and-bare" and is_canonical_ref(value):
            out.append({"ref": value, "fieldPath": list(field_path)})
        return

    if not isinstance(value, dict | list):
        return
    identity = id(cast(Any, value))
    if identity in seen:
        return
    seen.add(identity)

    if is_explicit_ref(value):
        out.append({"ref": str(cast(dict[str, Any], value)["$ref"]), "fieldPath": list(field_path)})
        return

    if isinstance(value, list):
        for index, item in enumerate(cast(list[Any], value)):
            _walk_refs(item, [*field_path, index], out, mode, seen, depth + 1)
        return

    obj = cast(dict[str, Any], value)
    for key, child in js_entries(obj):
        _walk_refs(child, [*field_path, key], out, mode, seen, depth + 1)


def _dedupe_references(refs: Sequence[ExtractedReference]) -> list[ExtractedReference]:
    seen: set[str] = set()
    out: list[ExtractedReference] = []
    for reference in refs:
        key = f"{reference['ref']}\u0000{_path_string(reference['fieldPath'])}"
        if key in seen:
            continue
        seen.add(key)
        out.append(reference)
    return out


def _path_string(path: Sequence[PathSegment]) -> str:
    return ".".join(str(part) for part in path)


def _type_mismatch(expected: str, actual: str, ref: str) -> FixtureError:
    return FixtureError(
        {
            "severity": "error",
            "code": "type-mismatch",
            "message": f'Expected ref of type "{expected}" but got "{actual}".',
            "fixture": ref,
        }
    )


def _message_of(error: Exception) -> str:
    return str(error)


def _js_string(value: Any) -> str:
    """Render a value the way JavaScript's `String()` would, for the few error
    messages that interpolate authored data."""
    if value is True:
        return "true"
    if value is False:
        return "false"
    if value is None:
        return "null"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, dict | list):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    return str(value)
