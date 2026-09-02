# `@mirk/fixtures` — behavioral semantics digest

Sources: `packages/fixtures/src/types.ts` (public contract), `registry.ts`, `refs.ts`,
`layering.ts`, `loader.ts` (the whole pipeline), `reference-graph.ts`, `errors.ts`,
`cli.ts`, `sources/{memory,filesystem,package,store}.ts`, the tests
`fixtures.test.ts`, `cli.test.ts`, `sources/filesystem.test.ts`, plus
`packages/fixtures/README.md` and `docs/fixtures-spec.md`.

Package version at the time of writing: `0.4.3` (`packages/fixtures/package.json:3`).
Keyed map documents arrived in `69a06ad`, canonical Standard Schema types in `9baf0da`,
keyed patch id enforcement in `e6f6343`.

Nothing here was probed by running code. Every claim is read off the named line and
cross-checked against a test where one exists; claims with no test are marked
**UNPINNED** and are the ones a Python port is most likely to get wrong silently.

Read `docs/python-port-spec.md` decision 6 and the phase 2 sketch alongside section 12:
the plan is that a fixture type declares a JSON Schema *document* and each language
validates it with its own tool, with Standard Schema demoted to an optional
typed-output hook. Section 12 says exactly what that changes.

---

## 0. Shape of the package

Six entry points, one namespace, no barrels (`package.json:29-56`):

| Import | Contents | Node-only |
| --- | --- | --- |
| `@mirk/fixtures` | types, `defineFixtureType`, registry, loader, ref helpers, errors | no |
| `@mirk/fixtures/memory` | `createMemoryFixtureSource` | no |
| `@mirk/fixtures/store` | `createStoreFixtureSource`, `seedStoreFromFixtures` | no |
| `@mirk/fixtures/filesystem` | `createFilesystemFixtureSource` | **yes** |
| `@mirk/fixtures/package` | `createPackageFixtureSource` | **yes** |
| `@mirk/fixtures/cli` | `executeFixtureCli`, `runFixtureCli` | **yes** |

The only runtime dependency is `@standard-schema/spec` (`package.json:76-78`), a
types-only package. Everything above the source boundary — parsing, validation,
layering, patching, reference extraction, materialization, provenance, diagnostics —
is shared and pure.

The whole public surface is `async`. `load`, `loadRaw`, `materialize`, `list`,
`resolveRef`, `validate`, `referenceGraph` all return promises; only `invalidate` is
sync (`types.ts:219-228`). A Python port that follows the store port's "sync by design"
ruling would invert this; nothing in the semantics requires async, because the only
suspension points are `source.list()`, `source.read()`, the parser, the schema
validator, and the user hooks, all of which are declared `MaybePromise`.

---

## 1. Refs

`refs.ts:4-25`. A ref is `type:id`, parsed by locating the **first** colon.

Rejected (`FixtureError`, code `invalid-ref`, message
`Invalid fixture ref "<ref>". Expected "type:id".`):

- no colon, or colon at index 0, or colon as the last character;
- **more than one colon anywhere** (`ref.indexOf(":", idx + 1) !== -1`, `refs.ts:16`);
- type not matching `^[A-Za-z][A-Za-z0-9_-]*$` (`refs.ts:4`);
- id not matching `^[^:\s][^:\s]*$` (`refs.ts:5`) — non-empty, and **no whitespace
  character anywhere**, including inside the id, not merely at the edges.

So `theme:dark` parses; `theme:a b`, `a:b:c`, `:x`, `x:`, `1theme:x` do not. The
no-whitespace rule is what makes bare-string reference detection safe: the test
"does not treat prose substrings as bare references" (`fixtures.test.ts:415-427`)
relies on `"Use theme:missing in prose only."` failing `isCanonicalRef` because the
whole string is checked, not a substring.

`isCanonicalRef` is `parseRef` in a try/catch (`refs.ts:33-40`). `formatRef(type, id)`
is plain concatenation. `isExplicitRef(v)` is true for a non-array object with a
**string** `$ref` property (`refs.ts:42-45`). `refString` unwraps either form.

Python note: the type regex is ASCII-only, and `\s` in JavaScript is
`[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]`. Python's
`re` `\s` without `re.UNICODE`-equivalent care differs (`str` patterns are Unicode by
default and match a slightly different set, notably `\x1c-\x1f`). Pin the character
class explicitly rather than reusing `\s`.

---

## 2. Fixture types and the registry

`FixtureTypeDefinition` (`types.ts:104-118`):

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | ref namespace, also the registry key |
| `directory` | yes | source-relative directory the documents live in |
| `extensions` | no | accepted file extensions; falls back to every registered parser extension |
| `schema` | **yes today** | Standard Schema v1 validator |
| `document` | no | `{ kind: "map", idField?: string }` — the keyed-map opt-in |
| `purpose` | no | `archetype \| component \| lookup \| factory \| raw`; **carried, never read** |
| `mergeStrategy` | no | `replace` (default) \| `deep` \| `array-replace` \| function |
| `referenceMode` | no | `explicit-only` (default) \| `explicit-and-bare`, per type |
| `validateReferences` | no | custom async hook returning diagnostics |
| `extractReferences` | no | custom reference extraction, additive to the walk |
| `materialize` | no | custom hook run by `materialize()` only |

`purpose` is inert: nothing in `loader.ts` or `cli.ts` reads it. It is metadata for
consumers. A port should carry it and not branch on it.

`defineFixtureType` (`types.ts:135-137`) is a **pure identity cast**. It exists for
inference only, returns its argument, and validates nothing. A Python port has no
equivalent obligation beyond a dataclass.

`FixtureRegistry` (`registry.ts:4-31`):

- `register` throws `FixtureError` code `duplicate-type`, message
  `Fixture type "<t>" is already registered.` on a second registration of the same
  `type` (`registry.ts:8-15`). Pinned by `fixtures.test.ts:63-70`.
- `types()` returns the keys **sorted** with the default JavaScript string sort
  (`registry.ts:27`), which is UTF-16 code-unit order. Sorted type order drives
  `list()` and `validate()` discovery order, so it is observable.
- `get` returns `undefined` for unknown types; `has` is a plain membership test.

The loader accepts any `FixtureRegistryLike` (`types.ts:213-217`) with `get`, `has`,
`types` — the CLI tests supply plain object literals (`cli.test.ts:33`).

---

## 3. Sources

### 3.1 The source contract

```ts
interface FixtureSourceEntry { relativePath: string; locator: string; }
interface FixtureSource {
  readonly id: string;
  list(): MaybePromise<readonly FixtureSourceEntry[]>;
  read(entry: FixtureSourceEntry): MaybePromise<string>;
}
```
(`types.ts:44-53`.)

Two fields, deliberately. `relativePath` is the **public, normalized, forward-slashed**
name used for matching, for provenance, and for diagnostics. `locator` is **opaque** to
the loader — it is only ever handed back to `read()` and used as a cache key. A source
may key on database ids, array indexes, or the path itself. The test
"loads store-backed fixtures by opaque locator instead of parsing relativePath"
(`fixtures.test.ts:518-532`) uses a store item whose id is
`item.with.dots/and/slash.json` while its `relativePath` is `themes/store-theme.json`,
proving the loader never parses the locator.

Every source implementation checks, on `read`, that the entry it is handed was
actually produced by its own most recent `list()` **and** that the `relativePath` still
matches the locator. Rebinding one to the other is `source-read-failed`. This is the
package's confused-deputy guard.

Neither `list()` nor `read()` results are cached by the loader at the *entry* level:
`findCandidates` (`loader.ts:127`) and `findAllFileCandidates` (`loader.ts:312`) call
`source.list()` on **every** call. Only the parsed document is cached
(`loader.ts:147-155`). One `validate()` over N types calls `list()` on every source
O(N) times. **UNPINNED** and a real performance and consistency hazard for the
filesystem source, which re-walks the tree each time.

### 3.2 Memory source — the pure one

`sources/memory.ts`. Constructed from `{ id, files: Record<path, content> }`.

- Paths are normalized once at construction: backslashes to forward slashes, one
  leading `./` stripped (`memory.ts:33-35`).
- `list()` returns entries sorted by the **default string sort** — UTF-16 code-unit
  ascending (`memory.ts:15`) — with `locator === relativePath`.
- `read()` looks up by `locator`; a miss is `FixtureError` code `source-read-failed`,
  message `Memory source "<id>" has no entry "<relativePath>".` (`memory.ts:19-27`).

