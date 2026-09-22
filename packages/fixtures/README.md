# @mirk/fixtures

> Typed, layered, explainable authored data.

## Why this exists

Applications do not only run code. They also run authored data: defaults, templates, themes,
configuration fragments, lookup tables, prompts, content packs, test fixtures.

Reading that data is easy. Trusting it is the hard part. Once authored data matters, the same
questions come up repeatedly:

- What shape is this record supposed to have?
- Which source wins when defaults, app overrides, and user overrides all define the same id?
- Can an override patch one field, or does it need to copy the whole object?
- Do references point at records that exist?
- Can a CLI or UI explain where the final value came from?
- Can the same pack be loaded from files in development, bundled defaults in a package, and durable
  store records in production?

`@mirk/fixtures` turns authored data into something load-bearing: validated records, deterministic
precedence, small patch overlays, checked references, and provenance.

```bash
npm install @mirk/fixtures
```

## Imports

Root imports stay dependency-light and runtime-neutral. Source helpers and the CLI live behind
explicit subpaths, so the root entry never pulls filesystem APIs, parser bundles, database bindings,
or CLI code into a browser or edge bundle.

| Import                      | What you get                                                | Node-only |
| --------------------------- | ----------------------------------------------------------- | --------- |
| `@mirk/fixtures`            | registry, type definitions, loader, refs, errors            | no        |
| `@mirk/fixtures/memory`     | in-memory source for tests, examples, and generated packs   | no        |
| `@mirk/fixtures/store`      | store-backed source and store seeding over `@mirk/store/kv` | no        |
| `@mirk/fixtures/filesystem` | filesystem source for local directories and CLI workflows   | yes       |
| `@mirk/fixtures/package`    | file-backed defaults shipped inside a package               | yes       |
| `@mirk/fixtures/cli`        | explicit-config CLI helpers and the `mirk-fixtures` binary  | yes       |

## Quick start

A fixture is addressed by a stable ref, `<type>:<id>`:

```txt
theme:dark
template:welcome
prompt:code-review
```

The type must be registered before loading. The id is source-relative: it is the file's basename with
the matched extension removed, never an absolute path.

```ts
import {
  createFixtureLoader,
  createFixtureRegistry,
  defineFixtureType,
} from "@mirk/fixtures";
import { createMemoryFixtureSource } from "@mirk/fixtures/memory";

const themeType = defineFixtureType({
  type: "theme",
  directory: "themes",
  schema: ThemeSchema,
  mergeStrategy: "deep",
});

const registry = createFixtureRegistry();
registry.register(themeType);

const defaults = createMemoryFixtureSource({
  id: "defaults",
  files: {
    "themes/dark.json": JSON.stringify({
      colors: { background: "#050507", foreground: "#f4f4f5" },
    }),
  },
});

const loader = createFixtureLoader({ registry, sources: [defaults] });
const dark = await loader.load("theme:dark");
```

`register(def)` returns nothing and rejects a duplicate type name. `registry.types()` returns type
names in Unicode code point order.

## Fixture types

`defineFixtureType` preserves TypeScript inference at the call site. A definition has:

| Field                | Meaning                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `type`               | Namespace used in refs. Required.                                                        |
| `directory`          | Source-relative directory holding documents of this type. Required.                      |
| `jsonSchema`         | JSON Schema 2020-12 document for the authored shape. See below.                          |
| `schema`             | Standard Schema v1 validator. See below.                                                 |
| `extensions`         | Accepted extensions. Defaults to the extensions that have registered parsers.            |
| `document`           | `{ kind: "map", idField? }` to author several fixtures in one file.                      |
| `mergeStrategy`      | How patches merge. Defaults to `replace`.                                                |
| `referenceMode`      | `explicit-only` (default) or `explicit-and-bare`. Overrides the loader-wide setting.     |
| `extractReferences`  | `(value) => Array<{ ref, fieldPath }>`, added to the built-in extraction.                |
| `validateReferences` | `(value, ctx) => Diagnostic[]`, cross-document checks run by `validate()`.               |
| `materialize`        | `(value, ctx) => runtime value`, used by `loader.materialize()`.                         |
| `purpose`            | Tooling hint: `archetype`, `component`, `lookup`, `factory`, or `raw`.                   |

