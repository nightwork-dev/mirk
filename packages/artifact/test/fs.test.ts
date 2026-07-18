import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileObjectStore } from "../src/fs.js";
import { ObjectAlreadyExistsError } from "../src/memory.js";
import type { ByteStream } from "../src/types.js";

async function drain(stream: ByteStream | undefined): Promise<Uint8Array> {
  if (!stream) throw new Error("expected a byte stream");
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    parts.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

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

  it("round-trips bytes, size, and mediaType through real disk", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const info = await store.put("images/abc", bytes, { mediaType: "image/png" });
    expect(info).toEqual({ key: "images/abc", sizeBytes: 5, mediaType: "image/png" });

    expect(await drain(await store.get("images/abc"))).toEqual(bytes);
    expect(await store.head("images/abc")).toEqual(info);
  });

  it("persists across store instances (durable, not in-memory)", async () => {
    await store.put("k", new Uint8Array([9, 9]), { mediaType: "application/octet-stream" });
    const reopened = new FileObjectStore({ root });
    expect(await drain(await reopened.get("k"))).toEqual(new Uint8Array([9, 9]));
    expect((await reopened.head("k"))?.mediaType).toBe("application/octet-stream");
  });

  it("accepts an async-iterable byte source and counts total size", async () => {
    async function* source(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      yield new Uint8Array([4, 5]);
    }
    const info = await store.put("stream", source());
    expect(info.sizeBytes).toBe(5);
    expect(await drain(await store.get("stream"))).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("stores metadata and returns it from head", async () => {
    await store.put("m", new Uint8Array([0]), { metadata: { origin: "codex", prompt: "a cat" } });
    expect((await store.head("m"))?.metadata).toEqual({ origin: "codex", prompt: "a cat" });
  });

  it("enforces ifAbsent with an atomic exclusive create", async () => {
    await store.put("once", new Uint8Array([1]), { ifAbsent: true });
    await expect(store.put("once", new Uint8Array([2]), { ifAbsent: true })).rejects.toBeInstanceOf(
      ObjectAlreadyExistsError,
    );
    // Original bytes untouched by the rejected write.
    expect(await drain(await store.get("once"))).toEqual(new Uint8Array([1]));
  });

  it("overwrites when ifAbsent is not set", async () => {
    await store.put("k", new Uint8Array([1, 1, 1]));
    const info = await store.put("k", new Uint8Array([2]));
    expect(info.sizeBytes).toBe(1);
    expect(await drain(await store.get("k"))).toEqual(new Uint8Array([2]));
  });

  it("returns undefined / false for missing objects", async () => {
    expect(await store.get("nope")).toBeUndefined();
    expect(await store.head("nope")).toBeUndefined();
    expect(await store.delete("nope")).toBe(false);
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

  it("refuses keys that would escape the store root", async () => {
    // assertObjectKey rejects `..` segments before the path guard is reached.
    await expect(store.put("../escape", new Uint8Array([1]))).rejects.toThrow(/invalid object key/);
  });
});
