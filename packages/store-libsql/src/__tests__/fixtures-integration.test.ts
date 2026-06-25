// ─── @mirk/fixtures integration over real libSQL ─────────────────────────────
// Keeps the libSQL dependency in the package that already owns it. The fixtures
// package only sees the structural KV/collection port.

import { describe, expect, it, afterEach } from "vitest";
import {
  createFixtureLoader,
  createFixtureRegistry,
  defineFixtureType,
  type StandardSchemaV1,
} from "@mirk/fixtures";
import {
  createStoreFixtureSource,
  seedStoreFromFixtures,
  type SeededFixtureItem,
  type StoredFixtureItem,
} from "@mirk/fixtures/store";
import { LibsqlAdapter } from "../libsql-adapter.js";

interface Theme {
  name: string;
  colors?: Record<string, string>;
}

const themeSchema: StandardSchemaV1<unknown, Theme> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      if (
        typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && typeof (value as { name?: unknown }).name === "string"
      ) {
        return { value: value as Theme };
      }
      return { issues: [{ message: "Expected theme object with string name." }] };
    },
  },
};

let adapter: LibsqlAdapter | undefined;

afterEach(() => {
  adapter?.close();
  adapter = undefined;
});

describe("@mirk/fixtures store helpers over LibsqlAdapter.kv", () => {
  it("loads store-backed fixture documents and seeds validated values", async () => {
    adapter = await LibsqlAdapter.open({ url: ":memory:" });
    await adapter.kv.put<StoredFixtureItem>("fixture_docs", {
      id: "packs/default/theme.dark.json",
      relativePath: "themes/dark.json",
      extension: ".json",
      content: JSON.stringify({ name: "dark", colors: { background: "#050507" } }),
    });

    const registry = createFixtureRegistry();
    registry.register(defineFixtureType<Theme>({
      type: "theme",
      directory: "themes",
      schema: themeSchema,
    }));

    const source = createStoreFixtureSource({
      id: "libsql-fixtures",
      store: adapter.kv,
      collection: "fixture_docs",
    });
    const loader = createFixtureLoader({ registry, sources: [source] });

    await expect(loader.load<Theme>("theme:dark")).resolves.toEqual({
      name: "dark",
      colors: { background: "#050507" },
    });

    const result = await seedStoreFromFixtures({
      loader,
      store: adapter.kv,
      targets: { theme: "themes" },
      includeProvenance: true,
    });

    expect(result.written).toEqual([{ type: "theme", ref: "theme:dark", collection: "themes", id: "dark" }]);
    expect(result.skipped).toEqual([]);
    await expect(adapter.kv.getById<SeededFixtureItem>("themes", "dark")).resolves.toMatchObject({
      id: "dark",
      value: { name: "dark", colors: { background: "#050507" } },
      provenance: { finalRef: "theme:dark" },
    });
  });
});