### Validation: `jsonSchema` and `schema`

A type declares its shape one of two ways, and may declare both. A type declaring neither is rejected
when it is registered.

**`jsonSchema`** is a JSON Schema 2020-12 document — data, not code — so the same declaration
validates the same authored files in TypeScript and in the Python port. The engine is injected,
because the root entry stays browser-safe and free of runtime dependencies:

```ts
import Ajv2020 from "ajv/dist/2020.js";

const themeType = defineFixtureType({
  type: "theme",
  directory: "themes",
  jsonSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  },
});

const loader = createFixtureLoader({
  registry,
  sources: [defaults],
  jsonSchemaValidator: (document) => {
    const validate = new Ajv2020({ allErrors: true }).compile(document);
    return (value) =>
      validate(value)
        ? []
        : (validate.errors ?? []).map((error) => ({
            message: error.message ?? "invalid",
            path: error.instancePath.slice(1).split("/").filter(Boolean),
          }));
  },
});
```

A type that declares `jsonSchema` and gets no `jsonSchemaValidator` fails loudly rather than loading
unvalidated data. `jsonSchema: true` is the explicit way to say "any document".

**`schema`** is a Standard Schema v1 validator. The package does not choose Zod, Valibot, ArkType, or
any other validator for you. When both are present, `jsonSchema` runs first and the Standard Schema's
output becomes the fixture value.

Either way the failure surface is one error, `FixtureValidationError`, and one diagnostic code,
`schema-invalid`.

### Keyed fixture maps

One file can author several fixtures of the same type. Opt the type into map documents and, when
useful, let the loader inject each map key as an `id` field:

```ts
const backgroundType = defineFixtureType({
  type: "background",
  directory: "backgrounds",
  document: { kind: "map", idField: "id" },
  schema: BackgroundSchema,
  mergeStrategy: "deep",
});
```

```json
{
  "drifter": { "name": "Drifter" },
  "detective": { "name": "Detective" }
}
```

The records are independently addressable as `background:drifter` and `background:detective`. When
`idField` is set, the key fills a missing field on a base record, and an explicitly different value is
rejected. Higher layers may patch either record by placing the same key in another map document with
an ordinary `$patch` value. Provenance identifies both the file and the key, such as
`backgrounds/core.json#detective`.

## Parsers

JSON is built in. YAML, JSON5, TOML, or custom formats are caller choices, supplied by extension:

```ts
import { parse as parseYaml } from "yaml";

const loader = createFixtureLoader({
  registry,
  sources,
  parsers: { ".yaml": parseYaml },
});
```

A parser is a function from text to a value, and may be async. A parser can also be a
`{ kind, parse }` entry where `kind` is `plain`, `async`, `positioned`, or `async-positioned`. A
positioned parser returns `{ value, positionFor(path) }`, which adds a line/column `range` to
diagnostics. Positions only enrich diagnostics; correctness never depends on them.

A matching file with no parser for its extension is a `no-parser` diagnostic. A parse failure is a
`parse-failed` diagnostic carrying the source id, relative path, and the parser's message.

## Sources and layers

A source lists entries and reads them. Sources, parsers, validators, and hooks may be sync or async;
the loader normalizes everything to promises.

```ts
interface FixtureSourceEntry {
  relativePath: string; // matched against type directory and extension; shown in provenance
  locator: string;      // opaque, source-owned read token
}

interface FixtureSource {
  readonly id: string;
  list(): MaybePromise<readonly FixtureSourceEntry[]>;
  read(entry: FixtureSourceEntry): MaybePromise<string>;
}
```

A source reads by `locator`, never by re-deriving identity from `relativePath`.

Sources become layers:

