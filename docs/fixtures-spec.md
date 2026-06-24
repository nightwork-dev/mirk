# `@mirk/fixtures` public package specification

**Status:** draft spec  
**Package:** `@mirk/fixtures`  
**Horizon:** near  
**Related primitive:** `@mirk/store/kv`

## Summary

`@mirk/fixtures` is a substrate-level loader for authored, typed data: content packs, prompt packs,
configuration fragments, test fixtures, templates, lookup tables, and other records that need to be
validated, layered, patched, reference-checked, and explained before an application consumes them.

The package should sit **on top of** `@mirk/store` without being embedded inside it:

- `@mirk/store/kv` remains the durable key-value / collection port.
- `@mirk/fixtures` defines fixture types, parsers, sources, layering, merge semantics, diagnostics,
  reference validation, and materialization.
- `@mirk/fixtures/store` provides store integration over the `@mirk/store/kv` collection shape, so
  persisted fixture packs can be loaded from a store and validated packs can seed store collections.

This keeps storage and authored-data semantics separate while making the store-backed path a
first-class use case.

## Goals

1. **Typed authored data.** Consumers register fixture types with a schema, directory, accepted file
   extensions, optional merge policy, reference validation, and optional materialization step.
2. **Store-integrated by design, source-agnostic in core.** The core loader accepts any fixture
   source. Store-backed sources and store seeding helpers are adapters over the `@mirk/store/kv`
   collection shape rather than hard dependencies on a specific backend.
3. **Standard Schema first.** Validators use the Standard Schema v1 contract so consumers can choose
   Zod, Valibot, ArkType, or a custom validator.
4. **Parser injection.** JSON is safe as a built-in parser; YAML, JSON5, TOML, or custom formats are
   supplied by the consumer or by optional subpaths later.
5. **Deterministic layering.** Multiple sources can contribute data with explicit layer names and
   priorities. The same inputs always produce the same resolved fixture and provenance.
6. **Patch documents.** Higher-priority documents can partially override a base fixture with a
   declared `$patch` target instead of replacing the whole fixture.
7. **Reference-aware loading.** Explicit `{ $ref }` references and opt-in bare `type:id` strings can
   be resolved, validated, materialized, and surfaced as a reference graph.
8. **Explainability.** Validation failures, parse failures, missing references, shadowed layers, and
   patches should produce structured diagnostics and provenance suitable for CLIs and UIs.
9. **Code-split imports.** Root imports stay native-free and domain-free. Filesystem, store, package,
   memory, and CLI helpers live behind explicit subpaths.
10. **Public, domain-neutral design.** No application-specific concepts, private paths, or internal
    project names belong in package names, examples, diagnostics, tests, or docs.

## Non-goals

- A database or new storage port. Fixture persistence and fixture-seeded collections ride
  `@mirk/store/kv` when persistence is needed.
- A schema library wrapper. The package consumes Standard Schema; it does not bless one validator.
- A parser bundle. Avoid pulling YAML / JSON5 / TOML into the root package unless a separate subpath
  or optional dependency proves necessary.
- A domain framework. Configuration packs, templates, lookup tables, UI themes, content packs, and
  test fixtures should all fit without the core package naming any of them as special.
- A live hot-reload service. Cache invalidation hooks can exist, but file watching and authoring
  servers belong above this primitive.
- A migration engine. The loader validates and resolves current authored data; versioned migrations
  are a separate concern.

## Public package boundary

The public package, examples, diagnostics, test fixtures, CLI output, and generated provenance must
be domain-neutral. They must not contain private project names, local filesystem paths, internal
milestone identifiers, or application-specific content models.

Public package metadata should use the package and CLI names directly:

```json
{
  "name": "@mirk/fixtures",
  "bin": {
    "mirk-fixtures": "./dist/bin.js"
  }
}
```

Public subpaths are normative; internal source filenames are not:

