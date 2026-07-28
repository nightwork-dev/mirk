import { Operator } from "opendal";
import { describe, expect, it } from "vitest";
import { drain, objectStoreConformance } from "../../artifact/test/object-store-conformance.js";
import { OpenDalObjectStore } from "../src/index.js";

objectStoreConformance("OpenDalObjectStore memory backend", {
  createStore() {
    return new OpenDalObjectStore(new Operator("memory"));
  },
  supportsMetadata: false,
});

describe("OpenDalObjectStore", () => {
  it("streams through OpenDAL's memory backend", async () => {
    const operator = new Operator("memory");
    const store = new OpenDalObjectStore(operator);
    const source = (async function* () { yield new TextEncoder().encode("hel"); yield new TextEncoder().encode("lo"); })();
    const info = await store.put("objects/test", source, { ifAbsent: true, mediaType: "text/plain" });
    expect(info.sizeBytes).toBe(5);
    expect(new TextDecoder().decode(await drain(await store.get("objects/test")))).toBe("hello");
    await expect(store.put("objects/test", new Uint8Array(), { ifAbsent: true })).rejects.toBeTruthy();
    expect(await store.delete("objects/test")).toBe(true);
    expect(await store.delete("objects/test")).toBe(false);
  });
});
