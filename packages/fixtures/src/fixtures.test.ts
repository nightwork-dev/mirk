import { describe, expect, it } from "vitest";
import { InMemoryKv } from "@mirk/store/kv";
import {
  createFixtureLoader,
  createFixtureRegistry,
  defineFixtureType,
  FixtureError,
  type StandardSchemaV1,
} from "./index.js";
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

describe("fixture loading", () => {
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