| Import | Contents | Native deps |
| --- | --- | --- |
| `@mirk/fixtures` | core types, registry, async loader, refs, diagnostics | none |
| `@mirk/fixtures/memory` | in-memory fixture source | none |
| `@mirk/fixtures/store` | store-backed fixture source and store seeding helpers over the `@mirk/store/kv` collection port | none beyond `@mirk/store` types |
| `@mirk/fixtures/filesystem` | Node filesystem source | Node built-ins only |
| `@mirk/fixtures/package` | package/resource source helper | none or Node built-ins only, depending on implementation |
| `@mirk/fixtures/cli` | CLI entry helpers | only optional parser deps if they are explicitly added later |

The root entry must not re-export filesystem, package-resolution, or CLI helpers if doing so would
force bundlers to include Node-only modules in browser/edge builds.

## Core concepts

### Fixture reference

A fixture reference is a stable string of the form:

```txt
<type>:<id>
```

Examples:

```txt
theme:dark
prompt:code-review
template:welcome
```

Rules:

- `type` must be registered before loading.
- `id` is source-relative and stable; it should not depend on the absolute path of a source.
- Explicit references use `{ $ref: "type:id" }` and are the default portable representation.
- Bare string refs are optional convenience behavior. When enabled, a bare string is recognized only
  if the entire string matches the canonical ref grammar; substrings inside prose are never refs.
- Type-level custom reference extraction must be available for consumers that need stricter behavior.

### Fixture type definition

A registered fixture type defines how documents map to refs and how they are validated:

```ts
const promptType = defineFixtureType({
  type: "prompt",
  directory: "prompts",
  extensions: [".json", ".yaml"],
  purpose: "raw",
  schema: PromptSchema,
  mergeStrategy: "deep",
  validateReferences(value, ctx) {
    return [];
  },
  materialize(value, ctx) {
    return compilePrompt(value);
  },
});
```

Required fields:

- `type`: canonical namespace used in refs.
- `directory`: source-relative directory for documents of this type.
- `schema`: Standard Schema v1 validator.

Optional fields:

- `extensions`: accepted extensions; defaults to extensions with registered parsers.
- `purpose`: tooling hint (`archetype`, `component`, `lookup`, `factory`, `raw`).
- `mergeStrategy`: built-in or custom merge function.
- `validateReferences`: cross-document validation after schema validation.
- `extractReferences`: custom reference extractor for reference graphs and validation:
  `(value) => ReadonlyArray<{ ref: string; fieldPath: readonly PropertyKey[] }>`.
- `referenceMode`: optional policy for built-in extraction, defaulting to explicit `$ref` objects.
- `materialize`: conversion from validated raw data to runtime representation.

### Registry

The registry is a small typed map of fixture type definitions:

```ts
const registry = createFixtureRegistry();
registry.register(promptType);
registry.register(themeType);
```

Requirements:

- Duplicate `type` registration is an error.
- `register(def)` mutates the registry and returns `void`; a chainable builder can be added later if
  it proves useful.
- `types()` returns type names in deterministic lexicographic order.
- Registration should preserve TypeScript inference at the call site but store erased definitions
  internally so heterogeneous types can coexist.

## Source model

### Entries

A fixture source lists entries and reads raw content:

```ts
type MaybePromise<T> = T | Promise<T>;

interface FixtureSourceEntry {
  relativePath: string;
  locator: string;
}

interface FixtureSource {
  readonly id: string;
  list(): MaybePromise<readonly FixtureSourceEntry[]>;
  read(entry: FixtureSourceEntry): MaybePromise<string>;
}
```

`relativePath` participates in type/directory/extension matching and human-facing provenance.
`locator` is the source-owned read token. Implementations must treat `locator` as opaque and must
not derive read identity from `relativePath`.

### Layered sources

```ts
interface LayeredSource<S> {
  source: S;
  layer: string;
  priority: number;
}
```

Conventions:

- Higher priority wins when two non-patch documents define the same ref.
- Patches apply only above the selected base fixture. Patches at or below the selected base priority
  are not applied; they may appear in provenance as shadowed patch layers.
- Equal priorities are allowed only if declaration order is used as a deterministic tie-breaker;
  provenance order reflects the deterministic application order.
- Plain sources may be accepted as shorthand for `{ source, layer: source.id, priority:
  declarationIndex }` if the implementation supports mixed source arrays.