This is the source a JSON conformance corpus should be built on: fully deterministic,
fully expressible as JSON, no I/O, no locale, no OS.

### 3.3 Filesystem source — Node-only, and the ordering is locale-dependent

`sources/filesystem.ts`. Node built-ins only: `node:fs` sync APIs, `node:path`,
`node:url`.

Root resolution (`filesystem.ts:52-68`): `root` may be a string or a `file:` URL; a
non-`file:` URL throws `unsupported-source-url`. The root is `resolve`d then
`realpathSync`ed and must be a directory; any failure throws `source-root-unavailable`
with a message that **deliberately omits the path** (`filesystem.ts:61-67`), pinned by
`sources/filesystem.test.ts:70-79`.

`walk` (`filesystem.ts:82-119`) recurses depth-first:

- each directory is read with `readdirSync(..., { withFileTypes: true })` and sorted
  with `left.name.localeCompare(right.name)` (`filesystem.ts:88-89`);
- every discovered path is `realpathSync`ed and asserted to be **inside the real root**
  (`filesystem.ts:101-102`); an escape is `source-path-escape`, pinned by the symlink
  test at `sources/filesystem.test.ts:50-68`;
- symlinked directories are **not** descended into (`filesystem.ts:110`); symlinked
  files that resolve inside the root are kept;
- relative paths are joined with `/` and validated by `assertRelativePath`
  (`filesystem.ts:147-164`): rejects empty, any backslash, a leading `/`, a
  `^[A-Za-z]:` drive prefix, and any `.`/`..`/empty segment. Code
  `unsafe-relative-path`;
- the final list is sorted again by `relativePath.localeCompare` (`filesystem.ts:118`).

**Ordering divergence.** `localeCompare` is ICU-collation, not code-point: it orders
`a` before `B`, folds case and accents into a collation key, and its result depends on
the runtime's ICU build. The memory source (`memory.ts:15`) sorts by code unit. So the
same set of paths lists in different orders from the two sources.
`sources/filesystem.test.ts:38-42` asserts `themes/a.json`, `themes/nested/ignored.json`,
`themes/z.json` — all lowercase ASCII, where both comparators agree, so the test does
not catch the divergence.

The store port's phase 1 ruling was to replace `localeCompare` everywhere with a code
point comparator (`docs/python-port-spec.md`, "Tie-break order everywhere"). Fixtures
has not had that pass. **Recommendation for the port: pin code point order for source
listing in the contract and fix the TypeScript filesystem and store sources, or declare
source-entry order unobservable.** See section 4.4 for how far it actually is
observable.

`read` (`filesystem.ts:32-48`) re-resolves the real path and compares it to the one
captured at `list()` time; a change is
`Filesystem source "<id>" entry changed after it was listed "<path>"`. Note that
`list()` **replaces** the locator map on every call, and locators are positional
(`entry:<index>`, `filesystem.ts:26`), so an entry object from an earlier `list()` can
become unreadable or, worse, point at a different file if the directory changed. The
`relativePath` cross-check at `filesystem.ts:34` is what makes that fail closed rather
than silently mis-read.

### 3.4 Package-resource source — a thin wrapper, no `import.meta.resolve`

`sources/package.ts` is 20 lines. It requires `rootUrl.protocol === "file:"` (else
`unsupported-package-source`, pinned at `sources/filesystem.test.ts:103-110`) and
delegates entirely to the filesystem source. **There is no `import.meta.resolve` call
anywhere in the package.** The README's `new URL("./fixtures/", import.meta.url)` idiom
runs in the *caller*, so package resolution never enters this package's semantics.
Bundled or virtual (non-`file:`) package resources are explicitly out of contract.

For a Python port the equivalent is `importlib.resources.files(pkg)` producing a real
directory path, with the same containment rules. Nothing else carries over.

### 3.5 Store source — which `@mirk/store` surface it actually uses

`sources/store.ts`. The store dependency is **structural, not a package import**:
`KvLike<TItem>` declares exactly two methods (`store.ts:13-16`):

- `list<T>(collection): MaybePromise<readonly T[]>` — the whole collection, **no
  filter, no sort, no paging**;
- `getById<T>(collection, id): MaybePromise<T | null | undefined>`.

`WritableKvLike` adds `put<T extends {id: string}>(collection, item)` (`store.ts:18-20`),
used only by the seeding helper. `@mirk/store` appears solely as a devDependency
(`package.json:70`), and the tests satisfy the interface with `InMemoryKv`
(`fixtures.test.ts:2`). No KV `get`/`set`/`keys`, no `listWhereIn`, no vector, search
or graph surface is touched.

A stored fixture document is `StoredFixtureItem` (`store.ts:4-11`):
`{ id, content, extension, relativePath?, updatedAt?, meta? }`. `updatedAt` and `meta`
are carried and never read. An optional `mapItem` adapts a caller's row shape.

Path derivation (`store.ts:176-201`):

- an explicit `relativePath` is used as-is and the `pathPrefix` is **not** applied,
  pinned by `fixtures.test.ts:534-553`;
- otherwise the path is `<pathPrefix>/<id><extension>`;
- both go through `normalizePublicPath`, which strips a leading `./`, leading slashes
  and trailing slashes, then rejects the same unsafe shapes as the filesystem source
  (`unsafe-relative-path`, pinned at `fixtures.test.ts:603-614`).

`loadItems` (`store.ts:61-91`) caches the mapped rows until `invalidate()`. Two rows
that produce the same relative path throw `duplicate-relative-path` at `list()` time
(`store.ts:70-78`, pinned at `fixtures.test.ts:616-633`). Entries are sorted by
`relativePath.localeCompare` then `id.localeCompare` (`store.ts:83-87`) — the same
locale hazard as the filesystem source. `locator` is the item id.

`read` re-checks that the locator's item still maps to the requested relativePath
(`store.ts:102-110`), pinned at `fixtures.test.ts:555-569`.

`seedStoreFromFixtures` (`store.ts:120-174`) is the sink, and its ordering matters:

1. for each `[type, collection]` of `targets` in **object insertion order**, take
   `loader.list(type)` (already sorted);
2. unless `validateBeforeWrite === false`, run `loader.validate(ref)` per ref and throw
   `seed-validation-failed` on the first `ok: false` (`store.ts:129-139`);
3. `loadRaw(ref)`, then `mapItem(fixture)` or the default
   `{ id, value, provenance? }` (`store.ts:203-209`), pushed onto a pending list;
4. **only after every target is collected** does the write loop run. So a validation or
   load failure anywhere writes nothing at all — pinned twice
   (`fixtures.test.ts:659-674` and `676-691`, the second one checking that a valid
   `theme` is not written when a later `template` fails);
5. `mode: "insert-only"` calls `getById` and skips **truthy** existing rows with reason
   `"exists"`; `"upsert"` (the default) always `put`s.

Note the truthiness test at `store.ts:151-152`: a stored value that is falsy would be
treated as absent. **UNPINNED.**

---

## 4. The document model

### 4.1 One file, one fixture

Default. The fixture id is the file's basename with the matched extension removed.
`matchEntry` (`loader.ts:73-91`) is the whole rule:

1. compute the directory prefix (`loader.ts:68-71`): `directory` of `""` or `"/"` means
   the source root and yields an empty prefix; otherwise a trailing `/` is ensured;
2. the entry's `relativePath` must start with that prefix, else no match;
3. the remaining tail must contain **no `/`** — nested paths are ignored, never
   recursed into. `docs/fixtures-spec.md:405-412` states this and flags nested ids as a
   deliberate future question;
4. the first extension from `extensionsFor(def)` for which `tail.endsWith(ext)` wins
   (`loader.ts:84`);
5. the id is the tail minus that extension, and an **empty id is rejected**
   (`loader.ts:88`) — so a bare `themes/.json` is not a fixture.

`extensionsFor` (`loader.ts:63-66`) returns `def.extensions` when it is present and
non-empty, otherwise **every registered parser extension in insertion order**, which is
`.json` first (`loader.ts:38-40`, `loader.ts:780`) followed by caller-supplied parsers
in the order of the `parsers` object. Because the match is `endsWith` and the first hit
wins, a type declaring `extensions: [".json", ".min.json"]` will parse `a.min.json` as
the fixture `a.min`, while `[".min.json", ".json"]` parses it as `a`. Order is
significant. **UNPINNED.**

### 4.2 Keyed map documents

Opt in with `document: { kind: "map", idField?: string }` (`types.ts:96-103`). One file
then produces one fixture per top-level key.

