// ─── @mirk/fixtures — public types ───────────────────────────────────────

import type { StandardSchemaV1 as StandardSchema } from "@standard-schema/spec";

export type FixtureRef = string;

export interface ExplicitRef {
  $ref: string;
}

export type RefOrInline<T> = FixtureRef | ExplicitRef | T;

export type MaybePromise<T> = T | Promise<T>;

export type StandardSchemaV1<Input = unknown, Output = Input> =
  StandardSchema<Input, Output>;
export type StandardSchemaV1Result<Output> = StandardSchema.Result<Output>;
export type StandardSchemaV1Issue = StandardSchema.Issue;

/**
 * A JSON Schema (draft 2020-12) document. `true` accepts every value and
 * `false` rejects every value, exactly as the specification says.
 *
 * This is the authored-shape contract that crosses languages: it is DATA, so
 * the TypeScript loader and the Python loader can validate the same fixtures
 * against the same declaration. The engine that reads it is injected — this
 * package never depends on one.
 */
export type JsonSchemaDocument = Record<string, unknown> | boolean;

/** Validate one value, returning an issue per failure and an empty list on
 *  success. Issue `path`s are LEAF instance paths, as `formatIssuePath`
 *  renders them. */
export type JsonSchemaValidator = (value: unknown) => readonly StandardSchemaV1Issue[];

/** Compiles a JSON Schema document into a validator. Supplied by the caller
 *  (Ajv 2020 in this repo's tests), so neither the browser entry nor the
 *  published dependency list gains a schema engine. */
export type JsonSchemaValidatorFactory = (document: JsonSchemaDocument) => JsonSchemaValidator;

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end?: SourcePosition;
}

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  fixture?: string;
  source?: string;
  path?: string;
  fieldPath?: string;
  range?: SourceRange;
  hint?: string;
}

export interface FixtureSourceEntry {
  relativePath: string;
  locator: string;
}

export interface FixtureSource {
  readonly id: string;
  list(): MaybePromise<readonly FixtureSourceEntry[]>;
  read(entry: FixtureSourceEntry): MaybePromise<string>;
}

export interface LayeredSource {
  source: FixtureSource;
  layer: string;
  priority: number;
}

export type FixturePurpose = "archetype" | "component" | "lookup" | "factory" | "raw";

export type BuiltinMergeStrategy = "replace" | "deep" | "array-replace";

export type CustomMerge = (existing: unknown, incoming: unknown, ctx: MergeContext) => unknown;

export type MergeStrategy = BuiltinMergeStrategy | CustomMerge;

export interface MergeContext {
  fixture: string;
  layers: ReadonlyArray<{
    sourceId: string;
    layer: string;
    priority: number;
    kind: FixtureProvenanceLayerKind;
  }>;
}

export interface ExtractedReference {
  ref: string;
  fieldPath: ReadonlyArray<PropertyKey>;
}

export interface MaterializationContext {
  ref: string;
  loadRaw: <U = unknown>(ref: string) => Promise<U>;
  materialize: <U = unknown>(ref: string) => Promise<U>;
}

export interface ValidationContext {
  ref: string;
  has: (ref: string) => Promise<boolean>;
  loadRaw: <U = unknown>(ref: string) => Promise<U>;
}

export type ReferenceMode = "explicit-only" | "explicit-and-bare";

export interface FixtureMapDocument {
  kind: "map";
  /**
   * Inject the map key into this field when a base fixture omits it.
   * An explicitly different value is rejected.
   */
  idField?: string;
}

export interface FixtureTypeDefinition {
  type: string;
  directory: string;
  extensions?: string[];
  /** Authored-shape contract, validated in every language. */
  jsonSchema?: JsonSchemaDocument;
  /** Optional typed output. When both are present, `jsonSchema` runs first and
   *  this schema's output becomes the fixture value. */
  schema?: StandardSchemaV1<unknown, unknown>;
  document?: FixtureMapDocument;
  purpose?: FixturePurpose;
  mergeStrategy?: MergeStrategy;
  referenceMode?: ReferenceMode;
  validateReferences?: (value: unknown, ctx: ValidationContext) => MaybePromise<readonly Diagnostic[]>;
  extractReferences?: (value: unknown) => ReadonlyArray<ExtractedReference>;
  materialize?: (value: unknown, ctx: MaterializationContext) => MaybePromise<unknown>;
}

