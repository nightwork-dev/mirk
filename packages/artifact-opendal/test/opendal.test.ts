import { Operator } from "opendal";
import { describe, expect, it } from "vitest";
import {
  drain,
  objectStoreConformance,
} from "../../artifact/test/object-store-conformance.js";
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
    const source = (async function* () {
      yield new TextEncoder().encode("hel");
      yield new TextEncoder().encode("lo");
    })();
    const info = await store.put("objects/test", source, {
      ifAbsent: true,
      mediaType: "text/plain",
    });
    expect(info.sizeBytes).toBe(5);
    expect(
      new TextDecoder().decode(await drain(await store.get("objects/test")))
    ).toBe("hello");
    await expect(
      store.put("objects/test", new Uint8Array(), { ifAbsent: true })
    ).rejects.toBeTruthy();
    expect(await store.delete("objects/test")).toBe(true);
    expect(await store.delete("objects/test")).toBe(false);
  });

  it("rejects opt-in digest metadata when the backend cannot persist user metadata", async () => {
    const store = new OpenDalObjectStore(new Operator("memory"), {
      digestMetadataKey: "content-sha256",
    });
    await expect(
      store.put("objects/digest", new TextEncoder().encode("hello"))
    ).rejects.toThrow(/user metadata/);
  });

  it("lists recursive object keys in deterministic order", async () => {
    const store = new OpenDalObjectStore(new Operator("memory"));
    await store.put("objects/z", new Uint8Array([1]));
    await store.put("objects/a", new Uint8Array([2]));
    expect((await store.list("objects")).map((info) => info.key)).toEqual([
      "objects/a",
      "objects/z",
    ]);
    expect((await store.list("objects/a")).map((info) => info.key)).toEqual([
      "objects/a",
    ]);
  });

  it("cleans a conditional object after a source failure once bytes were written", async () => {
    const store = new OpenDalObjectStore(new Operator("memory"));
    async function* failing(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1]);
      throw new Error("source failed");
    }
    await expect(
      store.put("objects/failure", failing(), { ifAbsent: true })
    ).rejects.toThrow("source failed");
    await store.put("objects/failure", new Uint8Array([2]), { ifAbsent: true });
    expect(await store.head("objects/failure")).toMatchObject({ sizeBytes: 1 });
  });
});
