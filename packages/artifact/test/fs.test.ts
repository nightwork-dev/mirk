import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

  it("creates a missing root on the first write", async () => {
    const missingRoot = join(root, "new-root");
    const fresh = new FileObjectStore({ root: missingRoot });
    await fresh.put("k", new Uint8Array([1]));
    expect(await drain(await fresh.get("k"))).toEqual(new Uint8Array([1]));
  });

  it("keeps yielded chunks stable across later file reads", async () => {
    const size = 1024 * 1024;
    const bytes = new Uint8Array(2 * size + 7);
    bytes.fill(11, 0, size);
    bytes.fill(22, size, 2 * size);
    bytes.fill(33, 2 * size);
    await store.put("large", bytes);
    const read = await drain(await store.get("large"));
    expect(Buffer.from(read).equals(Buffer.from(bytes))).toBe(true);
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
    const sourceError = new Error("source blew up mid-stream");
    async function* failing(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2]);
      throw sourceError;
    }
    await expect(store.put("k", failing(), { ifAbsent: true })).rejects.toBe(sourceError);
    // The partial .bin must be gone, so the retry succeeds instead of EEXIST.
    const info = await store.put("k", new Uint8Array([9]), { ifAbsent: true });
    expect(info.sizeBytes).toBe(1);
    expect(await drain(await store.get("k"))).toEqual(new Uint8Array([9]));
  });

  it("rejects final byte symlink replacement before lazy consumption", async () => {
    await store.put("k", new Uint8Array([1, 2]));
    const outsideRoot = await mkdtemp(join(tmpdir(), "mirk-fs-lazy-outside-"));
    const outside = join(outsideRoot, "bytes");
    await writeFile(outside, new Uint8Array([9, 9]));
    const stream = await store.get("k");
    expect(stream).toBeDefined();
    await rm(join(root, "k.bin"));
    await symlink(outside, join(root, "k.bin"));
    try {
      await expect(drain(stream)).rejects.toBeTruthy();
      expect([...await readFile(outside)]).toEqual([9, 9]);
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it("overwrite refreshes the sidecar (new size + mediaType visible via head)", async () => {
    await store.put("k", new Uint8Array([1, 1, 1]), { mediaType: "image/png" });
    await store.put("k", new Uint8Array([2]), { mediaType: "image/jpeg" });
    expect(await store.head("k")).toEqual({ key: "k", sizeBytes: 1, mediaType: "image/jpeg" });
  });

  it("rejects static symlink escapes for byte and sidecar operations", async () => {
    const outside = await mkdtemp(join(tmpdir(), "mirk-fs-outside-"));
    const outsideBytes = join(outside, "escaped.bin");
    const outsideSidecar = join(outside, "escaped.sidecar.json");
    await writeFile(outsideBytes, new Uint8Array([7, 7]));
    await writeFile(outsideSidecar, '{"key":"escaped","sizeBytes":2}');
    await symlink(outside, join(root, "link"), "dir");
    try {
      for (const operation of [
        () => store.put("link/escaped", new Uint8Array([1]), { ifAbsent: true }),
        () => store.get("link/escaped"),
        () => store.head("link/escaped"),
        () => store.delete("link/escaped"),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: "object-key-escapes-root",
        });
      }
      expect([...await readFile(outsideBytes)]).toEqual([7, 7]);
      expect(await readFile(outsideSidecar, "utf8")).toBe(
        '{"key":"escaped","sizeBytes":2}'
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow final byte or sidecar symlinks", async () => {
    const outside = await mkdtemp(join(tmpdir(), "mirk-fs-final-outside-"));
    const outsideBytes = join(outside, "bytes");
    const outsideSidecar = join(outside, "sidecar");
    await writeFile(outsideBytes, new Uint8Array([8]));
    await writeFile(outsideSidecar, '{"key":"final","sizeBytes":1}');
    await symlink(outsideBytes, join(root, "final.bin"));
    await symlink(outsideSidecar, join(root, "final.sidecar.json"));
    try {
      for (const operation of [
        () => store.put("final", new Uint8Array([1])),
        () => store.get("final"),
        () => store.head("final"),
        () => store.delete("final"),
      ]) {
        await expect(operation()).rejects.toMatchObject({
          code: "object-key-escapes-root",
        });
      }
      expect([...await readFile(outsideBytes)]).toEqual([8]);
      expect(await readFile(outsideSidecar, "utf8")).toBe(
        '{"key":"final","sizeBytes":1}'
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