```ts
const loader = createFixtureLoader({
  registry,
  sources: [
    { source: defaults, layer: "base", priority: 0 },
    { source: app, layer: "app", priority: 10 },
    { source: user, layer: "user", priority: 20 },
  ],
});
```

A plain source in the array is shorthand for `{ source, layer: source.id, priority: <array index> }`.
Equal priorities are allowed; declaration order breaks the tie. Layer names such as `base`, `app`,
or `user` are conventions only — the loader treats no name specially.

### Loading rules

For `loadRaw("type:id")` the loader:

1. Parses the ref and finds the registered type (`invalid-ref`, `unknown-type`).
2. Lists every source and matches entries directly under the type directory with an accepted
   extension. Files in nested subdirectories are ignored.
3. Reads and parses each match. A single document is one fixture named by its filename; a map
   document is one fixture per top-level key.
4. Classifies each value as a base document or a patch document (an object with `$patch`).
5. Selects the highest-priority base. With no base at all, it raises `patch-without-base`; with no
   document at all, `not-found`.
6. Validates the base against the type's schema.
7. Applies patches with a higher priority than the base, in priority order, removing the `$patch`
   key and validating after every merge, so a schema error is attributed to the patch that caused
   it.
8. Records provenance and caches the result by ref.

A patch looks like this:

```json
{
  "$patch": "theme:dark",
  "colors": {
    "accent": "#8b5cf6"
  }
}
```

The `$patch` target must exactly match the ref being loaded, including for patches inside map
documents; a mismatch is `patch-ref-mismatch`. Patches at or below the selected base's priority are
not applied.

### Merge strategies

| Strategy        | Behavior                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------- |
| `replace`       | The patch body replaces the value. The default.                                              |
| `deep`          | Plain objects merge recursively; arrays and scalars replace.                                  |
| `array-replace` | Plain objects merge one level deep; every incoming field, including arrays, replaces.         |

`deep` treats only plain objects as mergeable. Dates, Maps, Sets, class instances, and typed arrays
replace like scalars. There is no deletion marker: under `deep` and `array-replace` a patch can add
and overwrite keys but not remove one, and under `replace` the patch body (minus `$patch`) becomes
the whole value.

A custom strategy is a function `(existing, incoming, ctx) => merged`. `ctx.fixture` is the target
ref and `ctx.layers` lists the layers applied so far. Merge functions must not mutate their inputs;
the built-in strategies clone. The merged value is validated like any other.

### Provenance

```ts
const { value, provenance } = await loader.loadRaw("theme:dark");
// provenance.layers:
// [{ sourceId: "defaults", layer: "base", priority: 0,  path: "themes/dark.json", kind: "base" },
//  { sourceId: "app",      layer: "app",  priority: 10, path: "themes/dark.json", kind: "patch" }]
```

Each layer has `kind`:

- `base` — the selected base document;
- `replace` — a lower-priority base that the selected base replaced;
- `patch` — a patch that was applied;
- `shadowed` — a patch that was not applied because it sat at or below the base.

`path` is the normalized source-relative path. Provenance never contains absolute filesystem paths,
package roots, or backend connection details, so it is safe to show in a CLI or UI.

<p align="center">
  <img src="docs/diagrams/layering-pipeline.svg" alt="Layered sources feed @mirk/fixtures, which parses, validates, applies patches, resolves references, and returns a final value plus provenance." width="900" />
</p>

## References

Fixtures refer to other fixtures explicitly:

```json
{
  "title": "Welcome",
  "theme": { "$ref": "theme:dark" }
}
```

Explicit `{ $ref }` objects are always recognized. Bare `"type:id"` strings are opt-in, through
`referenceMode: "explicit-and-bare"` on the loader or on one type, so prose-heavy records do not
accidentally become reference graphs. Even then, a bare string counts only when the whole string is
a canonical ref; a ref-shaped substring inside prose never does. A type's `extractReferences` adds
references the built-in walk cannot see.

`loader.resolveRef(value, expectedType?)` turns a ref-or-inline value into a fixture value:

- a ref loads the referenced fixture, and a ref of the wrong type is `type-mismatch`;
- an inline value with `expectedType` is validated against that type's schema;
- an inline value without `expectedType` is returned unchanged.

`refString`, `parseRef`, `formatRef`, `isCanonicalRef`, and `isExplicitRef` from the root handle refs
directly.

## Validation reports and the reference graph

```ts
const report = await loader.validate();        // or loader.validate("theme:dark")
const graph = await loader.referenceGraph();
```

`validate()` loads every listed fixture, runs schema validation, checks every extracted reference,
and runs each type's `validateReferences` hook. It returns `{ ok, diagnostics }` and keeps going
after a failure: one bad file or one failing source contributes diagnostics while the rest of the
pack is still checked. Missing targets are `missing-reference`; malformed refs are `invalid-ref`.

`referenceGraph()` returns `{ nodes, edges, diagnostics }`. Nodes are `{ ref, type, id, resolved }`;
edges are `{ from, to, fieldPath }`. Dangling targets stay in the graph as `resolved: false`, and
malformed refs become diagnostics rather than crashing construction.

`loader.list(type?)` returns every ref the sources define, in code point order.

## Materialization

Raw data is the validated document. Materialized data is the runtime representation a type's
`materialize` hook builds from it:

```ts
const raw = await loader.load("prompt:review");
const compiled = await loader.materialize("prompt:review");
```

A type without `materialize` passes the raw value through. The hook receives `ctx.loadRaw(ref)` and
`ctx.materialize(ref)` so it can compose other fixtures. Re-entering a ref already being
materialized in the same call chain raises `materialization-cycle`.

Raw and materialized values are cached separately. `loader.invalidate(ref)` drops that raw value and
every materialized value; `loader.invalidate()` drops everything.

## Diagnostics

Every failure is a structured record:

```ts
interface Diagnostic {
  severity: "info" | "warning" | "error";
  code: string;       // e.g. "not-found", "schema-invalid", "patch-without-base"
  message: string;
  fixture?: string;   // ref
  source?: string;    // source id
  path?: string;      // source-relative path
  fieldPath?: string;
  range?: SourceRange;
  hint?: string;
}
```

Throwing APIs (`load`, `loadRaw`, `materialize`, `resolveRef`) throw `FixtureError`, whose
`diagnostic` property carries the record; schema failures throw its subclass
`FixtureValidationError`, which also carries the validator's `issues`. Report APIs (`validate`,
`referenceGraph`) return diagnostics instead. Diagnostics identify files by source id plus relative
path, never by absolute local path.

## Built-in sources

### Memory

```ts
import { createMemoryFixtureSource } from "@mirk/fixtures/memory";

const pack = createMemoryFixtureSource({
  id: "test",
  files: { "prompts/review.json": JSON.stringify({ template: "Review {code}" }) },
});
```

### Filesystem and package resources

Node applications can load an ordinary directory:

```ts
import { createFilesystemFixtureSource } from "@mirk/fixtures/filesystem";

const local = createFilesystemFixtureSource({ id: "local", root: "./fixtures" });
```

Packages can expose file-backed defaults relative to their own module:

```ts
import { createPackageFixtureSource } from "@mirk/fixtures/package";

const defaults = createPackageFixtureSource({
  id: "defaults",
  rootUrl: new URL("./fixtures/", import.meta.url),
});
```

Both resolve the root's real path once, when the source is created. Every discovered file is
resolved to its real path and rejected if it lands outside the root, so a symlink pointing outward
is an error rather than a leak. Listed paths are relative to the root, use `/` separators, and come
back in deterministic order. Relative paths with `..`, empty segments, backslashes, or an absolute
prefix are rejected. The package source needs a `file:` root URL; it does not read bundled browser
manifests.

### Store

Use `@mirk/fixtures/store` when authored data crosses the storage boundary: read fixture documents
from a store collection, or seed validated fixture values into ordinary store collections.
`@mirk/store` knows nothing about fixtures; the dependency runs one way.

