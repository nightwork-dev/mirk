// ─── @mirk/fixtures ───────────────────────────────────────────────────────
// Core authored-data loader. Source helpers live in explicit subpaths so the
// root import stays free of Node-only modules and backend-specific code.

export type {
  AsyncParser,
  AsyncPositionedParser,
  BuiltinMergeStrategy,
  CustomMerge,
  Diagnostic,
  DiagnosticSeverity,
  ExplicitRef,
  ExtractedReference,
  FixtureLoader,
  FixtureLoaderOptions,
  FixtureProvenance,
  FixtureProvenanceLayer,
  FixtureProvenanceLayerKind,
  FixturePurpose,
  FixtureRef,
  FixtureRegistryLike,
  FixtureSource,
  FixtureSourceEntry,
  FixtureTypeDefinition,
  LayeredSource,
  LoadedFixture,
  MaterializationContext,
  MaybePromise,
  MergeContext,
  MergeStrategy,
  Parser,
  ParserEntry,
  PatchDocument,
  PositionedParseResult,
  PositionedParser,
  RefOrInline,
  ReferenceGraph,
  ReferenceGraphEdge,
  ReferenceGraphNode,
  ReferenceMode,
  SourcePosition,
  SourceRange,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
  TypedFixtureTypeDefinition,
  ValidationContext,
  ValidationReport,
} from "./types.js";
export { defineFixtureType } from "./types.js";
export { FixtureError, FixtureValidationError } from "./errors.js";
export { createFixtureRegistry, FixtureRegistry } from "./registry.js";
export { createFixtureLoader } from "./loader.js";
export { formatRef, isCanonicalRef, isExplicitRef, parseRef, refString } from "./refs.js";
