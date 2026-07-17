import { Operator } from "opendal";
import { describe, expect, it } from "vitest";
import { OpenDalObjectStore } from "../src/index.js";

describe("OpenDalObjectStore", () => {
  it("streams through OpenDAL's memory backend", async () => {
    const operator = new Operator("memory");
    const store = new OpenDalObjectStore(operator);
    const source = (async function* () { yield new TextEncoder().encode("hel"); yield new TextEncoder().encode("lo"); })();
    const info = await store.put("objects/test", source, { ifAbsent: true, mediaType: "text/plain" });
    expect(info.sizeBytes).toBe(5);
    const output: Uint8Array[] = [];
    for await (const chunk of (await store.get("objects/test"))!) output.push(chunk);
    expect(new TextDecoder().decode(output.length === 1 ? output[0] : Buffer.concat(output))).toBe("hello");
    await expect(store.put("objects/test", new Uint8Array(), { ifAbsent: true })).rejects.toBeTruthy();
    expect(await store.delete("objects/test")).toBe(true);
    expect(await store.delete("objects/test")).toBe(false);
  });
});
