import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { InMemoryKv } from "@mirk/store/kv";
import { compareCodePoints as storeCompareCodePoints } from "@mirk/store";
import {
  createFixtureLoader,
  createFixtureRegistry,
  defineFixtureType,
  FixtureError,
  type FixtureTypeDefinition,
  type JsonSchemaDocument,
  type JsonSchemaValidatorFactory,
  type StandardSchemaV1,
} from "./index.js";
import { mergeWithStrategy } from "./layering.js";
import { compareCodePoints } from "./order.js";
import { createMemoryFixtureSource } from "./sources/memory.js";
import {
  createStoreFixtureSource,
  seedStoreFromFixtures,
  type SeededFixtureItem,
  type StoredFixtureItem,
} from "./sources/store.js";

interface Theme {
  name?: string;
  colors?: Record<string, string>;
  theme?: { $ref: string };
}

const anySchema: StandardSchemaV1<unknown, unknown> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => ({ value }),
  },
};

const objectSchema: StandardSchemaV1<unknown, Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return { value: value as Record<string, unknown> };
      }
      return { issues: [{ message: "Expected object." }] };
    },
  },
};

function registryWithTypes() {
  const registry = createFixtureRegistry();
  registry.register(defineFixtureType<Theme>({
    type: "theme",
    directory: "themes",
    schema: anySchema as StandardSchemaV1<unknown, Theme>,
    mergeStrategy: "deep",
  }));
  registry.register(defineFixtureType<Record<string, unknown>>({
    type: "template",
    directory: "templates",
    schema: objectSchema,
  }));
  return registry;
}

describe("registry", () => {
  it("rejects duplicate fixture types and lists types lexicographically", () => {
    const registry = createFixtureRegistry();
    registry.register(defineFixtureType({ type: "z", directory: "z", schema: anySchema }));
    registry.register(defineFixtureType({ type: "a", directory: "a", schema: anySchema }));

    expect(registry.types()).toEqual(["a", "z"]);
    expect(() => registry.register(defineFixtureType({ type: "a", directory: "again", schema: anySchema }))).toThrow(FixtureError);
  });
});

describe("the layer stack", () => {
  it("refuses two sources sharing an id", () => {
    // The parsed-document cache, the skipped-source set and every diagnostic
    // key a source by its id, so two layers sharing one collapse into each
    // other with no local symptom.
    const registry = createFixtureRegistry();
    registry.register(defineFixtureType({ type: "theme", directory: "themes", schema: anySchema }));
    const lower = createMemoryFixtureSource({
      id: "pack",
      files: { "themes/dark.json": JSON.stringify({ v: 1 }) },
    });
    const higher = createMemoryFixtureSource({
      id: "pack",
      files: { "themes/dark.json": JSON.stringify({ v: 2 }) },
    });

    expect(() =>
      createFixtureLoader({
        registry,
        sources: [
          { source: lower, layer: "base", priority: 0 },
          { source: higher, layer: "app", priority: 10 },
        ],
      }),
    ).toThrow('Duplicate fixture source id "pack".');
  });

  it("keys the parsed-document cache by the matched extension", async () => {
    // One file, two types, two parsers, two parses. `t` matches
    // themes/a.min.json through `.json` and `u` matches it through
    // `.min.json`, so keying by source, locator and path alone would serve
    // t's parse to u.
    const registry = createFixtureRegistry();
    registry.register(defineFixtureType({
      type: "t",
      directory: "themes",
      extensions: [".json", ".min.json"],
      schema: anySchema,
    }));
    registry.register(defineFixtureType({
      type: "u",
      directory: "themes",
      extensions: [".min.json", ".json"],
      schema: anySchema,
    }));
    const source = createMemoryFixtureSource({
      id: "pack",
      files: { "themes/a.min.json": JSON.stringify({ name: "A" }) },
    });
    const loader = createFixtureLoader({
      registry,
      sources: [source],
      parsers: { ".min.json": (content: string) => ({ parser: "min", raw: content }) },
    });

    expect(await loader.list()).toEqual(["t:a.min", "u:a"]);
    expect(await loader.load("t:a.min")).toEqual({ name: "A" });
    expect(await loader.load("u:a")).toEqual({ parser: "min", raw: JSON.stringify({ name: "A" }) });
  });
});