- Built-in layer names may be documented (`base`, `app`, `scenario`, `user`) but must remain
  conventions, not special cases.

### Built-in source helpers

#### Memory source

For tests and small embedded packs:

```ts
createMemoryFixtureSource({
  id: "test",
  files: {
    "prompts/review.json": JSON.stringify({ template: "Review {code}" }),
  },
});
```

#### Filesystem source

For Node apps and CLIs:

```ts
createFilesystemFixtureSource({ id: "files", root: "./fixtures" });
```

Requirements:

- Root paths are resolved once at source creation.
- The source resolves and `realpath`s the root before walking.
- During walk, each discovered file is resolved before it is accepted.
- Files whose real path is outside the root real path are rejected.
- Listed paths are relative to root and normalized with `/` separators.
- Source-relative paths reject absolute paths, `..` segments, empty segments, and backslashes.
- `read(entry)` validates that the entry belongs to the source before reading.
- File order is deterministic.
- Filesystem locators may be absolute internally, but diagnostics, provenance, and CLI output expose
  only source id plus normalized relative path unless an explicit debug option is enabled.

#### Store source

A store can be a fixture **source**: durable authored documents live in `@mirk/store/kv`
collections and the fixture loader reads, validates, layers, and materializes them.

For durable packs over `@mirk/store/kv` collections:

```ts
createStoreFixtureSource({
  id: "db",
  store: adapter.kv,
  collection: "fixtures",
});
```

Store adapter contract:

```ts
interface StoreFixtureSourceOptions<TItem = StoredFixtureItem> {
  id: string;
  store: KvLike<TItem>;
  collection: string;
  pathPrefix?: string;
  mapItem?: (item: TItem) => StoredFixtureItem;
}

interface KvLike<TItem> {
  list(collection: string): MaybePromise<readonly TItem[]>;
  getById(collection: string, id: string): MaybePromise<TItem | null | undefined>;
}

interface StoredFixtureItem {
  id: string;
  content: string;
  extension: string;
  relativePath?: string;
  updatedAt?: string;
  meta?: Record<string, unknown>;
}
```

Requirements:

- Depend only on the structural key-value collection subset: list items in a collection and fetch an
  item by id.
- Use `relativePath` when present; otherwise synthesize `<id><extension>` with an optional
  `pathPrefix`.
- Store-source `locator` is the backing item id unless the source owns a richer opaque locator.
- `relativePath` is for fixture matching and public provenance only. A store source must never
  derive the store key from `relativePath` during `read()`.
- Preserve source-level cache invalidation hooks so long-running processes can refresh after writes.
- Do not require a specific backend. SQLite, libSQL, memory, or future remote stores all work through
  the same port.

#### Store sink / seeding helper

A store can also be a fixture **sink**: fixture packs are loaded from memory, filesystem, package, or
another store source, validated, optionally materialized, and then written into `@mirk/store/kv`
collections.

This keeps the dependency direction clean:

- `@mirk/store` does not know about fixtures.
- `@mirk/fixtures` can read from store-backed fixture packs.
- `@mirk/fixtures` can seed ordinary store collections from validated fixture packs.

Proposed helper shape:

```ts
await seedStoreFromFixtures({
  loader,
  store: adapter.kv,
  targets: {
    "theme": "themes",
    "template": "templates"
  },
  mode: "upsert"
});
```

Requirements:

- Seeding writes validated fixture values, not unvalidated parser output.
- Target mapping is explicit: fixture type names map to store collection names.
- Modes are explicit: `insert-only`, `upsert`, and `replace-collection` are candidates; v1 may ship
  only `upsert`.
- Each written store item has a stable `id` equal to the fixture id unless the caller supplies a
  mapping function.
- Provenance can be written into item metadata when the caller opts in.
- Failed validation aborts the seed operation before any writes unless the caller explicitly opts
  into best-effort behavior.
- Store seeding helpers live in `@mirk/fixtures/store`; `@mirk/store` never depends on fixtures.

#### Package/resource source

For packages that ship fixture packs as files or generated manifests:

```ts
createPackageFixtureSource({
  id: "defaults",
  rootUrl: new URL("./fixtures/", import.meta.url),
});
```

The exact implementation can be Node-first in v1, but the spec should leave room for bundled
manifests in browser/edge environments.

## Parser model

```ts
type Parser = (content: string) => unknown;
type AsyncParser = (content: string) => Promise<unknown>;

interface PositionedParseResult {
  value: unknown;
  positionFor(path: readonly PropertyKey[]): SourceRange | undefined;
}

type ParserEntry =
  | { kind: "plain"; parse: Parser }
  | { kind: "async"; parse: AsyncParser }
  | { kind: "positioned"; parse: (content: string) => PositionedParseResult }
  | { kind: "async-positioned"; parse: (content: string) => Promise<PositionedParseResult> };
```

Requirements:

- `.json` parser is built in.
- Unknown extension is a structured `no-parser` diagnostic.
- Parse failures include source id, relative path, extension, and parser message.
- Optional position mapping should enrich diagnostics but never be required for correctness.

## Loader pipeline

For `loadRaw("type:id")`:

1. Parse the ref and find the registered fixture type.
2. List all sources and match entries under the type directory with an accepted extension.
3. V1 matches only files directly under the type directory. Nested paths are ignored unless a later
   version explicitly enables nested ids.
4. Read and parse matching candidates.
5. Classify each parsed document as either a base document or a patch document.
6. Select the highest-priority base document. If none exists, raise `patch-without-base`.
7. Validate the base document against the type schema.
8. Apply higher-priority patches in priority order.
9. Validate after every merge so invalid intermediate states are caught at the patch that caused
   them.
10. Record provenance for shadowed bases, shadowed patches, selected base, and applied patches.
11. Cache the loaded raw fixture by ref.

A patch document has this shape:

```ts
{
  "$patch": "type:id",
  "field": "new value"
}
```

The declared `$patch` target must exactly match the ref being loaded. Mismatches are errors.

## Provenance

Provenance is public, deterministic, and privacy-safe:

```ts
interface FixtureProvenanceLayer {
  sourceId: string;
  layer: string;
  priority: number;
  path: string;
  kind: "base" | "replace" | "patch" | "shadowed";
}
```

Requirements:

- `path` is a normalized source-relative path, not an absolute path.
- `sourceId`, `layer`, `priority`, `path`, and `kind` are safe for CLI and UI display.
- Provenance must not include database connection details, local package roots, backend-specific
  identifiers, or absolute filesystem paths unless debug output is explicitly requested.

## Merge semantics

Built-in strategies:

| Strategy | Behavior |
| --- | --- |
| `replace` | Incoming value replaces the existing value. |
| `deep` | Plain objects merge recursively; arrays and scalars replace. |
| `array-replace` | Plain objects merge shallowly; array fields replace; non-object incoming values replace. |

Custom strategy:

```ts
type MergeStrategy = BuiltinMergeStrategy | ((existing, incoming, ctx) => unknown);
```

Requirements:

- Merge functions must be pure: no mutation of inputs.
- Merge context includes target ref and contributing layers.
- Schema validation runs after merge.
- Built-in deep merge must handle only plain objects; Dates, Maps, Sets, class instances, functions,
  and typed arrays are treated as replacement values.

## Reference resolution and validation

### Resolution

```ts
loader.resolveRef(value, expectedType?)
```

- If `value` is a ref, load the referenced fixture.
- If `expectedType` is supplied, reject refs of the wrong type.
- If `value` is inline and `expectedType` is supplied, validate it against the expected type schema.
- If `value` is inline and no expected type is supplied, return it unchanged.

### Validation report

```ts
const report = loader.validate();
```

Validation should:

- Load every listed fixture.
- Run schema validation.
- Run type-specific `validateReferences` hooks.
- Build diagnostics instead of failing at the first error.
- Include missing references, type mismatches, parser failures, schema issues, and patch errors.

### Reference graph

```ts
const graph = loader.referenceGraph();
```

Graph nodes:

```ts
interface ReferenceGraphNode {
  ref: string;
  type: string;
  id: string;
  resolved: boolean;
}
```

Graph edges:

```ts
interface ReferenceGraphEdge {
  from: string;
  to: string;
  fieldPath: readonly PropertyKey[];
}
```

Extraction rules:

- Built-in extraction always recognizes explicit `{ $ref: "type:id" }` references.
- Bare string refs are recognized only when the loader or fixture type opts into them, and only when
  the entire string matches the canonical ref grammar.
- Type definitions may provide `extractReferences` to override or augment built-in extraction and
  avoid false positives in text-heavy records.
- Malformed refs surface diagnostics without crashing graph construction.
- The graph includes unresolved target nodes with `resolved: false` so dangling references are visible.

## Materialization

Raw fixture data is the validated document shape. Materialized data is the runtime representation:

```ts
const raw = await loader.load("prompt:review");
const compiled = await loader.materialize("prompt:review");
```

Requirements:

- Materialization is optional per type.
- Raw and materialized caches are separate.
- Materializers receive a context with `loadRaw` and `materialize` so they can compose other fixtures.
- A loader tracks the active materialization stack per call. Re-entering a ref already on the stack
  raises `materialization-cycle` with the cycle path when available.
- Invalidating a raw fixture must also invalidate its materialized value and any dependents when the
  dependency graph is known. V1 may invalidate all materialized values for simplicity.

## Async loader surface

V1 exposes an async loader surface:

```ts
const loader = createFixtureLoader({ registry, sources, parsers });
const value = await loader.load("theme:dark");
```

Sources, parsers, Standard Schema validators, reference validators, and materializers may complete
synchronously or asynchronously; the loader normalizes them to promises. This keeps one public API
stable across memory, filesystem, package, store, and future remote-backed sources while still
allowing store-backed sources to use the sync-first `@mirk/store/kv` port underneath.

A separate `@mirk/fixtures/sync` subpath may be added later if a no-Promise embedded use case
justifies the maintenance and test burden. If added, it must have parity tests against the async
loader for shared behavior.

## Diagnostics

Diagnostics are structured records, not strings:

```ts
interface Diagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  fixture?: string;
  source?: string;
  path?: string;
  fieldPath?: string;
  range?: SourceRange;
  hint?: string;
}
```

Initial diagnostic codes:

- `invalid-ref`
- `unknown-type`
- `not-found`
- `no-parser`
- `parse-failed`
- `schema-invalid`
- `patch-without-base`
- `patch-ref-mismatch`
- `merge-failed`
- `missing-reference`
- `type-mismatch`
- `materialization-cycle`
- `duplicate-relative-path`
- `unsafe-relative-path`
- `seed-validation-failed`
- `source-read-failed`
- `source-list-failed`

Requirements:

- Throwing APIs throw typed errors carrying a diagnostic.
- Report APIs return diagnostics and continue where possible.
- Diagnostics must not include absolute local paths by default. A debug mode may include full paths,
  but public CLI output should prefer source id + relative path.

## CLI

A small CLI is useful because fixture failures are usually authoring failures, not programmer-only
failures.

Commands:

```bash
mirk-fixtures validate <root>
mirk-fixtures list <root> [--type prompt]
mirk-fixtures show <root> <type:id> [--raw | --materialized]
mirk-fixtures graph <root> [--format json|dot]
mirk-fixtures explain <root> <type:id>
```

CLI scope rules:

- The CLI can live in `@mirk/fixtures/cli` and an executable bin.
- YAML / JSON5 parser support should be explicit. Either ship no extra parser by default and accept
  a config file, or add parser deps only if the package owner accepts that root install cost.
- CLI output must be deterministic and avoid absolute paths unless a verbose/debug flag is passed.

## Testing strategy

Minimum tests before implementation is called done:

