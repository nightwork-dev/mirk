import { Operator } from "opendal";
import { describe, expect, it } from "vitest";
import {
  drain,
  objectStoreConformance,
} from "../../artifact/test/object-store-conformance.js";
import {
  ArtifactCoordinator,
  InMemoryArtifactRepository,
  ObjectWriteRejectedError,
} from "@mirk/artifact";
import { OpenDalObjectStore, OpenDalObjectStoreError } from "../src/index.js";

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
    const rejected = await store
      .put("objects/digest", new TextEncoder().encode("hello"))
      .catch((caught: unknown) => caught);
    expect(rejected).toBeInstanceOf(ObjectWriteRejectedError);
    const error = (rejected as ObjectWriteRejectedError).cause;
    expect(error).toBeInstanceOf(OpenDalObjectStoreError);
    expect(error).toMatchObject({ code: "unsupported-user-metadata" });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("OpenDalObjectStoreError");
    expect(Object.keys(error as object)).not.toContain("name");
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

  it("lists object keys only, never the prefix's directory entry", async () => {
    const store = new OpenDalObjectStore(new Operator("memory"));
    await store.put("objects/a", new Uint8Array([1]));
    await store.put("objects/b", new Uint8Array([2]));
    expect((await store.list("objects/")).map((info) => info.key)).toEqual([
      "objects/a",
      "objects/b",
    ]);
  });

  it("lists keys in code point order, not locale collation or UTF-16 code unit", async () => {
    const store = new OpenDalObjectStore(new Operator("memory"));
    for (const name of ["a", "B", "_", "é", "Z", "\u{1F600}", "\uFFFD"])
      await store.put(`objects/${name}`, new Uint8Array([1]));
    expect((await store.list("objects")).map((info) => info.key)).toEqual(
      ["B", "Z", "_", "a", "é", "\uFFFD", "\u{1F600}"].map((name) => `objects/${name}`)
    );
  });

  it("cleans a conditional object after a source failure once bytes were written", async () => {
    const store = new OpenDalObjectStore(new Operator("memory"));
    const sourceError = new Error("source failed");
    async function* failing(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1]);
      throw sourceError;
    }
    await expect(
      store.put("objects/failure", failing(), { ifAbsent: true })
    ).rejects.toMatchObject({ name: "ObjectWriteRejectedError", cause: sourceError });
    await store.put("objects/failure", new Uint8Array([2]), { ifAbsent: true });
    expect(await store.head("objects/failure")).toMatchObject({ sizeBytes: 1 });
  });

  it("never deletes a concurrent writer's object after a write that stored nothing", async () => {
    const store = new OpenDalObjectStore(new Operator("memory"));
    const put = store.put.bind(store);
    store.put = async (key, source, options) => {
      try {
        return await put(key, source, options);
      } catch (error) {
        if (key === "artifacts/same") await put(key, new TextEncoder().encode("winner"), { mediaType: "text/plain" });
        throw error;
      }
    };
    async function* failing(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1]);
      throw new Error("source failed");
    }
    const coordinator = new ArtifactCoordinator(store, new InMemoryArtifactRepository(), { idFactory: () => "same" });
    await expect(coordinator.write({ bytes: failing(), mediaType: "text/plain" })).rejects.toMatchObject({
      cleanup: "not-needed",
    });
    expect(new TextDecoder().decode(await drain(await store.get("artifacts/same")))).toBe("winner");
  });
});