describe("fixture loading", () => {
  it("loads keyed fixture maps and layers individual entries with source-key provenance", async () => {
    const registry = createFixtureRegistry();
    registry.register(defineFixtureType<Record<string, unknown>>({
      type: "theme",
      directory: "themes",
      document: { kind: "map", idField: "id" },
      schema: objectSchema,
      mergeStrategy: "deep",
    }));
    const defaults = createMemoryFixtureSource({
      id: "defaults",
      files: {
        "themes/core.json": JSON.stringify({
          dark: { name: "Dark", colors: { background: "black" } },
          light: { id: "light", name: "Light", colors: { background: "white" } },
        }),
      },
    });
    const app = createMemoryFixtureSource({
      id: "app",
      files: {
        "themes/overrides.json": JSON.stringify({
          dark: { $patch: "theme:dark", colors: { accent: "purple" } },
        }),
      },
    });
    const loader = createFixtureLoader({
      registry,
      sources: [
        { source: defaults, layer: "base", priority: 0 },
        { source: app, layer: "app", priority: 10 },
      ],
    });

    await expect(loader.list("theme")).resolves.toEqual(["theme:dark", "theme:light"]);
    await expect(loader.load("theme:dark")).resolves.toEqual({
      id: "dark",
      name: "Dark",
      colors: { background: "black", accent: "purple" },
    });
    const loaded = await loader.loadRaw("theme:dark");
    expect(loaded.provenance.layers.map((layer) => layer.path)).toEqual([
      "themes/core.json#dark",
      "themes/overrides.json#dark",
    ]);
    await expect(loader.validate()).resolves.toEqual({ ok: true, diagnostics: [] });
  });

  it("rejects explicit IDs that disagree with their fixture map keys", async () => {
    const registry = createFixtureRegistry();
    registry.register(defineFixtureType<Record<string, unknown>>({
      type: "theme",
      directory: "themes",
      document: { kind: "map", idField: "id" },
      schema: objectSchema,
    }));
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "themes/core.json": JSON.stringify({
          dark: { id: "light", name: "Dark" },
        }),
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source] });

    await expect(loader.load("theme:dark")).rejects.toMatchObject({
      diagnostic: {
        code: "map-id-mismatch",
        fixture: "theme:dark",
        path: "themes/core.json#dark",
      },
    });
  });

  it("rejects explicit IDs in map patches that disagree with their keys", async () => {
    const registry = createFixtureRegistry();
    registry.register(defineFixtureType<Record<string, unknown>>({
      type: "theme",
      directory: "themes",
      document: { kind: "map", idField: "id" },
      schema: objectSchema,
      mergeStrategy: "deep",
    }));
    const base = createMemoryFixtureSource({
      id: "base",
      files: {
        "themes/core.json": JSON.stringify({ dark: { name: "Dark" } }),
      },
    });
    const override = createMemoryFixtureSource({
      id: "override",
      files: {
        "themes/override.json": JSON.stringify({
          dark: { $patch: "theme:dark", id: "light", name: "Wrong" },
        }),
      },
    });
    const loader = createFixtureLoader({
      registry,
      sources: [
        { source: base, layer: "base", priority: 0 },
        { source: override, layer: "override", priority: 10 },
      ],
    });

    await expect(loader.load("theme:dark")).rejects.toMatchObject({
      diagnostic: {
        code: "map-id-mismatch",
        fixture: "theme:dark",
        path: "themes/override.json#dark",
      },
    });
  });

  it("loads JSON from memory and applies higher-priority patches with provenance", async () => {
    const registry = registryWithTypes();
    const defaults = createMemoryFixtureSource({
      id: "defaults",
      files: {
        "themes/dark.json": JSON.stringify({ name: "dark", colors: { background: "black", foreground: "white" } }),
      },
    });
    const app = createMemoryFixtureSource({
      id: "app",
      files: {
        "themes/dark.json": JSON.stringify({ $patch: "theme:dark", colors: { accent: "purple" } }),
      },
    });

    const loader = createFixtureLoader({
      registry,
      sources: [
        { source: defaults, layer: "base", priority: 0 },
        { source: app, layer: "app", priority: 10 },
      ],
    });

    await expect(loader.load<Theme>("theme:dark")).resolves.toEqual({
      name: "dark",
      colors: { background: "black", foreground: "white", accent: "purple" },
    });

    const loaded = await loader.loadRaw("theme:dark");
    expect(loaded.provenance.layers.map((layer) => layer.kind)).toEqual(["base", "patch"]);
    expect(loaded.provenance.layers.map((layer) => layer.path)).toEqual(["themes/dark.json", "themes/dark.json"]);
  });

  it("rejects mismatched patches even when the patch would be shadowed", async () => {
    const registry = registryWithTypes();
    const lowerPatch = createMemoryFixtureSource({
      id: "lower-patch",
      files: {
        "themes/dark.json": JSON.stringify({ $patch: "theme:other", colors: { accent: "ignored" } }),
      },
    });
    const base = createMemoryFixtureSource({
      id: "base",
      files: {
        "themes/dark.json": JSON.stringify({ name: "dark", colors: { background: "black" } }),
      },
    });
    const loader = createFixtureLoader({
      registry,
      sources: [
        { source: lowerPatch, layer: "lower", priority: 0 },
        { source: base, layer: "base", priority: 10 },
      ],
    });

    await expect(loader.load("theme:dark")).rejects.toMatchObject({ diagnostic: { code: "patch-ref-mismatch" } });
  });

  it("does not apply patches at or below the selected base priority", async () => {
    const registry = registryWithTypes();
    const lowerPatch = createMemoryFixtureSource({
      id: "lower-patch",
      files: {
        "themes/dark.json": JSON.stringify({ $patch: "theme:dark", colors: { accent: "ignored" } }),
      },
    });
    const base = createMemoryFixtureSource({
      id: "base",
      files: {
        "themes/dark.json": JSON.stringify({ name: "dark", colors: { background: "black" } }),
      },
    });

    const loader = createFixtureLoader({
      registry,
      sources: [
        { source: lowerPatch, layer: "lower", priority: 0 },
        { source: base, layer: "base", priority: 10 },
      ],
    });

    await expect(loader.load<Theme>("theme:dark")).resolves.toEqual({ name: "dark", colors: { background: "black" } });
    const loaded = await loader.loadRaw("theme:dark");
    expect(loaded.provenance.layers.map((layer) => layer.kind)).toEqual(["shadowed", "base"]);
  });

  it("reports patch-only fixtures and patch target mismatches", async () => {
    const registry = registryWithTypes();
    const patchOnly = createMemoryFixtureSource({
      id: "patch-only",
      files: { "themes/dark.json": JSON.stringify({ $patch: "theme:dark", name: "dark" }) },
    });

    const patchOnlyLoader = createFixtureLoader({ registry, sources: [patchOnly] });
    await expect(patchOnlyLoader.load("theme:dark")).rejects.toMatchObject({
      diagnostic: { code: "patch-without-base" },
    });

    const base = createMemoryFixtureSource({
      id: "base",
      files: { "themes/dark.json": JSON.stringify({ name: "dark" }) },
    });
    const badPatch = createMemoryFixtureSource({
      id: "bad-patch",
      files: { "themes/dark.json": JSON.stringify({ $patch: "theme:other", name: "bad" }) },
    });
    const mismatchLoader = createFixtureLoader({
      registry,
      sources: [
        { source: base, layer: "base", priority: 0 },
        { source: badPatch, layer: "patch", priority: 10 },
      ],
    });

    await expect(mismatchLoader.load("theme:dark")).rejects.toMatchObject({
      diagnostic: { code: "patch-ref-mismatch" },
    });
  });

  it("reports unparsed files under fixture directories during validation", async () => {
    const registry = registryWithTypes();
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "themes/dark.yaml": "name: dark",
        "themes/nested/ignored.yaml": "name: ignored",
        "other/dark.yaml": "name: ignored",
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source] });

    const report = await loader.validate();
    expect(report.ok).toBe(false);
    expect(report.diagnostics).toMatchObject([
      { code: "no-parser", source: "pack", path: "themes/dark.yaml" },
    ]);
  });

  it("keeps merge strategies distinct and does not alias inputs", () => {
    const existing = {
      nested: { keep: true, replace: "base" },
      list: ["base"],
      retained: { stable: true },
    };
    const incoming = {
      nested: { replace: "patch" },
      list: ["patch"],
    };
    const ctx = { fixture: "theme:dark", layers: [] };

    const replaced = mergeWithStrategy("replace", existing, incoming, ctx) as typeof incoming;
    const deep = mergeWithStrategy("deep", existing, incoming, ctx) as typeof existing;
    const arrayReplace = mergeWithStrategy("array-replace", existing, incoming, ctx) as typeof existing;

    expect(replaced).toEqual({ nested: { replace: "patch" }, list: ["patch"] });
    expect(deep).toEqual({ nested: { keep: true, replace: "patch" }, list: ["patch"], retained: { stable: true } });
    expect(arrayReplace).toEqual({ nested: { replace: "patch" }, list: ["patch"], retained: { stable: true } });

    deep.nested.keep = false;
    deep.retained.stable = false;
    arrayReplace.nested.replace = "mutated";
    arrayReplace.list.push("mutated");
    replaced.nested.replace = "mutated";

    expect(existing).toEqual({
      nested: { keep: true, replace: "base" },
      list: ["base"],
      retained: { stable: true },
    });
    expect(incoming).toEqual({
      nested: { replace: "patch" },
      list: ["patch"],
    });
  });
});