`expandMapDocument` (`loader.ts:197-263`):

- a non-map type returns the parsed document as a single layer whose id is the file id
  and whose `sourcePath` is the plain relative path;
- a map type whose document parses to a non-object, `null`, or an array throws
  `FixtureError` code `invalid-map-document`, message
  `Fixture map documents must parse to an object keyed by fixture id.`
  (`loader.ts:210-222`);
- otherwise each `[key, value]` of `Object.entries(parsed)` becomes a layer with
  `id = key` and `sourcePath = "<relativePath>#<key>"` (`loader.ts:255-260`). The `#key`
  suffix is what a consumer sees in provenance and diagnostics, pinned at
  `fixtures.test.ts:115-118` (`themes/core.json#dark`).

`idField` injection (`loader.ts:227-254`), only when `idField` is set:

- the entry value must be a non-null non-array object, else `invalid-map-fixture`,
  message `Fixture "<type>:<id>" must be an object to inject "<idField>".`;
- if the value already carries that field with a value **different from the map key**,
  throw `map-id-mismatch`, message
  `Map key "<key>" does not match explicit <idField> "<value>".` This check applies to
  patch documents too — pinned separately for base documents
  (`fixtures.test.ts:122-147`) and for patches (`fixtures.test.ts:149-187`), which is
  what commit `e6f6343` added;
- if the value already carries the field and it equals the key, the value is left
  untouched;
- otherwise, and only when the value is **not** a patch document, the key is injected
  as `{ [idField]: id, ...record }` (`loader.ts:252`) — **prepended**, so it lands first
  in JavaScript key order. Patch documents never gain an injected id field.

With no `idField`, none of the above applies: map entries may be any JSON value, and no
identity is checked.

Pinned end-to-end by `fixtures.test.ts:74-120`: two entries in one base file (one
carrying an explicit matching `id`, one not), one patch entry in a higher layer, both
addressable, provenance showing `core.json#dark` then `overrides.json#dark`.

**Key-order caveat for a port.** `Object.entries` on a `JSON.parse`d object yields
integer-like keys first in ascending numeric order, then string keys in insertion
order. Python's `dict` preserves pure insertion order. A map document keyed
`{"10": ..., "2": ..., "b": ..., "a": ...}` therefore expands in the order
`2, 10, b, a` in TypeScript and `10, 2, b, a` in Python. It is observable only through
which duplicate/mismatch error fires first when a document has several bad entries, and
through the order candidates are appended before `list()` re-sorts. Pin it explicitly or
declare it unobservable. **UNPINNED.**

### 4.3 Duplicate detection

`parsedCandidates` (`loader.ts:265-301`) keys every expanded layer by
`sourceId \0 layer \0 priority \0 id` and throws `duplicate-map-fixture`, message
`Fixture "<type>:<id>" appears more than once in the same source layer.`, on a repeat
(`loader.ts:286-295`).

This is **not** map-specific despite the code name. Two files in the same source that
resolve to the same id — `themes/dark.json` and `themes/dark.yaml`, with a `.yaml`
parser registered — collide and throw. **UNPINNED.** Two files in *different* sources
never collide; that is layering.

### 4.4 Where source-entry order is and is not observable

Candidates are collected source-by-source in layer order, and within a source in the
order `list()` returned (`loader.ts:137-141`, `321-331`). That order then affects:

- nothing about which layer wins, because base selection is by **priority**, not by
  arrival (section 5);
- nothing about `list()` output, which is de-duplicated into a `Set` and sorted
  (`loader.ts:496`);
- nothing about provenance, which is emitted in the sorted-layer order;
- **only** which of several competing errors is raised first — a duplicate id, a
  malformed map document, a parse failure.

So the locale-versus-code-point divergence in section 3.3 is observable only through
error selection when a pack has more than one defect. That is a narrow but real
conformance surface: two implementations can disagree about *which* error a broken pack
produces.

### 4.5 Patch documents

`isPatchDocument` (`layering.ts:31-36`): a non-null, non-array object with a **string**
`$patch` property. `$patch: 42` is a base document, not a malformed patch.

`patchBody` (`layering.ts:38-42`) removes `$patch` and returns the rest as the merge
input. There is no other reserved key: no delete sentinel, no array-splice operator, no
JSON Patch operations. A patch can add and overwrite; **it can never remove a key.**

---

## 5. Layering and precedence

### 5.1 Normalizing sources

`normalizeLayers` (`layering.ts:20-28`):

- a bare `FixtureSource` at declaration index `i` becomes
  `{ source, layer: source.id, priority: i, order: i }`;
- an explicit `LayeredSource` keeps its `layer` and `priority` and gains
  `order = i`;
- the array is sorted by `priority` ascending, then `order` ascending.

So priorities may be sparse, may repeat, and declaration order is the documented
tie-break. Mixing bare sources (whose implicit priority is a positional index) with
explicit priorities is legal and confusing; the implicit priorities are array indexes,
not zeros.

### 5.2 Precedence, exactly

`loadRawInternal` (`loader.ts:354-477`), operating on `parsedLayers` in ascending
priority order:

1. **Every** layer's `$patch` value is checked against the ref being loaded, *before*
   base selection. A mismatch throws `patch-ref-mismatch`, message
   `Patch declares "$patch: <declared>" but is being applied to "<ref>".`
   (`loader.ts:373-384`). This fires **even for patches that would be shadowed** —
   pinned deliberately at `fixtures.test.ts:222-245`.
2. The **base is the last (highest-priority) non-patch layer** (`loader.ts:386-392`).
   Higher-priority full documents replace lower-priority ones outright; there is no
   base-to-base merging.
3. No non-patch layer at all is `patch-without-base`, message
   `Fixture "<ref>" has patches but no base document.`, hint
   `At least one layer must contain a full fixture document without $patch.`
   (`loader.ts:394-402`), pinned at `fixtures.test.ts:275-286`.
4. Only the selected base is schema-validated as the starting value
   (`loader.ts:407-413`). **Shadowed bases are never validated** — a lower-priority file
   may be arbitrarily malformed and load cleanly. **UNPINNED.**
5. Layers below the base become provenance entries with kind `"replace"` when they are
   full documents (a shadowed base) or `"shadowed"` when they are patches
   (`loader.ts:417-427`).
6. The base itself gets kind `"base"` (`loader.ts:429-435`).
7. Layers above the base are all patches by construction. Each one whose
   `priority <= base.priority` is recorded as `"shadowed"` and skipped
   (`loader.ts:442-451`) — this is reachable only when a patch shares the base's exact
   priority and was declared later. Every other patch is merged with the type's strategy,
   the merged result is **re-validated**, and the layer is recorded as `"patch"`
   (`loader.ts:453-465`).

The "patches at or below the base priority do not apply" rule is pinned at
`fixtures.test.ts:247-273`, which also pins the provenance sequence
`["shadowed", "base"]`.

Validation after every merge (`loader.ts:458`) is the reason an invalid intermediate
state is attributed to the patch that caused it, and it means the value fed to the next
merge is the schema's **output**, not the raw merged object. With a transforming schema
the strategies compose over transformed values. **UNPINNED.**

### 5.3 Merge strategies, exactly

`mergeWithStrategy` (`layering.ts:44-58`). A function strategy is called with
`(existing, incoming, ctx)` and its return value is used verbatim. Otherwise:

**`replace`** (the default, `layering.ts:51-52`) — `structuredClone(incoming)`. The
patch body wholly replaces the current value. Keys the patch omits are lost.

**`deep`** (`layering.ts:73-84`) — recursive:

```
deepMerge(existing, incoming):
  if either is not a *plain object*: return clone(incoming)
  out = { every own key of existing, deep-cloned }
  for each own [key, value] of incoming:
      out[key] = (key in existing) ? deepMerge(existing[key], value) : clone(value)
  return out
```

Consequences to reproduce exactly:

- **arrays replace**, at every depth — an array is not a plain object, so
  `deepMerge(oldArray, newArray)` short-circuits to `clone(newArray)`. No concatenation,
  no index merging;
- **`null` in the patch overwrites**, because `null` is not a plain object;
- **a scalar overwrites an object and an object overwrites a scalar**, same reason;
- **keys absent from the patch are retained**;
- there is no way to delete a key;
- `isPlainObject` (`layering.ts:96-100`) requires the prototype to be `Object.prototype`
  or `null`. Class instances, `Date`, `Map`, `Set` and typed arrays are replacement
  values, as `docs/fixtures-spec.md:479-483` requires. In JSON-only data this
  distinction never arises;