1. Registry duplicate-type rejection.
2. `types()` returns deterministic lexicographic order.
3. JSON parser built-in; unknown parser diagnostic.
4. Memory source load/list.
5. Filesystem source path normalization and deterministic order.
6. Filesystem source rejects symlink/path traversal outside root.
7. Store source over `InMemoryKv`.
8. Store source over `SqliteAdapter.kv` if the optional peer is available in dev.
9. Store source reads by opaque locator, not by parsing `relativePath`.
10. Store item ids containing dots, slashes, or extension-like suffixes work.
11. Custom `relativePath` still reads the correct store item.
12. Store seeding writes only validated fixture values.
13. Store seeding aborts before writes when validation fails, unless best-effort behavior is explicit.
14. Store seeding writes stable item ids and optional provenance metadata.
15. Duplicate synthesized relative paths produce deterministic diagnostics.
16. Base fixture loading with schema validation.
17. Highest-priority base wins; lower bases appear in provenance.
18. Equal layer-priority tie-breaking is deterministic and reflected in provenance order.
19. `$patch` above the selected base applies.
20. `$patch` at or below the selected base is shadowed or ignored as specified.
21. Patch-only fixture raises `patch-without-base`.
22. Patch target mismatch is rejected.
23. Patch body removes `$patch` before merging.
24. Validation runs after each patch and attributes schema errors to the patch source/path.
25. Built-in merge strategies are pure and deterministic.
26. Custom merge receives merge context.
27. `resolveRef` handles explicit ref, opt-in bare string ref, inline value, and type mismatch.
28. Bare string reference extraction can be disabled and avoids prose substring false positives.
29. Explicit `$ref` extraction always works.
30. Custom `extractReferences` works.
31. `validate()` aggregates diagnostics across multiple invalid fixtures.
32. Parser failure does not abort validation of other fixtures.
33. Source list/read failures produce structured diagnostics.
34. `referenceGraph()` includes dangling refs as unresolved nodes.
35. Malformed refs appear as diagnostics without crashing graph construction.
36. Materializer passthrough works when no materializer is declared.
37. Materialization caches and invalidates separately from raw load.
38. Materialization cycle detection returns a structured diagnostic.
39. Public diagnostics avoid absolute local paths.
40. CLI output is deterministic and path-safe.
41. Package metadata contains no private registry, local path, or internal package scope.
42. Package export smoke tests prove root import does not load Node-only modules.

## Initial implementation slices

### Slice 1 — core + memory source

- Package scaffold with tsup, explicit exports, README.
- Registry, refs, diagnostics, parser normalization.
- Async loader over memory source, accepting sync or async parser/source/schema results.
- JSON parser.
- `replace` and `deep` merge.
- Basic `$patch` support.
- Unit tests for core behavior.

### Slice 2 — store integration

- `@mirk/fixtures/store` subpath.
- Structural `KvLike` source support over `SyncStore` / `AsyncStore` collection methods.
- Store seeding helper that writes validated fixtures into explicit target collections.
- Tests over `InMemoryKv` and SQLite when available.
- Source cache invalidation hook.

### Slice 3 — filesystem/package sources

- Node filesystem source with path safety.
- Package/resource source for shipped defaults.
- Export-map smoke tests.

### Slice 4 — reference graph + materialization

- `resolveRef`.
- Validation aggregation.
- Reference graph.
- Materialization cache and cycle detection.

### Slice 5 — CLI

- `validate`, `list`, `show`, `graph`, `explain`.
- JSON output mode.
- Optional parser configuration.

## Open design questions

1. Should store-backed fixtures be stored as one collection for all types or one collection per type?
   The source adapter can support both, but examples should pick one.
2. Should CLI parser plugins be configured by JS config file, package subpath, or command-line
   dynamic import?
3. What real no-Promise consumer would justify a future `@mirk/fixtures/sync` subpath and the
   accompanying parity matrix?
4. Should nested fixture ids remain a later feature, or should a first implementation expose an
   explicit opt-in before package release?

## Acceptance criteria

The feature is ready for implementation when:

- This spec is linked from the roadmap.
- The first implementation slice has a reviewed package boundary and export map.
- Tests demonstrate store-backed fixtures over `@mirk/store/kv` without depending on a concrete
  backend.
- Root imports remain native-free and Node-built-in-free.
- Docs and examples contain no private project names, local paths, or application-specific details.