describe("references", () => {
  it("validates explicit refs and builds a graph", async () => {
    const registry = registryWithTypes();
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "themes/dark.json": JSON.stringify({ name: "dark" }),
        "templates/welcome.json": JSON.stringify({ title: "Welcome", theme: { $ref: "theme:dark" } }),
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source] });

    await expect(loader.validate()).resolves.toMatchObject({ ok: true, diagnostics: [] });
    const graph = await loader.referenceGraph();
    expect(graph.edges).toEqual([{ from: "template:welcome", to: "theme:dark", fieldPath: ["theme"] }]);
    expect(graph.nodes.get("theme:dark")?.resolved).toBe(true);
  });

  it("reports missing refs and keeps bare strings disabled by default", async () => {
    const registry = registryWithTypes();
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "templates/welcome.json": JSON.stringify({ title: "Welcome", theme: { $ref: "theme:missing" }, note: "theme:dark" }),
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source] });

    const report = await loader.validate();
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["missing-reference"]);

    const graph = await loader.referenceGraph();
    expect(graph.edges).toHaveLength(1);
    expect(graph.nodes.get("theme:missing")?.resolved).toBe(false);
  });

  it("keeps resolveRef bare strings opt-in", async () => {
    const registry = registryWithTypes();
    const source = createMemoryFixtureSource({
      id: "pack",
      files: { "themes/dark.json": JSON.stringify({ name: "dark" }) },
    });
    const explicitOnly = createFixtureLoader({ registry, sources: [source] });
    await expect(explicitOnly.resolveRef("theme:dark" as unknown as Theme)).resolves.toBe("theme:dark");

    const bareEnabled = createFixtureLoader({ registry, sources: [source], referenceMode: "explicit-and-bare" });
    await expect(bareEnabled.resolveRef<Theme>("theme:dark")).resolves.toEqual({ name: "dark" });
  });

  it("does not treat prose substrings as bare references", async () => {
    const registry = registryWithTypes();
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "templates/welcome.json": JSON.stringify({ title: "Welcome", note: "Use theme:missing in prose only." }),
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source], referenceMode: "explicit-and-bare" });

    await expect(loader.validate()).resolves.toEqual({ ok: true, diagnostics: [] });
    await expect(loader.referenceGraph()).resolves.toMatchObject({ edges: [] });
  });

  it("uses custom extractReferences for validation and graph construction", async () => {
    const registry = createFixtureRegistry();
    registry.register(defineFixtureType<Theme>({
      type: "theme",
      directory: "themes",
      schema: anySchema as StandardSchemaV1<unknown, Theme>,
    }));
    registry.register(defineFixtureType<Record<string, unknown>>({
      type: "page",
      directory: "pages",
      schema: objectSchema,
      extractReferences: (value) => [{ ref: `theme:${String(value.themeId)}`, fieldPath: ["themeId"] }],
    }));
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "themes/dark.json": JSON.stringify({ name: "dark" }),
        "pages/home.json": JSON.stringify({ title: "Home", themeId: "dark" }),
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source] });

    await expect(loader.validate()).resolves.toEqual({ ok: true, diagnostics: [] });
    const graph = await loader.referenceGraph();
    expect(graph.edges).toEqual([{ from: "page:home", to: "theme:dark", fieldPath: ["themeId"] }]);
  });

  it("surfaces malformed refs in the reference graph diagnostics", async () => {
    const registry = registryWithTypes();
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "templates/bad.json": JSON.stringify({ theme: { $ref: "not a ref" } }),
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source] });

    const graph = await loader.referenceGraph();
    expect(graph.diagnostics).toMatchObject([{ code: "invalid-ref", fixture: "template:bad", fieldPath: "theme" }]);
  });

  it("detects materialization cycles", async () => {
    const registry = createFixtureRegistry();
    registry.register(defineFixtureType<Record<string, string>, unknown>({
      type: "node",
      directory: "nodes",
      schema: objectSchema as StandardSchemaV1<unknown, Record<string, string>>,
      materialize: async (value, ctx) => ctx.materialize(value.next ?? ""),
    }));
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "nodes/a.json": JSON.stringify({ next: "node:b" }),
        "nodes/b.json": JSON.stringify({ next: "node:a" }),
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source], referenceMode: "explicit-and-bare" });

    await expect(loader.materialize("node:a")).rejects.toMatchObject({
      diagnostic: { code: "materialization-cycle" },
    });
  });
});