- the `key in existing` test at `layering.ts:81` is a prototype-chain lookup, so a patch
  key literally named `toString` or `constructor` takes the recursive branch against a
  function, which is not a plain object, so the result is still `clone(incoming)`. Same
  answer, different path. A Python port should use own-key membership.

**`array-replace`** (`layering.ts:86-94`) — a **shallow** object merge. Top-level keys
from `incoming` overwrite wholesale; top-level keys only in `existing` are retained;
nothing recurses. The name is misleading: it is "shallow-merge, so nested objects and
arrays both replace."

All three clone through `cloneJsonish` (`layering.ts:102-110`), which requires
`structuredClone` and **throws `TypeError("Fixture merge values require structuredClone
support.")`** when it is absent. That is why the merge test at
`fixtures.test.ts:327-362` can assert that mutating the result never touches `existing`
or `incoming`: the three strategies are pure and non-aliasing, which
`docs/fixtures-spec.md:474-478` states as a requirement for custom strategies too.

Worked example from that test, with
`existing = { nested: { keep: true, replace: "base" }, list: ["base"], retained: { stable: true } }`
and `incoming = { nested: { replace: "patch" }, list: ["patch"] }`:

| strategy | result |
| --- | --- |
| `replace` | `{ nested: { replace: "patch" }, list: ["patch"] }` |
| `deep` | `{ nested: { keep: true, replace: "patch" }, list: ["patch"], retained: { stable: true } }` |
| `array-replace` | `{ nested: { replace: "patch" }, list: ["patch"], retained: { stable: true } }` |

`MergeContext` (`types.ts:71-80`) hands a custom strategy the target ref and the
provenance layers accumulated **so far** (`provenanceCtx`, `layering.ts:60-68`), which
means the currently-applying patch is not yet in the list when the function runs.

---

## 6. Parsers

`normalizeParsers` (`loader.ts:777-787`) starts from the built-in `{".json": JSON.parse}`
(`loader.ts:38-40`) and overlays the caller's map, so `.json` can be overridden. Four
parser kinds are declared (`types.ts:186-190`): `plain`, `async`, `positioned`,
`async-positioned`. A bare function is normalized to `plain`.

In practice the kind tag is decorative: `parseWith` (`loader.ts:796-798`) just calls
`parser.parse(content)` and awaits the result, and `isPositionedResult`
(`loader.ts:800-805`) sniffs the return value structurally for `{ value, positionFor }`.
A positioned parser's `positionFor` is then **discarded** (`loader.ts:183`) — only
`.value` is kept. The `range` field on `Diagnostic` (`types.ts:39`) is therefore never
populated by this package today. **UNPINNED, and a port should not implement source
ranges.**

A parse failure is wrapped: `FixtureError` code `parse-failed`, message
`Parse error: <underlying message>`, carrying `source` and `path`
(`loader.ts:186-194`). Missing parser for a matched extension is code `no-parser`,
message `No parser registered for "<ext>".`, hint
`Pass a parser for "<ext>" to createFixtureLoader().` (`loader.ts:157-166`).

Parsed documents are cached by `sourceId \0 locator \0 relativePath`
(`loader.ts:148-155`) so a map document is parsed once no matter how many fixtures it
yields.

---

## 7. Validation flow

### 7.1 When the schema runs

`validateAgainstSchema` (`loader.ts:336-348`) calls
`def.schema["~standard"].validate(parsed)` and awaits it. A result carrying a truthy
`issues` array throws `FixtureValidationError`; otherwise `result.value` — the
**schema's output, not the input** — becomes the fixture value.

It runs at exactly three places:

1. on the selected base document, after map-key injection (`loader.ts:407`);
2. after every applied patch merge (`loader.ts:458`);
3. in `resolveRef` on an inline value when an `expectedType` was supplied
   (`loader.ts:529`).

It does **not** run on shadowed layers, and `materialize`'s output is never validated.

### 7.2 Error shape

`FixtureError` (`errors.ts:3-11`) is an `Error` with `name = "FixtureError"`, a
`.diagnostic`, and `message === diagnostic.message`.

`FixtureValidationError` (`errors.ts:13-36`) extends it with `.issues` and builds its
diagnostic as:

- `severity: "error"`, `code: "schema-invalid"`;
- `message`: every issue message joined with `"; "`, or `"Schema validation failed."`
  when the join is empty;
- `fixture`, `source`, `path` from the call site (ref, source id, `sourcePath` — which
  for a map entry includes the `#key` suffix);
- `fieldPath`: **only the first issue's** path, dot-joined.

`formatIssuePath` (`errors.ts:59-61`) accepts both Standard Schema path element forms —
a bare `PropertyKey` or `{ key }` — and dot-joins their string forms. Array indices
therefore appear as `items.0.name`, with no bracket syntax.

`diagnosticsFromError` (`errors.ts:38-57`) is the report-mode adapter:

- a `FixtureValidationError` fans out to **one diagnostic per issue**, each with its own
  `fieldPath`, all sharing the error's `fixture`/`source`/`path`;
- a `FixtureError` yields `{ fixture, ...error.diagnostic }` — the diagnostic's own
  `fixture` wins over the contextual one;
- anything else yields `code: "unknown-error"` with the thrown value's message.

The fan-out is pinned at `cli.test.ts:158-204`: two issues per fixture over two fixtures
gives exactly four diagnostics with field paths `name`, `palette`, `name`, `palette`.

### 7.3 `loader.validate(ref?)`

`loader.ts:539-559`. With a ref, that one fixture. Without, every discovered ref.

For each ref, in sorted order:

1. `loadRawInternal(ref, skippedSources)` — any throw becomes diagnostics via
   `diagnosticsFromError` and the loop continues;
2. `validateExtractedReferences` (`loader.ts:717-755`): for every extracted reference,
   an unparseable ref becomes `invalid-ref` with the `fieldPath`; a reference whose
   target load fails with `not-found` becomes `missing-reference`, message
   `Missing referenced fixture "<ref>".`; **any other failure of a referenced fixture is
   re-thrown**, so a broken target propagates up to the per-ref catch and is reported
   against the *referring* fixture;
3. the type's own `validateReferences` hook, called with the loaded value and a
   `ValidationContext` of `{ ref, has, loadRaw }` (`loader.ts:701-715`), where `has`
   returns false only for `not-found` and rethrows everything else. Returned diagnostics
   are stamped `{ fixture: loaded.ref, ...issue }`, so an issue's own `fixture` wins.

`ok` is `diagnostics.every(d => d.severity !== "error")` — warnings and info do not fail
a report.

### 7.4 Discovery, and the skipped-source retry

`discoverRefsForValidation` (`loader.ts:649-699`) is the most intricate function in the
package. For each registered type, in sorted type order:

1. try `parsedCandidates(type, undefined, skippedSources)`, adding every id as a ref;
2. on a `FixtureError` **that carries a `source`**, add that source id to
   `skippedSources`, record the diagnostics, and **retry the same type once** without
   it. This is how one broken source degrades instead of aborting the report, pinned at
   `fixtures.test.ts:494-516` — a source whose `list()` throws yields exactly one
   `source-list-failed` diagnostic and the good source still loads;
3. then, over every still-live source, scan the entries that did **not** match and emit
   `no-parser` for each one that sits directly under the type's directory and whose
   extension (by last dot, requiring `dot > 0`) has no registered parser
   (`noParserDiagnosticForEntry`, `loader.ts:93-117`). Nested files and files outside
   the directory are silently ignored, and duplicates are suppressed by a
   `source \0 path \0 message` key.

Pinned at `fixtures.test.ts:308-325`: given `themes/dark.yaml`,
`themes/nested/ignored.yaml` and `other/dark.yaml` with no YAML parser, exactly one
diagnostic is produced, for `themes/dark.yaml`.

Once a source is skipped, it stays skipped for the rest of the report, including inside
`loadRawInternal` and the reference-resolution `has`/`loadRaw` — which is why those take
a `skipSources` set at all, and why results computed with a non-empty set are **not
cached** (`loader.ts:355`).

---

## 8. Provenance and `explain`

`FixtureProvenance` (`types.ts:151-154`) is `{ finalRef, layers }`, where each layer is
`{ sourceId, layer, priority, path, kind }` (`types.ts:143-149`) and `kind` is
`"base" | "replace" | "patch" | "shadowed"`.

What a consumer sees, per layer:

| kind | means |
| --- | --- |
| `replace` | a full document at a lower priority that the selected base replaced |
| `shadowed` | a patch that did not apply, because it sits at or below the base's priority |
| `base` | the document the value started from |
| `patch` | a patch that was merged in, in the order it was applied |

Layers appear in ascending priority order, with everything below the base first, the
base, then the applied patches in application order. `path` is the source-relative path,
suffixed `#<key>` for a map entry. There are **no absolute paths and no backend
identifiers** in provenance by construction — `docs/fixtures-spec.md:449-456` makes that
a requirement, and every source produces only normalized relative paths.

Provenance is emitted for the *fully materialized layer stack*, not per field. A
consumer asking "why is this value here" gets the ordered list of documents that
contributed and their kinds; it does **not** get per-field attribution. Nothing in the
package tracks which layer set which key. That is the honest limit of `explain`.

`loader.loadRaw(ref).provenance` is the programmatic form; `mirk-fixtures explain
<config> <ref>` prints it, and `--json` returns the object unchanged (`cli.ts:248-258`).

---

## 9. References, the graph, and materialization

### 9.1 Extraction

`extractReferences` (`loader.ts:757-763`) resolves the mode as
`def.referenceMode ?? opts.referenceMode ?? "explicit-only"` — a **type-level mode
overrides the loader-level one**, in both directions — then runs `walkRefs` and appends
whatever `def.extractReferences` returns, then de-duplicates.

`walkRefs` (`loader.ts:807-843`):

- stops at `depth > 32`, so references nested deeper than 32 levels are invisible.
  **UNPINNED**;
- `null` and `undefined` contribute nothing;
- a **string** contributes a reference only in `explicit-and-bare` mode and only if the
  whole string is a canonical ref;
- an object that `isExplicitRef` contributes `{ ref: value.$ref, fieldPath }` and is
  **not descended into** — nested content under a `$ref` object is invisible;
- arrays contribute numeric path segments;
- a `WeakSet` guards against revisiting an object. Note this is a *global* seen-set for
  the walk, not a path stack: an object reachable by two different paths is walked only
  via the first path encountered. **UNPINNED**, and irrelevant for JSON-parsed data,
  which is always a tree.

`dedupeReferences` (`loader.ts:845-855`) keys on `ref \0 dot-joined-path`, so the same
target at two different paths yields two edges.

### 9.2 `resolveRef`

`loader.ts:499-537`, four branches in order:

1. an explicit `{ $ref }` object → optional `expectedType` check, then `load`;
2. a string that is a canonical ref **and** for which bare refs are enabled → same;
3. otherwise, if `expectedType` was given → validate the value inline against that
   type's schema and return the schema's output. Failure is a `FixtureValidationError`
   with `fixture: "<inline TYPE>"`, `source: "<inline>"`, `path: "<inline>"`;
4. otherwise return the value unchanged.

A type mismatch in branches 1 or 2 is `FixtureError` code `type-mismatch`, message
`Expected ref of type "<expected>" but got "<actual>".`

`bareRefsEnabledFor` (`loader.ts:643-647`): the loader-level `explicit-and-bare` enables
bare refs globally; otherwise the mode is read off the **registered type**, resolved
from `expectedType` when given and from the string's own type otherwise. An unregistered
type simply yields `false` — no throw. Pinned at `fixtures.test.ts:402-413`: the same
string round-trips unchanged under the default mode and loads the fixture under
`explicit-and-bare`.

### 9.3 The reference graph

`loader.referenceGraph()` (`loader.ts:561-599`) walks `list()`, loads each ref, and
builds entries; a ref that fails to load becomes an unresolved entry with no outgoing
references. Malformed extracted refs produce `invalid-ref` diagnostics **on the graph
only** — `validate()` reports them too, but through a different path.

`buildReferenceGraph` (`reference-graph.ts:11-38`): every entry is a node; every
extracted target is added as a node (initially unresolved) and an edge; a final pass
marks every node that was itself a loadable entry as resolved. A malformed ref becomes
a node with `type: "<malformed>"` and `id` equal to the whole ref string
(`reference-graph.ts:40-53`) — visible rather than dropped.

Because `referenceGraph` calls `list()`, which parses every candidate document, a parse
error anywhere makes the whole call throw rather than degrade. Contrast `validate()`,
which degrades. **UNPINNED.**

### 9.4 Materialization

`materializeInternal` (`loader.ts:605-629`):

- results are cached by ref in `materialCache`, **including the no-hook pass-through**;
- a ref already on the stack throws `materialization-cycle`, message
  `Materialization cycle detected: a -> b -> a.` — the cycle is sliced from the first
  occurrence and joined with `" -> "` (`loader.ts:607-615`), pinned at
  `fixtures.test.ts:470-490`;
- with no `materialize` hook the raw value is returned as-is;
- the hook receives `MaterializationContext` (`types.ts:82-86`) whose `loadRaw` is
  **actually `load`** — it returns the fixture *value*, not a `LoadedFixture`
  (`loader.ts:623`). The name is a lie in the current implementation; a port should
  copy the behavior and consider renaming;
- `ctx.materialize` recurses with the current stack, so cycles are caught across the
  whole chain.

Materialized output is never schema-validated and never cached alongside provenance.

---

## 10. Caching and `invalidate`

Three caches (`loader.ts:45-47`):

| cache | key | populated by |
| --- | --- | --- |
| `rawCache` | ref | `loadRawInternal`, **only when `skipSources` is empty** |
| `materialCache` | ref | `materializeInternal`, always |
| `parsedDocumentCache` | `sourceId \0 locator \0 relativePath` | `readAndParse` |

`invalidate()` with no argument clears all three. `invalidate(ref)` deletes **one** raw
entry but clears `materialCache` and `parsedDocumentCache` **entirely**
(`loader.ts:631-641`) — conservative, because a materialized value may depend on any
other fixture. **UNPINNED.**

Source-level caches are separate: the store source has its own `invalidate()`
(`store.ts:113-116`), pinned at `fixtures.test.ts:571-601`, and the loader does not call
it. A consumer must invalidate both.

---

## 11. The CLI — `mirk-fixtures-cli/v1`

`src/cli.ts`, binary at `src/bin.ts` (5 lines: run and set `process.exitCode`).

### 11.1 Envelope

```ts
interface FixtureCliEnvelope<T = unknown> {
  schema: "mirk-fixtures-cli/v1";
  command: string;
  ok: boolean;
  result?: T;          // omitted entirely when undefined
  diagnostics: readonly Diagnostic[];
}
```
(`cli.ts:13-19`, built at `cli.ts:423-439`.)

`command` is itself path-redacted unless `--debug-paths` (`cli.ts:432`), so an unknown
command that looks like a path renders as `<redacted>` — pinned at
`cli.test.ts:383-400`.

### 11.2 Commands and their `result` shapes

| command | result |
| --- | --- |
| `validate` | `{ ok, diagnostics }` (the diagnostics appear both in `result` and at the envelope top level) |
| `list` | `{ refs: string[] }` |
| `show --raw` | `{ ref, type, id, mode: "raw", value, provenance }` |
| `show --materialized` (default) | `{ ref, mode: "materialized", value }` — no `type`, `id` or provenance |
| `explain` | the `FixtureProvenance` object itself |
| `graph --format json` (default) | `{ nodes, edges, diagnostics }` |
| `graph --format dot` | a DOT string |

(`cli.ts:207-270`.) `show`'s default mode is `materialized` and `graph`'s default format
is `json` (`cli.ts:356-357`).

### 11.3 Argument grammar

`parseArguments` (`cli.ts:272-361`): `argv[0]` must be one of
`validate list show explain graph`, or `--help`/`-h`/empty for help. Flags: `--json`,
`--debug-paths`, `--raw`, `--materialized`, `--type <t>`, `--format json|dot`,
`--help`. Any other `-`-prefixed token is a usage error. Positionals are, in order, the
config path (default `mirk.fixtures.mjs`, resolved against cwd) and the ref. A third
positional is an error. Flag/command mismatches are errors: `--type` only on `list`,
`--format` only on `graph`, `--raw`/`--materialized` only on `show`. The config path
must end in `.mjs` or `.js` (`cli.ts:332-336`).

### 11.4 Config loading

`loadConfiguredLoader` (`cli.ts:363-403`) does a **dynamic ESM `import()` of the config
module** and accepts, in order: a constructed `FixtureLoader` (duck-typed by six method
names, `cli.ts:405-416`); an object with a `.loader`; or
`{ registry, sources, parsers?, referenceMode? }` from which it builds a loader. Missing
or malformed pieces are thrown as plain `Error`s and surface as `config-load-failed`.