export interface TypedFixtureTypeDefinition<T, M = T> {
  type: string;
  directory: string;
  extensions?: string[];
  /** Authored-shape contract, validated in every language. */
  jsonSchema?: JsonSchemaDocument;
  /** Optional typed output. When both are present, `jsonSchema` runs first and
   *  this schema's output becomes the fixture value. */
  schema?: StandardSchemaV1<unknown, T>;
  document?: FixtureMapDocument;
  purpose?: FixturePurpose;
  mergeStrategy?: MergeStrategy;
  referenceMode?: ReferenceMode;
  validateReferences?: (value: T, ctx: ValidationContext) => MaybePromise<readonly Diagnostic[]>;
  extractReferences?: (value: T) => ReadonlyArray<ExtractedReference>;
  materialize?: (value: T, ctx: MaterializationContext) => MaybePromise<M>;
}

export function defineFixtureType<T, M = T>(def: TypedFixtureTypeDefinition<T, M>): FixtureTypeDefinition {
  return def as unknown as FixtureTypeDefinition;
}

export interface PatchDocument {
  $patch: string;
  [key: string]: unknown;
}

export type FixtureProvenanceLayerKind = "base" | "replace" | "patch" | "shadowed";

export interface FixtureProvenanceLayer {
  sourceId: string;
  layer: string;
  priority: number;
  path: string;
  kind: FixtureProvenanceLayerKind;
}

export interface FixtureProvenance {
  finalRef: string;
  layers: FixtureProvenanceLayer[];
}

export interface LoadedFixture<T = unknown> {
  ref: string;
  type: string;
  id: string;
  value: T;
  provenance: FixtureProvenance;
}

export interface ReferenceGraphNode {
  ref: string;
  type: string;
  id: string;
  resolved: boolean;
}

export interface ReferenceGraphEdge {
  from: string;
  to: string;
  fieldPath: ReadonlyArray<PropertyKey>;
}

export interface ReferenceGraph {
  nodes: Map<string, ReferenceGraphNode>;
  edges: ReferenceGraphEdge[];
  diagnostics: Diagnostic[];
}

export interface ValidationReport {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export type Parser = (content: string) => unknown;
export type AsyncParser = (content: string) => Promise<unknown>;

export interface PositionedParseResult {
  value: unknown;
  positionFor(path: ReadonlyArray<PropertyKey>): SourceRange | undefined;
}

export type PositionedParser = (content: string) => PositionedParseResult;
export type AsyncPositionedParser = (content: string) => Promise<PositionedParseResult>;

export type ParserEntry =
  | { kind: "plain"; parse: Parser }
  | { kind: "async"; parse: AsyncParser }
  | { kind: "positioned"; parse: PositionedParser }
  | { kind: "async-positioned"; parse: AsyncPositionedParser };

export interface FixtureLoaderOptions {
  registry: FixtureRegistryLike;
  sources: ReadonlyArray<FixtureSource | LayeredSource>;
  parsers?: Record<string, Parser | AsyncParser | PositionedParser | AsyncPositionedParser | ParserEntry>;
  referenceMode?: ReferenceMode;
  /** Compiles a type's `jsonSchema` into a validator. A type declaring
   *  `jsonSchema` without this option is a loud failure, never a silent skip. */
  jsonSchemaValidator?: JsonSchemaValidatorFactory;
}

export interface FixtureRegistryLike {
  get(type: string): FixtureTypeDefinition | undefined;
  has(type: string): boolean;
  types(): string[];
}

export interface FixtureLoader {
  load<T = unknown>(ref: string): Promise<T>;
  loadRaw<T = unknown>(ref: string): Promise<LoadedFixture<T>>;
  materialize<M = unknown>(ref: string): Promise<M>;
  list(type?: string): Promise<string[]>;
  resolveRef<T>(value: RefOrInline<T>, expectedType?: string): Promise<T>;
  validate(ref?: string): Promise<ValidationReport>;
  referenceGraph(): Promise<ReferenceGraph>;
  invalidate(ref?: string): void;
}