describe("store integration", () => {
  it("returns validation reports and continues on source list failures", async () => {
    const registry = registryWithTypes();
    const good = createMemoryFixtureSource({
      id: "good",
      files: { "themes/dark.json": JSON.stringify({ name: "dark" }) },
    });
    const loader = createFixtureLoader({
      registry,
      sources: [
        {
          id: "bad-source",
          list: () => { throw new Error("boom"); },
          read: () => "{}",
        },
        good,
      ],
    });

    const report = await loader.validate();
    expect(report.ok).toBe(false);
    expect(report.diagnostics).toMatchObject([{ code: "source-list-failed", source: "bad-source" }]);
    await expect(loader.load("theme:dark")).rejects.toMatchObject({ diagnostic: { code: "source-list-failed" } });
  });

  it("loads store-backed fixtures by opaque locator instead of parsing relativePath", async () => {
    const registry = registryWithTypes();
    const store = new InMemoryKv();
    store.put<StoredFixtureItem>("fixtures", {
      id: "item.with.dots/and/slash.json",
      relativePath: "themes/store-theme.json",
      extension: ".json",
      content: JSON.stringify({ name: "from-store" }),
    });

    const source = createStoreFixtureSource({ id: "store", store, collection: "fixtures" });
    const loader = createFixtureLoader({ registry, sources: [source] });

    await expect(loader.load<Theme>("theme:store-theme")).resolves.toEqual({ name: "from-store" });
  });

  it("does not prefix explicit store relative paths", async () => {
    const store = new InMemoryKv();
    store.put<StoredFixtureItem>("fixtures", {
      id: "dark",
      relativePath: "themes/dark.json",
      extension: ".json",
      content: JSON.stringify({ name: "dark" }),
    });
    store.put<StoredFixtureItem>("fixtures", {
      id: "light",
      extension: ".json",
      content: JSON.stringify({ name: "light" }),
    });

    const source = createStoreFixtureSource({ id: "store", store, collection: "fixtures", pathPrefix: "pack" });
    await expect(source.list()).resolves.toEqual([
      { relativePath: "pack/light.json", locator: "light" },
      { relativePath: "themes/dark.json", locator: "dark" },
    ]);
  });

  it("rejects reads for entries that were not listed by the store source", async () => {
    const store = new InMemoryKv();
    store.put<StoredFixtureItem>("fixtures", {
      id: "dark",
      relativePath: "themes/dark.json",
      extension: ".json",
      content: JSON.stringify({ name: "dark" }),
    });

    const source = createStoreFixtureSource({ id: "store", store, collection: "fixtures" });
    await source.list();
    await expect(source.read({ relativePath: "themes/other.json", locator: "dark" })).rejects.toMatchObject({
      diagnostic: { code: "source-read-failed" },
    });
  });

  it("lists store-backed fixtures deterministically and supports cache invalidation", async () => {
    const store = new InMemoryKv();
    store.put<StoredFixtureItem>("fixtures", {
      id: "b",
      relativePath: "themes/b.json",
      extension: ".json",
      content: JSON.stringify({ name: "b" }),
    });
    store.put<StoredFixtureItem>("fixtures", {
      id: "a",
      relativePath: "themes/a.json",
      extension: ".json",
      content: JSON.stringify({ name: "a" }),
    });

    const source = createStoreFixtureSource({ id: "store", store, collection: "fixtures" });
    await expect(source.list()).resolves.toEqual([
      { relativePath: "themes/a.json", locator: "a" },
      { relativePath: "themes/b.json", locator: "b" },
    ]);

    store.put<StoredFixtureItem>("fixtures", {
      id: "c",
      relativePath: "themes/c.json",
      extension: ".json",
      content: JSON.stringify({ name: "c" }),
    });
    await expect(source.list()).resolves.toHaveLength(2);
    source.invalidate();
    await expect(source.list()).resolves.toHaveLength(3);
  });

  it("rejects unsafe store source relative paths", async () => {
    const store = new InMemoryKv();
    store.put<StoredFixtureItem>("fixtures", {
      id: "bad",
      relativePath: "../themes/bad.json",
      extension: ".json",
      content: "{}",
    });

    const source = createStoreFixtureSource({ id: "store", store, collection: "fixtures" });
    await expect(source.list()).rejects.toMatchObject({ diagnostic: { code: "unsafe-relative-path" } });
  });

  it("detects duplicate store relative paths", async () => {
    const store = new InMemoryKv();
    store.put<StoredFixtureItem>("fixtures", {
      id: "one",
      relativePath: "themes/same.json",
      extension: ".json",
      content: "{}",
    });
    store.put<StoredFixtureItem>("fixtures", {
      id: "two",
      relativePath: "themes/same.json",
      extension: ".json",
      content: "{}",
    });

    const source = createStoreFixtureSource({ id: "store", store, collection: "fixtures" });
    await expect(source.list()).rejects.toMatchObject({ diagnostic: { code: "duplicate-relative-path" } });
  });

  it("seeds validated fixtures into target store collections", async () => {
    const registry = registryWithTypes();
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "themes/dark.json": JSON.stringify({ name: "dark" }),
        "templates/welcome.json": JSON.stringify({ title: "Welcome" }),
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source] });
    const store = new InMemoryKv();

    const result = await seedStoreFromFixtures({
      loader,
      store,
      targets: { theme: "themes", template: "templates" },
      includeProvenance: true,
    });

    expect(result.written.map((item) => item.ref).sort()).toEqual(["template:welcome", "theme:dark"]);
    expect(store.getById<SeededFixtureItem>("themes", "dark")?.value).toEqual({ name: "dark" });
    expect(store.getById<SeededFixtureItem>("themes", "dark")?.provenance?.finalRef).toBe("theme:dark");
  });

  it("does not seed fixtures with missing references", async () => {
    const registry = registryWithTypes();
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "templates/bad.json": JSON.stringify({ theme: { $ref: "theme:missing" } }),
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source] });
    const store = new InMemoryKv();

    await expect(seedStoreFromFixtures({ loader, store, targets: { template: "templates" } })).rejects.toMatchObject({
      diagnostic: { code: "seed-validation-failed" },
    });
    expect(store.count("templates")).toBe(0);
  });

  it("does not write any seed items if validation fails before seeding", async () => {
    const registry = registryWithTypes();
    const source = createMemoryFixtureSource({
      id: "pack",
      files: {
        "themes/dark.json": JSON.stringify({ name: "dark" }),
        "templates/bad.json": JSON.stringify("not an object"),
      },
    });
    const loader = createFixtureLoader({ registry, sources: [source] });
    const store = new InMemoryKv();

    await expect(seedStoreFromFixtures({ loader, store, targets: { theme: "themes", template: "templates" } })).rejects.toBeTruthy();
    expect(store.count("themes")).toBe(0);
    expect(store.count("templates")).toBe(0);
  });
});