This is the single least portable thing in the package: the CLI's configuration format
*is a JavaScript module*. A Python port needs its own configuration mechanism and cannot
share this contract. The envelope shape can and should be shared.

### 11.5 Exit codes

`0` no error diagnostics; `2` usage or config failure; `3` when any diagnostic's code is
`unknown-error` or starts with `source-`; `1` otherwise (`cli.ts:600-608`,
`cli.ts:165`). Pinned at `cli.test.ts:332-358` (0/1/1/2/2) and `cli.test.ts:119-138`
and `291-330` for 3.

### 11.6 Determinism and redaction

Two independent passes, and both matter for a conformance corpus:

**`sortJson`** (`cli.ts:683-721`) canonicalizes the result: object keys sorted ascending
by code unit, `Map` → an array of `[key, value]` pairs sorted by the JSON text of the
pair, `Set` → an array sorted by JSON text, `Date` → an ISO string (or `null` when
invalid), `bigint` → `` `${value}n` ``. Cyclic values throw
`TypeError("CLI output contains a cyclic value.")`. Pinned at `cli.test.ts:401-439`,
which asserts `map: [["1n","one"],["2n","<redacted>"]]` and `set: ["a","z"]`.

**`redactAbsolutePaths`** (`cli.ts:751-757`) replaces file URLs, anything
starting with `/`, anything starting with `//`, and `C:\…`-style drive paths with
`<redacted>`, when preceded by start-of-string, whitespace, or one of `("'` `` ` ``.
Applied to every string in every diagnostic and, via `redactResultPaths`
(`cli.ts:646-681`), to **every string anywhere in the result**, including values that
came out of authored fixtures. A diagnostic's `path` field is special-cased: an absolute
path becomes exactly `<redacted>` rather than being pattern-substituted
(`cli.ts:628-630`). `--debug-paths` disables all of it.

**Diagnostic ordering** (`compareDiagnostics`, `cli.ts:723-749`): diagnostics are sorted
by `severity, fixture, source, path, fieldPath, code, message, hint` joined with `\0`
and compared with a plain `<`/`>` **code-unit** comparison (`compareText`,
`cli.ts:767-769`). Determinism is pinned by running the same command twice and comparing
the text (`cli.test.ts:167-172`).

Note the inconsistency worth pinning in a port: diagnostics sort by code unit
(`compareText`), while the graph's nodes and edges sort by `localeCompare`
(`cli.ts:557`, `cli.ts:564-568`). Two comparators in one file.

**DOT escaping** (`dotString`, `cli.ts:592-598`): backslash, double quote, `\n` and
`\r`, in that order. Unresolved nodes render `style=dashed`, resolved ones `style=solid`
(`cli.ts:574-579`). Pinned at `cli.test.ts:237-266`.

---

## 12. What a JSON Schema document changes (phase 2)

`docs/python-port-spec.md` decision 6 and the phase 2 sketch: a fixture type declares
its shape as a JSON Schema document; each language validates with its own tool; Standard
Schema stays as an optional typed-output hook. The 2026-09-01 audit found no consumer
using refinements, transforms, or coercions. Both consumers below confirm that: each is
a hand-rolled predicate walker that returns `{ value }` unchanged on success.

### 12.1 What the two real consumers need

**sigil-chat**, `templates/sigil-chat/packages/runtime-env/src/config.ts` (studio repo).
`sigilConfigSchema` (`config.ts:382-393`) wraps `validateConfig` (`config.ts:396-436`),
which walks the product config by hand and accumulates
`StandardSchemaV1Issue[]`. The type is registered with `extensions: [".yaml"]`,
`mergeStrategy: "deep"`, `purpose: "raw"` and a YAML parser (`config.ts:357-380`).
Keywords needed to express it:

| Check in the walker | JSON Schema |
| --- | --- |
| `must be an object` at each level | `type: "object"`, `required` |
| `auth.registration` is `"closed"`/`"open"` (`config.ts:404-410`) | `enum` |
| provider kind is one of four (`config.ts:806-814`) | `enum` |
| `capability` is chat/embedding/voice (`config.ts:688-698`) | `enum` |
| accent `^#[0-9a-f]{6}$` case-insensitively (`config.ts:415-421`) | `pattern` — **rewritten as `^#[0-9a-fA-F]{6}$`, because JSON Schema regexes carry no `i` flag** |
| slug `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` (`config.ts:794-798`) | `pattern` |
| env var `^[A-Z_][A-Z0-9_]*$` (`config.ts:808-810`) | `pattern` |
| model slug: non-empty, no whitespace (`config.ts:804-806`) | `pattern: "^\\S+$"` |
| "non-empty string", which is **`trim().length > 0`** (`config.ts:818-820`) | **not `minLength: 1`** — a string of spaces passes that. Use `pattern: "\\S"` |
| positive integer (`config.ts:800-802`) | `type: "integer"`, `exclusiveMinimum: 0` |
| non-negative number (`config.ts:553-555`) | `type: "number"`, `minimum: 0` |
| `models` non-empty (`config.ts:657-661`) | `minItems: 1` |
| model is a bare slug **or** an object (`config.ts:459-514`) | `oneOf` / `anyOf` |
| `instanceLabel` is `false` or a non-empty string (`config.ts:423-433`) | `anyOf: [{const: false}, {pattern: "\\S"}]` |
| provider id must not be the reserved default (`config.ts:585-590`) | `not: { const: "…" }` |
| `baseUrl` required when kind is `openai-compatible` (`config.ts:502-507`, `615-620`) | `if`/`then` — **draft 7 or later** |
| `baseUrl` is an http(s) URL, checked with `new URL` (`config.ts:796-804`) | `format: "uri"` is annotation-only; needs `pattern: "^https?://"` plus a residual check for real parseability |

Not expressible in JSON Schema, and therefore **residual checks the loader or consumer
must keep**:

- provider ids unique across the list, and model ids unique within a provider
  (`config.ts:593-595`, `config.ts:664-670`) — `uniqueItems` compares whole items, not a
  field;
- `reasoning.default` must be one of `reasoning.levels` (`config.ts:748-753`) — a
  cross-field constraint;
- real URL parseability beyond a prefix pattern.

**someone host**, `ai/someone-worktrees/host/host/src/fixture/authored.ts` (studio repo).
`fixtureSchema` (`authored.ts:31-42`) delegates to `isFixtureDefinition`
(`authored.ts:102-111`): required string `response`; optional string `workload`;
optional boolean `cachePrompt`; optional `idSlot` that must be a **safe integer ≥ 0**.
Fully expressible: `type`, `required`, `properties`, `type: "integer"`, `minimum: 0`,
and `maximum: 9007199254740991` for the safe-integer bound. Note the walker returns a
**single** issue with the message
`Loopback fixture must contain a string response` for every failure mode, which a schema
would replace with per-field issues — a deliberate, visible message change.

### 12.2 Draft and tooling

Use **draft 2020-12**, matching `conformance/scenario.schema.json`
(`docs/python-port-spec.md`, "Layout"). `if`/`then`, `const`, `oneOf`, `not`,
`exclusiveMinimum` as a number, and `minItems` are all available from draft 7 onward, so
2020-12 costs nothing.

- Python: the `jsonschema` package is already a declared dev dependency
  (`docs/python-port-spec.md`, "Python package"); `Draft202012Validator` with
  `iter_errors` gives the issue list. Making it a **runtime** dependency of a
  `mirk-fixtures` distribution breaks the "zero runtime dependencies" rule the store
  package holds, so the validator should be **injected**, not imported.
- TypeScript: `@mirk/fixtures` today depends only on `@standard-schema/spec` and its
  root entry must stay browser-safe and native-free
  (`docs/fixtures-spec.md:779-790`). Bundling Ajv would break that. The validator must
  likewise be injected through `FixtureLoaderOptions`.

### 12.3 Cross-language issue messages will not match — plan for it

`jsonschema` and Ajv produce different message strings, different error *counts* for the
same document (Ajv short-circuits per keyword by default; `iter_errors` is exhaustive
and nests `context` errors under `anyOf`/`oneOf`), and different path encodings
(`deque` of segments versus a JSON-Pointer `instancePath`).

The current corpus format compares `throws` by **exact message string**
(`docs/python-port-spec.md`, "Scenario format"). That rule cannot survive contact with
two JSON Schema engines. The corpus for fixtures should assert, for a validation
scenario:

