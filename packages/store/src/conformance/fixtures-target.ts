// ─── The `fixtures` conformance target ──────────────────────────────────────
// Binds `@mirk/fixtures` over the scenario's backend store, so one corpus
// covers the pure loader pipeline (refs, layering, patches, provenance,
// references, materialization) AND the store-backed source and sink on both
// backends. TOOLING, like ./backends.ts: absent from the tsup build list and
// from package.json exports.
//
// Every scenario's first step is `configure(spec)`. The spec is DATA — a type
// declares its shape with a JSON Schema document and its merge strategy by
// builtin name — which is exactly what makes the same scenario replayable in
// Python. Function hooks (a custom `mergeStrategy`, `validateReferences`,
// `extractReferences`, `materialize`) are code, cannot cross, and are pinned by
// each language's own tests instead.
//
// Results are plain JSON with the TypeScript key spelling. `undefined` fields
// are absent rather than null, because the runner's normalization drops them
// and Python omits the same keys.

import {
  createFixtureLoader,
  createFixtureRegistry,
  type Diagnostic,
  type FixtureLoader,
  type FixturePurpose,
  type FixtureTypeDefinition,
  type JsonSchemaDocument,
  type LayeredSource,
  type ReferenceMode,
} from "@mirk/fixtures";
import { createMemoryFixtureSource } from "@mirk/fixtures/memory";
import {
  createStoreFixtureSource,
  seedStoreFromFixtures,
  type StoredFixtureItem,
} from "@mirk/fixtures/store";

import { compareCodePoints } from "../order.js";
import { ajvValidatorFactory } from "./json-schema.js";

/** A fixture type, entirely as data. `jsonSchema` defaults to `true` — the
 *  JSON Schema that accepts every value — so a scenario about layering does not
 *  have to restate a shape it is not testing. */
export interface FixturesTypeSpec {
  type: string;
  directory: string;
  extensions?: string[];
  document?: { kind: "map"; idField?: string };
  purpose?: FixturePurpose;
  referenceMode?: ReferenceMode;
  mergeStrategy?: "replace" | "deep" | "array-replace";
  /** Omit for the default `true` (accepts every value). `null` declares NO
   *  shape contract at all, which the registry rejects — the only way for a
   *  data-only spec to reach that rule. */
  jsonSchema?: JsonSchemaDocument | null;
}

export interface MemorySourceSpec {
  kind: "memory";
  name: string;
  priority: number;
  files: Record<string, string>;
}

/** One row as it will be written to the backend store. `extension` falls back
 *  to the source's, then to `.json`. */
export interface StoreItemSpec {
  id: string;
  content: string;
  extension?: string;
  relativePath?: string;
}

export interface StoreSourceSpec {
  kind: "store";
  name: string;
  priority: number;
  collection: string;
  pathPrefix?: string;
  extension?: string;
  items: StoreItemSpec[];
}

export type FixturesSourceSpec = MemorySourceSpec | StoreSourceSpec;

export interface FixturesSpec {
  types: FixturesTypeSpec[];
  sources: FixturesSourceSpec[];
  /** Loader-level reference mode. A type's own `referenceMode` overrides it. */
  referenceMode?: ReferenceMode;
}

/** The two store methods the store source needs, plus the write side the sink
 *  and `readSeeded` need. Both backends satisfy it synchronously. */
export interface FixturesBackendStore {
  list<T = unknown>(collection: string): readonly T[];
  getById<T = unknown>(collection: string, id: string): T | null | undefined;
  put<T extends { id: string }>(collection: string, item: T): T;
}

interface SeedOptions {
  targets: Record<string, string>;
  mode?: "upsert" | "insert-only";
  includeProvenance?: boolean;
  validateBeforeWrite?: boolean;
}

function typeDefinition(spec: FixturesTypeSpec): FixtureTypeDefinition {
  const def: FixtureTypeDefinition = { type: spec.type, directory: spec.directory };
  if (spec.jsonSchema !== null) def.jsonSchema = spec.jsonSchema ?? true;
  if (spec.extensions) def.extensions = [...spec.extensions];
  if (spec.document) def.document = { ...spec.document };
  if (spec.purpose) def.purpose = spec.purpose;
  if (spec.referenceMode) def.referenceMode = spec.referenceMode;
  if (spec.mergeStrategy) def.mergeStrategy = spec.mergeStrategy;
  return def;
}

function storeRow(source: StoreSourceSpec, item: StoreItemSpec): StoredFixtureItem {
  const row: StoredFixtureItem = {
    id: item.id,
    content: item.content,
    extension: item.extension ?? source.extension ?? ".json",
  };
  if (item.relativePath !== undefined) row.relativePath = item.relativePath;
  return row;
}