describe("jsonSchema and the injected validator", () => {
  // A deliberately tiny stand-in for a real engine. The path-mapping rules that
  // have to agree with Python live in the conformance target and are pinned by
  // the corpus; what these tests pin is the LOADER's plumbing.
  const requireName = (document: JsonSchemaDocument) => (value: unknown) => {
    if (document === true) return [];
    const record = value as Record<string, unknown> | null;
    if (typeof record?.name !== "string") {
      return [{ message: "name must be a string", path: ["name"] }];
    }
    return [];
  };

  function loaderWith(
    def: Partial<FixtureTypeDefinition>,
    files: Record<string, string>,
    jsonSchemaValidator?: JsonSchemaValidatorFactory,
  ) {
    const registry = createFixtureRegistry();
    registry.register({ type: "theme", directory: "themes", ...def } as FixtureTypeDefinition);
    return createFixtureLoader({
      registry,
      sources: [createMemoryFixtureSource({ id: "pack", files })],
      ...(jsonSchemaValidator ? { jsonSchemaValidator } : {}),
    });
  }

  it("rejects a type that declares no shape contract at all", () => {
    const registry = createFixtureRegistry();
    expect(() => registry.register({ type: "theme", directory: "themes" } as FixtureTypeDefinition))
      .toThrowError(
        expect.objectContaining({ diagnostic: expect.objectContaining({ code: "missing-schema" }) }),
      );
  });

  it("validates against jsonSchema and reports schema-invalid", async () => {
    const loader = loaderWith(
      { jsonSchema: { type: "object" } },
      { "themes/dark.json": '{"name":42}' },
      requireName,
    );

    await expect(loader.load("theme:dark")).rejects.toThrowError(
      expect.objectContaining({ diagnostic: expect.objectContaining({ code: "schema-invalid" }) }),
    );
    const report = await loader.validate();
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((diagnostic) => diagnostic.fieldPath)).toEqual(["name"]);
  });

  it("runs jsonSchema BEFORE schema, and takes the Standard Schema output as the value", async () => {
    const order: string[] = [];
    const tagging: StandardSchemaV1<unknown, unknown> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => {
          order.push("schema");
          return { value: { ...(value as Record<string, unknown>), tagged: true } };
        },
      },
    };
    const loader = loaderWith(
      { jsonSchema: { type: "object" }, schema: tagging },
      { "themes/dark.json": '{"name":"Dark"}' },
      (document) => (value) => {
        order.push("jsonSchema");
        return requireName(document)(value);
      },
    );

    expect(await loader.load("theme:dark")).toEqual({ name: "Dark", tagged: true });
    expect(order).toEqual(["jsonSchema", "schema"]);
  });

  it("fails loudly when a type declares jsonSchema and no validator was supplied", async () => {
    const loader = loaderWith({ jsonSchema: { type: "object" } }, { "themes/dark.json": "{}" });

    await expect(loader.load("theme:dark")).rejects.toThrowError(
      expect.objectContaining({
        diagnostic: expect.objectContaining({ code: "no-json-schema-validator" }),
      }),
    );
  });

  it("leaves a schema-only type behaving exactly as before", async () => {
    const loader = loaderWith({ schema: objectSchema }, { "themes/dark.json": '{"name":"Dark"}' });
    expect(await loader.load("theme:dark")).toEqual({ name: "Dark" });
  });
});