- `ok` (boolean);
- the **set of instance paths** that produced an error, dot-joined the way
  `formatIssuePath` does (`errors.ts:59-61`);
- the diagnostic `code` (`schema-invalid`), `fixture`, `source` and `path`;

and explicitly **not** the issue `message`. Everything outside schema validation —
`invalid-ref`, `not-found`, `patch-without-base`, `patch-ref-mismatch`,
`map-id-mismatch`, `duplicate-map-fixture`, `invalid-map-document`, `no-parser`,
`parse-failed`, `unknown-type`, `type-mismatch`, `materialization-cycle` — is generated
by this package's own code and **can** be compared by exact message, as this digest
quotes them.

### 12.4 The TypeScript API shape, without breaking current callers

`schema` is required today (`types.ts:108`, `types.ts:124`). Both known consumers pass
one. The additive change:

```ts
export type JsonSchemaDocument = Record<string, unknown> | boolean;

export interface TypedFixtureTypeDefinition<T, M = T> {
  type: string;
  directory: string;
  extensions?: string[];
  /** Authored-shape contract, validated in every language. */
  jsonSchema?: JsonSchemaDocument;
  /** Optional typed output. When both are present, jsonSchema runs first. */
  schema?: StandardSchemaV1<unknown, T>;
  // …everything else unchanged
}
```

plus a loader option:

```ts
export type JsonSchemaValidatorFactory =
  (document: JsonSchemaDocument) => (value: unknown) => readonly StandardSchemaV1Issue[];

export interface FixtureLoaderOptions {
  // …
  jsonSchemaValidator?: JsonSchemaValidatorFactory;
}
```

Compatibility properties:

- **relaxing** `schema` from required to optional is source-compatible: every existing
  call site still type-checks and behaves identically;
- `defineFixtureType` stays an identity cast, so no runtime change;
- a type carrying neither `schema` nor `jsonSchema` should be rejected at
  `registry.register` time with a new `FixtureError` code — that is the one new failure,
  and it is unreachable for today's callers;
- `validateAgainstSchema` (`loader.ts:336-348`) gains a first step: when `jsonSchema` is
  present and a factory was supplied, run it and throw `FixtureValidationError` with the
  mapped issues; then, when `schema` is present, run it as today and take its output as
  the value. When `jsonSchema` is present and no factory was supplied, the loader should
  **fail loudly** rather than silently skip validation;
- the whole failure surface stays `FixtureValidationError` / `schema-invalid`, so
  consumers, the CLI envelope, and the exit-code classification are untouched.

The deeper consequence for the port: with `jsonSchema` in place, a fixture type's
*authored-data contract* becomes **serializable data** — `type`, `directory`,
`extensions`, `document`, `purpose`, `referenceMode`, a builtin `mergeStrategy` name,
and the schema document. A manifest carrying exactly those fields can be read by both
languages, which is what makes a shared conformance corpus for fixtures possible at all.
The remaining fields — a **function** `mergeStrategy`, `validateReferences`,
`extractReferences`, `materialize` — are code and cannot cross. A corpus should
therefore cover the data-declarable core and treat the four hooks as
language-local extension points, pinned only by TypeScript unit tests.

---

## 13. Every behavioral assertion the tests make

`[P]` = pure: memory source (or no source at all), deterministic, expressible as a JSON
scenario over authored documents. `[E]` = environment-bound: real filesystem, symlinks,
temp directories, dynamic module import, or an `InMemoryKv` instance.

### Registry
1. `[P]` Registering two types and reading `types()` gives them sorted lexicographically. (`fixtures.test.ts:63`)
2. `[P]` Registering the same `type` twice throws a `FixtureError`. (`fixtures.test.ts:69`)

### Keyed map documents
3. `[P]` One map document with two keys yields two independently addressable refs, and `list("theme")` returns both sorted. (`fixtures.test.ts:108`)
4. `[P]` A map entry that omits `idField` has the map key injected; an entry that carries a matching one is left alone. (`fixtures.test.ts:109-113`)
5. `[P]` A higher-layer map document whose entry carries `$patch` patches only that key, deep-merging into the base entry. (`fixtures.test.ts:109-113`)
6. `[P]` Provenance paths for a map fixture are `<file>#<key>`, in layer order. (`fixtures.test.ts:115-118`)
7. `[P]` A pack of map documents validates clean: `{ ok: true, diagnostics: [] }`. (`fixtures.test.ts:119`)
8. `[P]` A base map entry whose explicit `id` disagrees with its key throws `map-id-mismatch` with `path: "<file>#<key>"`. (`fixtures.test.ts:140-146`)
9. `[P]` A **patch** map entry whose explicit `id` disagrees with its key throws `map-id-mismatch` against the patch's own file. (`fixtures.test.ts:180-186`)

### Loading, layering and patches
10. `[P]` A base document in a low layer plus a `$patch` document in a high layer produces the deep-merged value. (`fixtures.test.ts:212-215`)
11. `[P]` That fixture's provenance kinds are `["base", "patch"]` and both paths are the file's relative path. (`fixtures.test.ts:218-219`)
12. `[P]` A `$patch` naming a different ref throws `patch-ref-mismatch` **even when that patch sits below the selected base and would never apply**. (`fixtures.test.ts:244`)
13. `[P]` A patch at a priority at or below the base's does not apply; the value is the base alone. (`fixtures.test.ts:270`)
14. `[P]` That fixture's provenance kinds are `["shadowed", "base"]`. (`fixtures.test.ts:272`)
15. `[P]` A pack with only patch documents and no base throws `patch-without-base`. (`fixtures.test.ts:283-285`)
16. `[P]` A patch above a base but naming a different ref throws `patch-ref-mismatch`. (`fixtures.test.ts:303-305`)
17. `[P]` A file directly under a type directory with an extension no parser handles yields exactly one `no-parser` diagnostic carrying `source` and `path`; a nested file and a file outside the directory yield none. (`fixtures.test.ts:320-324`)

### Merge strategies
18. `[P]` `replace` returns only the incoming keys. (`fixtures.test.ts:343`)
19. `[P]` `deep` merges nested objects key-wise, replaces arrays wholesale, and retains keys the patch omits. (`fixtures.test.ts:344`)
20. `[P]` `array-replace` merges only top-level keys, replacing nested objects and arrays wholesale, and retains omitted top-level keys. (`fixtures.test.ts:345`)
21. `[P]` Mutating any merge result leaves both inputs untouched — all three strategies deep-clone. (`fixtures.test.ts:347-361`)

### References, validation and the graph
22. `[P]` A `{ $ref }` to an existing fixture validates clean and produces one edge with the correct `fieldPath`. (`fixtures.test.ts:377-379`)
23. `[P]` The referenced node is marked `resolved: true`. (`fixtures.test.ts:380`)
24. `[P]` A `$ref` to a nonexistent fixture yields exactly one `missing-reference` diagnostic and `ok: false`. (`fixtures.test.ts:394-395`)
25. `[P]` In the default mode a plain string that *is* a canonical ref produces no edge; only the explicit `$ref` does. (`fixtures.test.ts:397-399`)
26. `[P]` The missing target is a node with `resolved: false`. (`fixtures.test.ts:399`)
27. `[P]` `resolveRef("theme:dark")` returns the string unchanged under the default mode. (`fixtures.test.ts:409`)
28. `[P]` The same call under `referenceMode: "explicit-and-bare"` loads the fixture. (`fixtures.test.ts:412`)
29. `[P]` Under `explicit-and-bare`, a prose string that merely contains `theme:missing` is not a reference: validation is clean and the graph has no edges. (`fixtures.test.ts:425-426`)
30. `[P]` A type's `extractReferences` hook contributes edges the structural walk would never find, and those targets are checked during validation. (`fixtures.test.ts:451-453`)
31. `[P]` A `$ref` whose value is not a valid ref produces an `invalid-ref` diagnostic on the **graph**, carrying `fixture` and `fieldPath`. (`fixtures.test.ts:467`)
32. `[P]` A `materialize` hook that recurses into a cycle throws `materialization-cycle`. (`fixtures.test.ts:487-489`)

### Source failure handling
33. `[P]` A source whose `list()` throws yields one `source-list-failed` diagnostic, `ok: false`, and the other source's fixtures are still discovered. (`fixtures.test.ts:513-514`)
34. `[P]` A direct `load` while that source is broken throws `source-list-failed` — `load` does not degrade the way `validate` does. (`fixtures.test.ts:515`)