interface SerializedGraph {
  nodes: Array<{ ref: string; type: string; id: string; resolved: boolean }>;
  edges: Array<{ from: string; to: string; fieldPath: string[] }>;
  diagnostics: Diagnostic[];
}

/** Build the `fixtures` target over one backend store. State lives in the
 *  closure, so a scenario's steps share one loader and one registry. */
export function fixturesApi(store: FixturesBackendStore): Record<string, unknown> {
  let loader: FixtureLoader | undefined;
  let types: string[] = [];

  function ready(): FixtureLoader {
    if (!loader) throw new Error("fixtures target: call configure(spec) first.");
    return loader;
  }

  return {
    configure(spec: FixturesSpec): null {
      if (loader) throw new Error("fixtures target: configure(spec) was already called.");
      const registry = createFixtureRegistry();
      for (const typeSpec of spec.types) registry.register(typeDefinition(typeSpec));
      types = registry.types();

      const sources: LayeredSource[] = spec.sources.map((source) => {
        if (source.kind === "memory") {
          return {
            source: createMemoryFixtureSource({ id: source.name, files: source.files }),
            layer: source.name,
            priority: source.priority,
          };
        }
        // Store items are written THROUGH the backend store before the source
        // is built, so a store-source scenario exercises the real backend on
        // both memory and SQLite rather than a stand-in.
        for (const item of source.items) store.put(source.collection, storeRow(source, item));
        const options = {
          id: source.name,
          store: {
            list: <T,>(collection: string) => store.list<T>(collection),
            getById: <T,>(collection: string, id: string) => store.getById<T>(collection, id),
          },
          collection: source.collection,
          ...(source.pathPrefix === undefined ? {} : { pathPrefix: source.pathPrefix }),
        };
        return {
          source: createStoreFixtureSource<StoredFixtureItem>(options),
          layer: source.name,
          priority: source.priority,
        };
      });

      loader = createFixtureLoader({
        registry,
        sources,
        jsonSchemaValidator: ajvValidatorFactory,
        ...(spec.referenceMode ? { referenceMode: spec.referenceMode } : {}),
      });
      return null;
    },

    load: (ref: string) => ready().load(ref),
    list: (type?: string) => ready().list(type),
    types: () => types,
    validate: (ref?: string) => ready().validate(ref),
    // The diagnostics array on its own, so a scenario can compare it with the
    // `values` form's `ignoreFields`. That is the only way to pin a diagnostic
    // whose message belongs to the HOST rather than to Mirk: `parse-failed`
    // wraps whatever the language's JSON parser said, and V8 and CPython word
    // it differently for the same broken document.
    validateDiagnostics: async (ref?: string) => (await ready().validate(ref)).diagnostics,
    explain: async (ref: string) => (await ready().loadRaw(ref)).provenance,
    resolveRef: (value: unknown, expectedType?: string) =>
      ready().resolveRef(value as never, expectedType),

    async referenceGraph(): Promise<SerializedGraph> {
      const graph = await ready().referenceGraph();
      const nodes = [...graph.nodes.values()]
        .map((node) => ({ ref: node.ref, type: node.type, id: node.id, resolved: node.resolved }))
        .sort((a, b) => compareCodePoints(a.ref, b.ref));
      const edges = graph.edges
        .map((edge) => ({
          from: edge.from,
          to: edge.to,
          fieldPath: edge.fieldPath.map(String),
        }))
        .sort((a, b) => compareCodePoints(edgeKey(a), edgeKey(b)));
      return { nodes, edges, diagnostics: [...graph.diagnostics] };
    },

    invalidate(ref?: string): null {
      ready().invalidate(ref);
      return null;
    },

    seedStore: (options: SeedOptions) =>
      seedStoreFromFixtures({
        loader: ready(),
        store: {
          list: <T,>(collection: string) => store.list<T>(collection),
          getById: <T,>(collection: string, id: string) => store.getById<T>(collection, id),
          put: <T extends { id: string }>(collection: string, item: T) => store.put(collection, item),
        },
        targets: options.targets,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.includeProvenance === undefined
          ? {}
          : { includeProvenance: options.includeProvenance }),
        ...(options.validateBeforeWrite === undefined
          ? {}
          : { validateBeforeWrite: options.validateBeforeWrite }),
      }),

    readSeeded: (collection: string, id: string) => store.getById(collection, id) ?? null,
  };
}

function edgeKey(edge: { from: string; to: string; fieldPath: string[] }): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.fieldPath.join(".")}`;
}
