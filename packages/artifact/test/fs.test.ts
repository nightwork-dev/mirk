import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileObjectStore } from "../src/fs.js";
import { drain, objectStoreConformance } from "./object-store-conformance.js";

const conformanceRoots: string[] = [];

afterEach(async () => {
  await Promise.all(conformanceRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

objectStoreConformance("FileObjectStore", {
  async createStore() {
    const root = await mkdtemp(join(tmpdir(), "mirk-fs-object-conformance-"));
    conformanceRoots.push(root);
    return new FileObjectStore({ root });
  },
});

describe("FileObjectStore", () => {
  let root: string;
  let store: FileObjectStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "mirk-fs-object-"));
    store = new FileObjectStore({ root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists across store instances (durable, not in-memory)", async () => {
    await store.put("k", new Uint8Array([9, 9]), { mediaType: "application/octet-stream" });
    const reopened = new FileObjectStore({ root });
    expect(await drain(await reopened.get("k"))).toEqual(new Uint8Array([9, 9]));
    expect((await reopened.head("k"))?.mediaType).toBe("application/octet-stream");
  });

  it("deletes both the bytes and the sidecar", async () => {
    await store.put("images/x", new Uint8Array([7]), { mediaType: "image/png" });
    expect(await store.delete("images/x")).toBe(true);
    expect(await store.get("images/x")).toBeUndefined();
    expect(await store.head("images/x")).toBeUndefined();
    await expect(stat(join(root, "images/x.sidecar.json"))).rejects.toThrow();
  });

  it("keeps a byte-file and a nested key directory from colliding", async () => {
    await store.put("a", new Uint8Array([1]));
    await store.put("a/b", new Uint8Array([2, 2]));
    expect(await drain(await store.get("a"))).toEqual(new Uint8Array([1]));
    expect(await drain(await store.get("a/b"))).toEqual(new Uint8Array([2, 2]));
  });

  it("head() falls back to stat when the sidecar is corrupt, not throws", async () => {
    await store.put("images/x", new Uint8Array([1, 2, 3]), { mediaType: "image/png" });
    // Corrupt the sidecar the way a mid-write crash would.
    await writeFile(join(root, "images/x.sidecar.json"), "{ not valid json");
    const info = await store.head("images/x");
    expect(info).toEqual({ key: "images/x", sizeBytes: 3 }); // stat fallback, no throw
    expect(await drain(await store.get("images/x"))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("head() falls back when the sidecar is missing but bytes exist (external seed)", async () => {
    await store.put("k", new Uint8Array([7, 7]));
    await rm(join(root, "k.sidecar.json"));
    expect(await store.head("k")).toEqual({ key: "k", sizeBytes: 2 });
  });

  it("F2: a failed ifAbsent put does not poison the key", async () => {
    async function* failing(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2]);
      throw new Error("source blew up mid-stream");
    }
    await expect(store.put("k", failing(), { ifAbsent: true })).rejects.toThrow(/blew up/);
    // The partial .bin must be gone, so the retry succeeds instead of EEXIST.
    const info = await store.put("k", new Uint8Array([9]), { ifAbsent: true });
    expect(info.sizeBytes).toBe(1);
    expect(await drain(await store.get("k"))).toEqual(new Uint8Array([9]));
  });

  it("overwrite refreshes the sidecar (new size + mediaType visible via head)", async () => {
    await store.put("k", new Uint8Array([1, 1, 1]), { mediaType: "image/png" });
    await store.put("k", new Uint8Array([2]), { mediaType: "image/jpeg" });
    expect(await store.head("k")).toEqual({ key: "k", sizeBytes: 1, mediaType: "image/jpeg" });
  });
});