<p align="center">
  <img src="docs/diagrams/store-integration.svg" alt="Fixture sources feed @mirk/fixtures, which can seed validated records into @mirk/store/kv while also reading store-backed fixture packs." width="900" />
</p>

**Store as source.** Fixture documents live as items in a collection:

```ts
import { createStoreFixtureSource } from "@mirk/fixtures/store";

const source = createStoreFixtureSource({
  id: "db",
  store: adapter.kv,
  collection: "fixtures",
  pathPrefix: "themes", // optional
});
```

The store only needs `list(collection)` and `getById(collection, id)`, sync or async, so any
`@mirk/store/kv` backend works. Each item is:

```ts
interface StoredFixtureItem {
  id: string;
  content: string;       // the document text, parsed like a file
  extension: string;     // e.g. ".json"
  relativePath?: string;
  updatedAt?: string;
  meta?: Record<string, unknown>;
}
```

The item's path is its `relativePath` when present, otherwise `<pathPrefix>/<id><extension>`. Reads
go through the item id, never through the path, so ids containing dots, slashes, or extension-like
suffixes work. Pass `mapItem` to adapt a differently shaped item. The collection layout is yours to
choose.

The source caches its listing. To pick up writes in a long-running process, call
`source.invalidate()` to drop the listing and then `loader.invalidate()` to drop values built from
it.

**Store as sink.** Validated fixtures can seed ordinary collections:

```ts
import { seedStoreFromFixtures } from "@mirk/fixtures/store";

const { written, skipped } = await seedStoreFromFixtures({
  loader,
  store: adapter.kv,
  targets: { theme: "themes", template: "templates" },
  mode: "upsert",
});
```

- `targets` maps fixture type names to collection names explicitly.
- `mode` is `upsert` (the default) or `insert-only`, which skips ids that already exist and reports
  them in `skipped`.
- Each item is `{ id, value }` with `id` equal to the fixture id; `includeProvenance: true` adds
  `provenance`, and `mapItem(fixture)` replaces the item shape entirely.
- Every fixture is loaded and validated before the first write. A failure throws
  `seed-validation-failed` and writes nothing. `validateBeforeWrite: false` skips the full
  `validate()` pass, though schema validation still runs on load.
- A write that fails partway through is not rolled back; items already written stay written.

## CLI

The authoring CLI takes an explicit JavaScript configuration module:

```text
mirk-fixtures validate <config>
mirk-fixtures list <config> [--type <type>]
mirk-fixtures show <config> <type:id> [--raw|--materialized]
mirk-fixtures explain <config> <type:id>
mirk-fixtures graph <config> [--format json|dot]
```

The supplied path resolves `mirk.fixtures.mjs`, which exports `{ registry, sources, parsers }` or a
constructed loader. The CLI discovers nothing on its own: parser packages are imported by the
configuration module, TypeScript configuration is not supported, and authored content is never
evaluated as code.

Every command prints deterministic human output, or with `--json` this envelope:

```ts
interface FixtureCliEnvelope<T> {
  schema: "mirk-fixtures-cli/v1";
  command: string;
  ok: boolean;
  result?: T;
  diagnostics: readonly Diagnostic[];
}
```

Exit codes: `0` no error diagnostics; `1` fixture, parse, schema, reference, or materialization
failure; `2` CLI usage or configuration failure; `3` source access or unexpected internal failure.
Absolute paths are hidden unless `--debug-paths` is passed.

The same implementation is available programmatically as `executeFixtureCli()` and `runFixtureCli()`
from `@mirk/fixtures/cli`.

## What this is not

- Not a database or storage port. Persistence rides `@mirk/store/kv`.
- Not a schema library. It consumes JSON Schema and Standard Schema validators you supply.
- Not a parser bundle. Formats beyond JSON are injected.
- Not a hot-reload service. It exposes invalidation; file watching belongs above it.
- Not a migration engine. It loads current authored data; versioned migrations are separate.
- Not a domain framework. No kind of content is special to the core.