### Store source and sink
35. `[E]` A store item whose id contains dots and slashes is loaded through its `relativePath`; the locator is never parsed. (`fixtures.test.ts:531`)
36. `[E]` An item carrying an explicit `relativePath` ignores `pathPrefix`; an item without one gets `<pathPrefix>/<id><extension>`. (`fixtures.test.ts:549-552`)
37. `[E]` `read` with a locator/relativePath pair the source did not list throws `source-read-failed`. (`fixtures.test.ts:566-568`)
38. `[E]` `list()` is sorted by relative path and cached; a row added after the first `list()` is invisible until `invalidate()`. (`fixtures.test.ts:587-600`)
39. `[E]` An item whose `relativePath` escapes with `..` throws `unsafe-relative-path` at `list()`. (`fixtures.test.ts:613`)
40. `[E]` Two items producing the same relative path throw `duplicate-relative-path` at `list()`. (`fixtures.test.ts:632`)
41. `[E]` `seedStoreFromFixtures` writes each type's fixtures into its target collection and, with `includeProvenance`, stores the provenance alongside the value. (`fixtures.test.ts:654-656`)
42. `[E]` A fixture with a missing reference makes seeding throw `seed-validation-failed` and write nothing. (`fixtures.test.ts:670-673`)
43. `[E]` When one target type fails validation, a **valid** fixture of another target type is also not written — collection happens fully before any write. (`fixtures.test.ts:688-690`)

### Filesystem and package sources
44. `[E]` Nested directories are walked, entries are listed in sorted relative-path order, and reading the first listed entry returns its content. (`sources/filesystem.test.ts:38-45`)
45. `[E]` Reading with a locator the source did not issue throws `source-read-failed`. (`sources/filesystem.test.ts:46-48`)
46. `[E]` A symlink pointing outside the root throws `source-path-escape` carrying the offending relative path. (`sources/filesystem.test.ts:59-66`)
47. `[E]` An unavailable root throws `source-root-unavailable` and the **message does not contain the path**. (`sources/filesystem.test.ts:72-78`)
48. `[E]` A `file:` package root loads through the ordinary loader with no special casing. (`sources/filesystem.test.ts:100`)
49. `[E]` A non-`file:` package root throws `unsupported-package-source` at construction. (`sources/filesystem.test.ts:104-109`)

### CLI
50. `[E]` `list --json` exits 0 with `schema: "mirk-fixtures-cli/v1"`, `command: "list"`, `ok: true`, `result: { refs: [...] }` sorted. (`cli.test.ts:61-70`)
51. `[E]` `show --raw --json` returns `mode: "raw"` and the unmaterialized value. (`cli.test.ts:79-82`)
52. `[E]` `show --materialized --json` returns `mode: "materialized"` and the hook's output. (`cli.test.ts:92-95`)
53. `[E]` `list --type <t>` filters, and its human output is the bare ref lines. (`cli.test.ts:102-103`)
54. `[E]` `explain --json` returns the provenance object with `finalRef`. (`cli.test.ts:111`)
55. `[E]` `graph --format dot` exits 0 and contains the quoted ref. (`cli.test.ts:116-117`)
56. `[E]` A source whose `list()` throws with an absolute path in the message exits **3**, emits `source-list-failed`, and the path is absent from the output. (`cli.test.ts:125-131`)
57. `[E]` The same command with `--debug-paths` does contain the path. (`cli.test.ts:132-138`)
58. `[E]` A nonexistent config exits **2** with `config-load-failed`. (`cli.test.ts:141-149`)
59. `[E]` An unknown option exits **2** with `usage-error`. (`cli.test.ts:151-156`)
60. `[E]` A schema returning two issues over two fixtures yields exactly four diagnostics ordered `[a/name, a/palette, z/name, z/palette]`, and two runs produce byte-identical text. (`cli.test.ts:167-198`)
61. `[E]` `validate` with errors exits **1**, `ok: false`, and `result.diagnostics` mirrors the envelope diagnostics. (`cli.test.ts:167`, `:199-203`)
62. `[E]` `graph --json` emits nodes and edges including an unresolved target, with `ok: true` and exit 0 — an unresolved reference is not a graph error. (`cli.test.ts:212-235`)
63. `[E]` DOT output escapes backslash, quote, `\n` and `\r` in both node ids and edge labels, and unresolved nodes are `style=dashed`. (`cli.test.ts:259-265`)
64. `[E]` A parser supplied by the config module is used for a custom extension declared on the type. (`cli.test.ts:285-289`)
65. `[E]` A source whose `read()` throws exits **3** with `source-read-failed` (distinct from `source-list-failed`) and redacts the path. (`cli.test.ts:311-330`)
66. `[E]` Exit codes: valid list 0; missing fixture 1; malformed JSON 1; unknown option 2; missing config 2. (`cli.test.ts:341-358`)
67. `[E]` A config module that throws on import exits **2** with `config-load-failed`, redacted unless `--debug-paths`. (`cli.test.ts:366-381`)
68. `[E]` An unknown command that looks like an absolute path exits 2 and the envelope's `command` field is `<redacted>`, or the literal path under `--debug-paths`. (`cli.test.ts:387-399`)
69. `[E]` Untrusted parser output is made JSON-safe and deterministic: strings redacted at any depth, `Date` → ISO string, `Map` → sorted `[key, value]` pairs with bigint keys as `"1n"`, `Set` → sorted array. (`cli.test.ts:424-438`)

### Assertions no test makes (the port's exposure)
70. `[P]` Two files in one source resolving to the same id (`dark.json` + `dark.yaml`) throw `duplicate-map-fixture`.
71. `[P]` A shadowed base document is never schema-validated, so it may be arbitrarily malformed.
72. `[P]` Extension matching is `endsWith` with first-match-wins over an ordered list, so `extensions` order changes the parsed id of `a.min.json`.
73. `[P]` `directory: ""` or `"/"` matches files at the source root.
74. `[P]` References nested deeper than 32 levels are not extracted.
75. `[P]` A patch cannot delete a key under any strategy.
76. `[P]` `deep` merge treats `null` as an overwrite, not a no-op.
77. `[P]` A positioned parser's `positionFor` is discarded and `Diagnostic.range` is never populated.
78. `[P]` `list()` and `referenceGraph()` throw on a parse error anywhere, while `validate()` degrades.
79. `[P]` `invalidate(ref)` clears the entire materialization and parsed-document caches, not just that ref's.
80. `[P]` `materialize` results are cached even when the type declares no `materialize` hook.
81. `[P]` `ctx.loadRaw` inside a `materialize` hook returns the fixture **value**, not a `LoadedFixture`.
82. `[P]` A `$ref` object's nested content is not walked for further references.
83. `[P]` `purpose` is carried and never read.
84. `[E]` Filesystem and store sources sort with `localeCompare`; the memory source sorts by code unit — the same paths list in different orders.
85. `[E]` The CLI sorts diagnostics by code unit but graph nodes and edges by `localeCompare`.
86. `[E]` `seedStoreFromFixtures` treats a falsy existing row as absent under `insert-only`.
87. `[E]` `source.list()` is called once per type per source on every `validate()`, re-walking the filesystem each time.

---

## 14. Portability verdict, one line each

- **`refs.ts`, `layering.ts`, `reference-graph.ts`, `errors.ts`** — pure, port line for
  line, with the `structuredClone` requirement becoming `copy.deepcopy` and the
  plain-object test becoming an exact-`dict` test.
- **`loader.ts`** — pure apart from the `async` shape and the schema call; the whole
  pipeline (matching, map expansion, base selection, patch application, provenance,
  reference walking, materialization) is portable and is where a conformance corpus
  earns its keep.
- **`registry.ts`, `types.ts`** — trivially portable; `defineFixtureType` has no Python
  analogue.
- **`sources/memory.ts`** — portable, and the right substrate for the corpus.
- **`sources/store.ts`** — portable; depends on exactly two structural store methods,
  `list(collection)` and `getById(collection, id)`, plus `put` for seeding.
- **`sources/filesystem.ts`, `sources/package.ts`** — Node-specific I/O with portable
  *rules* (containment, path safety, no symlinked directories). Re-implement against
  `pathlib`; keep the rules, not the code. Fix the ordering comparator on the way.
- **`cli.ts`** — the envelope (`mirk-fixtures-cli/v1`), the exit-code classification, the
  canonicalization and the redaction rules are all portable and worth sharing verbatim;
  the configuration mechanism (dynamic ESM import of a JS module) is not portable at all
  and needs a Python-native equivalent.
