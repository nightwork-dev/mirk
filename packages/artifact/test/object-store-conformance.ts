import { describe, expect, it } from "vitest";

import type { ByteStream, ObjectStore } from "../src/types.js";

export interface ObjectStoreConformanceOptions {
  createStore: () => Promise<ObjectStore> | ObjectStore;
  supportsIfAbsent?: boolean;
  supportsMetadata?: boolean;
  supportsMediaType?: boolean;
}

export async function drain(stream: ByteStream | undefined): Promise<Uint8Array> {
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

export function objectStoreConformance(name: string, options: ObjectStoreConformanceOptions): void {
  const supportsIfAbsent = options.supportsIfAbsent ?? true;
  const supportsMetadata = options.supportsMetadata ?? true;
  const supportsMediaType = options.supportsMediaType ?? true;

  describe(`${name} ObjectStore conformance`, () => {
    it("round-trips bytes, size, mediaType, and metadata", async () => {
      const store = await options.createStore();
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      const info = await store.put("images/abc", bytes, {
        ...(supportsMediaType ? { mediaType: "image/png" } : {}),
        ...(supportsMetadata ? { metadata: { origin: "generator", prompt: "object-store" } } : {}),
      });

      expect(info).toMatchObject({
        key: "images/abc",
        sizeBytes: 5,
        ...(supportsMediaType ? { mediaType: "image/png" } : {}),
        ...(supportsMetadata ? { metadata: { origin: "generator", prompt: "object-store" } } : {}),
      });
      expect(await drain(await store.get("images/abc"))).toEqual(bytes);
      expect(await store.head("images/abc")).toMatchObject(info);
    });

    it("accepts an async-iterable byte source and counts total size", async () => {
      const store = await options.createStore();
      async function* source(): AsyncIterable<Uint8Array> {
        yield new Uint8Array([1, 2, 3]);
        yield new Uint8Array([4, 5]);
      }
      const info = await store.put("stream", source());
      expect(info.sizeBytes).toBe(5);
      expect(await drain(await store.get("stream"))).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it("overwrites when ifAbsent is not set", async () => {
      const store = await options.createStore();
      await store.put("k", new Uint8Array([1, 1, 1]));
      const info = await store.put("k", new Uint8Array([2]));
      expect(info.sizeBytes).toBe(1);
      expect(await drain(await store.get("k"))).toEqual(new Uint8Array([2]));
    });

    it("returns undefined / false for missing objects", async () => {
      const store = await options.createStore();
      expect(await store.get("nope")).toBeUndefined();
      expect(await store.head("nope")).toBeUndefined();
      expect(await store.delete("nope")).toBe(false);
    });

    it("deletes objects and reports whether an object existed", async () => {
      const store = await options.createStore();
      await store.put("images/x", new Uint8Array([7]), supportsMediaType ? { mediaType: "image/png" } : {});
      expect(await store.delete("images/x")).toBe(true);
      expect(await store.get("images/x")).toBeUndefined();
      expect(await store.head("images/x")).toBeUndefined();
      expect(await store.delete("images/x")).toBe(false);
    });

    it("refuses invalid object keys", async () => {
      const store = await options.createStore();
      await expect(store.put("../escape", new Uint8Array([1]))).rejects.toThrow(/invalid object key/);
    });

    if (supportsIfAbsent) {
      it("enforces ifAbsent without replacing existing bytes", async () => {
        const store = await options.createStore();
        await store.put("once", new Uint8Array([1]), { ifAbsent: true });
        await expect(store.put("once", new Uint8Array([2]), { ifAbsent: true })).rejects.toBeTruthy();
        expect(await drain(await store.get("once"))).toEqual(new Uint8Array([1]));
      });
    }
  });
}
