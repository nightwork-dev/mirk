# mirk-fixtures

The Python port of `@mirk/fixtures`: authored documents, loaded through layered
sources, patched, validated, and explained.

A fixture is a JSON document somebody wrote by hand. This package finds those
documents across several sources, merges them by priority so a local pack can
override a shipped one, validates the result against a JSON Schema, and tells
you which files contributed to the value you got.

The TypeScript package and this one replay the same conformance corpus, so a
Python process and a Node process read the same fixture pack the same way.

## Install

```bash
uv add mirk-fixtures
```

No third-party runtime dependencies. The install pulls `mirk-store`, which this
package depends on for the store source's structural type and for the JSON
number rules a document is read under. The JSON Schema engine is **injected**,
never imported, so this package holds no opinion about which one you use.

## Namespace package

`mirk` is a PEP 420 namespace package. There is no `src/mirk/__init__.py` in
either distribution, so `mirk.fixtures` installs beside `mirk.store` the way the
npm `@mirk/*` scope works. Do not add one.

## Use

Documents live in a source. A type says which directory holds them and what
shape they must have. The loader puts the two together.

```python
import jsonschema
from mirk.fixtures import FixtureLoader, FixtureRegistry
from mirk.fixtures.sources.memory import MemoryFixtureSource


def validator_factory(document):
    engine = jsonschema.Draft202012Validator(document)
    return lambda value: [
        {"message": e.message, "path": list(e.absolute_path)} for e in engine.iter_errors(value)
    ]


registry = FixtureRegistry()
registry.register(
    {
        "type": "theme",
        "directory": "themes",
        "jsonSchema": {"type": "object", "required": ["name"]},
    }
)

source = MemoryFixtureSource("pack", {"themes/dark.json": '{"name":"Dark"}'})
loader = FixtureLoader(registry, [source], json_schema_validator=validator_factory)

loader.load("theme:dark")  # {"name": "Dark"}
loader.list()  # ["theme:dark"]
loader.validate()  # {"ok": True, "diagnostics": []}
```

A fixture is addressed by a **ref**, `type:id`. The id is the file's basename
with the matched extension removed.

`jsonschema` is a suggestion, not a requirement. Any callable that takes a
schema document and returns a validator works. `mirk.fixtures.conformance`
exports `json_schema_validator_factory`, the one the test suite injects, if you
want a working default rather than the six lines above.

Method names keep the TypeScript camelCase spelling (`loadRaw`,
`referenceGraph`) and every structured result is a plain dict with the
TypeScript key spelling, so a corpus operation dispatches identically in both
languages.

## Layers

Sources are layers. A higher priority wins, and a document carrying `$patch`
merges into the layer below it instead of replacing it.

```python
from mirk.fixtures import LayeredSource

shipped = MemoryFixtureSource(
    "shipped",
    {
        "themes/dark.json": '{"name":"Dark","palette":{"bg":"#000"}}',
    },
)
local = MemoryFixtureSource(
    "local",
    {
        "themes/dark.json": '{"$patch":"theme:dark","palette":{"fg":"#fff"}}',
    },
)

layered_registry = FixtureRegistry()
layered_registry.register(
    {"type": "theme", "directory": "themes", "jsonSchema": True, "mergeStrategy": "deep"}
)
loader = FixtureLoader(
    layered_registry,
    [LayeredSource(shipped, "shipped", 0), LayeredSource(local, "local", 10)],
    json_schema_validator=validator_factory,
)

loader.load("theme:dark")
# {"name": "Dark", "palette": {"bg": "#000", "fg": "#fff"}}

loader.loadRaw("theme:dark")["provenance"]["layers"]
# [{... "path": "themes/dark.json", "kind": "base"},
#  {... "path": "themes/dark.json", "kind": "patch"}]
```

`mergeStrategy` is `replace` (the default), `deep`, or `array-replace`. A patch
can add and overwrite; it can never delete a key. Provenance names the documents
that contributed and in what order, which is what `explain` reports.

## Sources

**Memory** holds documents in a dict. Deterministic, no I/O, and what the
conformance corpus is built on.

**Filesystem** walks a directory. Every discovered path is resolved to its real
path and must stay inside the root, so a symlink pointing outward is an error
rather than a leak. Symlinked directories are not descended into.

```python
from mirk.fixtures.sources.filesystem import FilesystemFixtureSource

source = FilesystemFixtureSource("disk", "./fixtures")
```

**Store** reads documents out of a `mirk-store` collection, so a fixture pack
can live in the same SQLite file as everything else.

```python
from mirk.store import SqliteStore
from mirk.fixtures.sources.store import StoreFixtureSource, seed_store_from_fixtures

store = SqliteStore("data.db")
store.put(
    "fixture_docs",
    {
        "id": "dark",
        "content": '{"name":"Dark"}',
        "extension": ".json",
    },
)

source = StoreFixtureSource("db", store, "fixture_docs", path_prefix="themes")
loader = FixtureLoader(registry, [source], json_schema_validator=validator_factory)
loader.load("theme:dark")
```

A row is `{id, content, extension, relativePath?}`. The path is
`<path_prefix>/<id><extension>` unless the row carries its own `relativePath`,
which is used as given. The listing is cached until you call
`source.invalidate()`, which the loader never does for you. Refreshing a
store-backed loader takes both calls in order: `source.invalidate()` drops the
listing, then `loader.invalidate()` drops the parsed and materialized values
built from it.

`seed_store_from_fixtures` runs the other way, writing loaded fixtures into a
collection:

```python
seed_store_from_fixtures(loader, store, {"theme": "themes"}, include_provenance=True)
store.getById("themes", "dark")
# {"id": "dark", "value": {"name": "Dark"}, "provenance": {...}}
```

Every fixture is collected and validated before the first write, so a validation
failure or a load failure writes nothing. A write that fails partway through the
batch is NOT rolled back: the rows already written stay written.

## Reports

`validate(ref=None)` returns `{"ok": bool, "diagnostics": [...]}` and degrades
rather than raising: one broken source contributes a diagnostic and the rest of
the pack still loads. `load` does not degrade, because a caller asking for one
fixture wants that fixture or an error.

`referenceGraph()` returns the nodes and edges of every `{"$ref": "type:id"}`
in the pack, with unresolved targets kept visible rather than dropped.

## Ordering

Everything sorts by Unicode code point: registered type names, `list()` results,
and every source's entries. Python's default string comparison is code point
order, so this package needs no comparator; the TypeScript package uses an
explicit one to reach the same answer.

## The contract

The corpus at `conformance/` in the repository root is the contract. Both the
TypeScript suite and this package replay every `fixtures/` scenario against both
backends. A behavior that is not in the corpus is not contractual.

Two things the corpus deliberately does not own. **Schema messages**: Ajv and
`jsonschema` word every failure differently, so a validation scenario compares
the set of failing instance paths and nothing else. **Parse errors**: the
message wraps the host parser's own words, and V8 and CPython disagree, so those
are compared with the message dropped from both sides. Everything else, every
message this package writes itself, is compared exactly.

The function `mergeStrategy` and the `validateReferences`, `extractReferences`
and `materialize` hooks are code and cannot cross a language boundary. Each
language pins those with its own tests.

## Tests

```bash
uv sync --group dev
uv run pytest -q
uv run pyright
uv run ruff check .
uv run ruff format --check .
```

`python/` is a uv workspace, so these run the same from either member and share
one lockfile.