describe("code point ordering", () => {
  // `@mirk/fixtures` carries its own copy of the comparator rather than
  // importing `@mirk/store`, which depends on this package for conformance
  // tooling; see src/order.ts. A copy is only safe while it is identical, so
  // this is the guard that says so.
  it("matches the comparator @mirk/store exports", () => {
    const samples = [
      "", "a", "A", "b", "B", "Z", "z", "ä", "a\u{1f600}b", "a�b",
      "themes/Z.json", "themes/a.json", "10", "2", "aa", "a",
    ];
    for (const left of samples) {
      for (const right of samples) {
        expect(
          Math.sign(compareCodePoints(left, right)),
          `${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
        ).toBe(Math.sign(storeCompareCodePoints(left, right)));
      }
    }
  });

  it("orders astral characters above the BMP, unlike a plain string compare", () => {
    expect(compareCodePoints("\u{1f600}", "�")).toBeGreaterThan(0);
    expect("\u{1f600}" < "�").toBe(true);
  });
});

describe("a real JSON Schema engine", () => {
  // The README tells callers to inject Ajv. This runs that recipe, so the
  // documented integration is exercised rather than asserted.
  it("validates through an injected Ajv 2020 factory", async () => {
    const AjvConstructor = (Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020;
    const jsonSchemaValidator: JsonSchemaValidatorFactory = (document) => {
      const validate = new AjvConstructor({ allErrors: true, strict: false })
        .compile(document as object | boolean);
      return (value) =>
        validate(value)
          ? []
          : (validate.errors ?? []).map((error) => ({
            message: error.message ?? "invalid",
            path: error.instancePath.slice(1).split("/").filter(Boolean),
          }));
    };

    const registry = createFixtureRegistry();
    registry.register({
      type: "theme",
      directory: "themes",
      jsonSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" }, weight: { type: "integer", minimum: 0 } },
      },
    } as FixtureTypeDefinition);

    const loader = createFixtureLoader({
      registry,
      sources: [
        createMemoryFixtureSource({
          id: "pack",
          files: {
            "themes/good.json": '{"name":"Good","weight":2}',
            "themes/bad.json": '{"name":"Bad","weight":-1}',
          },
        }),
      ],
      jsonSchemaValidator,
    });

    expect(await loader.load("theme:good")).toEqual({ name: "Good", weight: 2 });

    const report = await loader.validate();
    expect(report.ok).toBe(false);
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      code: "schema-invalid",
      fixture: "theme:bad",
      fieldPath: "weight",
    });
  });
});

describe("a malformed document", () => {
  // The corpus pins that `validate()` degrades, but not that `list()` aborts:
  // the `parse-failed` message is whatever the host parser said, and V8 and
  // CPython word it differently for the same bytes. So the asymmetry is pinned
  // per language, and the message is asserted only loosely here.
  it("makes list() throw while validate() reports it", async () => {
    const registry = createFixtureRegistry();
    registry.register({
      type: "theme",
      directory: "themes",
      jsonSchema: true,
    } as FixtureTypeDefinition);
    const loader = createFixtureLoader({
      registry,
      sources: [
        createMemoryFixtureSource({
          id: "pack",
          files: { "themes/bad.json": "{ not json", "themes/good.json": '{"name":"Good"}' },
        }),
      ],
    });

    await expect(loader.list()).rejects.toThrowError(
      expect.objectContaining({ diagnostic: expect.objectContaining({ code: "parse-failed" }) }),
    );

    const report = await loader.validate();
    expect(report.ok).toBe(false);
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["parse-failed"]);
    expect(report.diagnostics[0]?.message.startsWith("Parse error: ")).toBe(true);
  });
});
