import { describe, expect, it } from "vitest";
import { createFixtureLoader, createFixtureRegistry } from "./index.js";
import { createMemoryFixtureSource } from "./sources/memory.js";

describe("field origins", () => {
  for (const strategy of ["replace", "deep", "array-replace"] as const) {
    it(`traces ${strategy} writes including equal values and replaced arrays`, async () => {
      const registry = createFixtureRegistry();
      registry.register({ type: "thing", directory: "things", jsonSchema: true, mergeStrategy: strategy });
      const files = (id: string, value: unknown) => createMemoryFixtureSource({ id, files: { "things/a.json": JSON.stringify(value) } });
      const loader = createFixtureLoader({ registry, jsonSchemaValidator: () => () => [], sources: [
        files("old", { stale: true }),
        files("base", { same: 1, nested: { keep: 2, set: 3 }, list: [1, 2] }),
        files("edit", { $patch: "thing:a", same: 1, nested: { set: 4 }, list: [1] }),
      ] });
      const { provenance: { fields } } = await loader.loadRaw("thing:a");
      expect(fields["/same"]?.sourceId).toBe("edit");
      expect(fields["/list/0"]?.sourceId).toBe("edit");
      expect(fields["/list/1"]).toBeUndefined();
      expect(fields["/stale"]).toBeUndefined();
      expect(fields["/nested/keep"]?.sourceId).toBe(strategy === "deep" ? "base" : undefined);
      expect(fields["/nested/set"]).toMatchObject({ sourceId: "edit", path: "things/a.json", fieldPath: "/nested/set", kind: "patch" });
    });
  }
  it("omits origins after a schema mutates authored fields", async () => {
    const registry = createFixtureRegistry();
    registry.register({ type: "thing", directory: "things", schema: {
      "~standard": { version: 1, vendor: "test", validate(value) {
        (value as { a: number }).a = 2;
        return { value };
      } },
    } });
    const source = createMemoryFixtureSource({ id: "base", files: { "things/a.json": '{"a":1}' } });
    const loaded = await createFixtureLoader({ registry, sources: [source] }).loadRaw("thing:a");
    expect(loaded.value).toEqual({ a: 2 });
    expect(loaded.provenance.fields).toEqual({});
  });
  it("uses source-document pointers for escaped map keys and omits injected ids", async () => {
    const registry = createFixtureRegistry();
    registry.register({ type: "thing", directory: "things", jsonSchema: true, document: { kind: "map", idField: "id" } });
    const source = createMemoryFixtureSource({ id: "base", files: { "things/all.json": JSON.stringify({ "a/b~": { "x/y": 3 } }) } });
    const loader = createFixtureLoader({ registry, sources: [source], jsonSchemaValidator: () => () => [] });
    const { provenance: { fields } } = await loader.loadRaw("thing:a/b~");
    expect(fields["/x~1y"]).toMatchObject({ path: "things/all.json#a/b~", fieldPath: "/a~1b~0/x~1y" });
    expect(fields["/id"]).toBeUndefined();
  });
});
