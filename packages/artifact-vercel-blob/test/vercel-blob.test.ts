import { BlobNotFoundError, BlobPreconditionFailedError } from "@vercel/blob";
import {
  ArtifactCoordinator,
  ArtifactWriteError,
  InMemoryArtifactRepository,
  ObjectWriteIndeterminateError,
} from "@mirk/artifact";
import { describe, expect, it } from "vitest";

import { drain, objectStoreConformance } from "../../artifact/test/object-store-conformance.js";
import { VercelBlobObjectStore, type VercelBlobSdk } from "../src/index.js";

interface StoredBlob {
  bytes: Uint8Array;
  contentType: string;
  etag: string;
}

/** An in-process stand-in with the SDK's private-object semantics: put refuses
 *  an existing path unless allowOverwrite, head throws BlobNotFoundError, and
 *  del honors ifMatch. */
function fakeSdk() {
  const objects = new Map<string, StoredBlob>();
  const calls: { operation: string; options: Record<string, unknown> }[] = [];
  let revision = 0;
  const sdk = {
    async put(key: string, source: ReadableStream<Uint8Array>, options: Record<string, unknown>) {
      calls.push({ operation: "put", options });
      const reader = source.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        parts.push(next.value);
        size += next.value.byteLength;
      }
      reader.releaseLock();
      if (objects.has(key) && !options.allowOverwrite) throw new Error("This blob already exists");
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      const contentType = (options.contentType as string | undefined) ?? "application/octet-stream";
      const etag = String(++revision);
      objects.set(key, { bytes, contentType, etag });
      return { pathname: key, contentType, etag, url: `https://private.invalid/${key}`, downloadUrl: `https://private.invalid/${key}` };
    },
    async head(key: string, options: Record<string, unknown>) {
      calls.push({ operation: "head", options });
      const row = objects.get(key);
      if (!row) throw new BlobNotFoundError();
      return {
        pathname: key,
        contentType: row.contentType,
        etag: row.etag,
        size: row.bytes.byteLength,
        uploadedAt: new Date(0),
        url: `https://private.invalid/${key}`,
        downloadUrl: `https://private.invalid/${key}`,
        contentDisposition: "attachment",
        cacheControl: "private",
      };
    },
    async get(key: string, options: Record<string, unknown>) {
      calls.push({ operation: "get", options });
      const row = objects.get(key);
      if (!row) return null;
      return {
        statusCode: 200,
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(row.bytes);
            controller.close();
          },
        }),
        blob: { pathname: key, contentType: row.contentType, size: row.bytes.byteLength, etag: row.etag },
        headers: new Headers(),
      };
    },
    async del(key: string, options: Record<string, unknown>) {
      calls.push({ operation: "del", options });
      if (options.ifMatch && objects.get(key)?.etag !== options.ifMatch) {
        throw new BlobPreconditionFailedError();
      }
      objects.delete(key);
    },
  };
  return { sdk: sdk as unknown as VercelBlobSdk, raw: sdk, calls, objects };
}

objectStoreConformance("VercelBlobObjectStore", {
  createStore: () => new VercelBlobObjectStore({ sdk: fakeSdk().sdk }),
  supportsMetadata: false,
});

describe("VercelBlobObjectStore", () => {
  it("uses private objects at deterministic keys, reads from origin, and never returns URLs", async () => {
    const fixture = fakeSdk();
    const store = new VercelBlobObjectStore({ sdk: fixture.sdk, token: "token", storeId: "store" });
    const info = await store.put("a", new Uint8Array([1]), { ifAbsent: true });
    expect(info).not.toHaveProperty("url");
    expect(fixture.calls.find((call) => call.operation === "put")?.options).toMatchObject({
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      token: "token",
      storeId: "store",
    });
    await store.get("a");
    expect(fixture.calls.find((call) => call.operation === "get")?.options).toMatchObject({
      access: "private",
      useCache: false,
    });
    await expect(store.put("meta", new Uint8Array(), { metadata: { unsupported: "yes" } })).rejects.toThrow(
      "metadata",
    );
  });

  it("keeps a remote object whose upload landed but whose reply was lost", async () => {
    const fixture = fakeSdk();
    const put = fixture.raw.put;
    fixture.raw.put = async (...args) => {
      await put(...args);
      throw new Error("reply lost");
    };
    const coordinator = new ArtifactCoordinator(
      new VercelBlobObjectStore({ sdk: fixture.sdk }),
      new InMemoryArtifactRepository(),
      { idFactory: () => "lost-reply" },
    );
    const failure = await coordinator
      .write({ mediaType: "application/octet-stream", bytes: new Uint8Array([4, 5]) })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ArtifactWriteError);
    expect((failure as ArtifactWriteError).cleanup).toBe("preserved-indeterminate");
    expect(fixture.objects.size).toBe(1);
    expect(fixture.calls.some((call) => call.operation === "del")).toBe(false);
  });

  it("keeps the winner when another writer creates the key after the preflight check", async () => {
    const fixture = fakeSdk();
    const put = fixture.raw.put;
    fixture.raw.put = async (key, source, options) => {
      fixture.objects.set(key, { bytes: new Uint8Array([9]), contentType: "application/octet-stream", etag: "winner" });
      return put(key, source, options);
    };
    const store = new VercelBlobObjectStore({ sdk: fixture.sdk });
    const coordinator = new ArtifactCoordinator(store, new InMemoryArtifactRepository(), { idFactory: () => "race" });
    await expect(
      coordinator.write({ mediaType: "application/octet-stream", bytes: new Uint8Array([1]) }),
    ).rejects.toMatchObject({
      cleanup: "preserved-indeterminate",
      cause: expect.any(ObjectWriteIndeterminateError),
    });
    expect(await drain(await store.get("artifacts/race"))).toEqual(new Uint8Array([9]));
    expect(fixture.calls.some((call) => call.operation === "del")).toBe(false);
  });

  it("bounds the upload and reports the remote outcome as indeterminate", async () => {
    const fixture = fakeSdk();
    const store = new VercelBlobObjectStore({ sdk: fixture.sdk, maxBytes: 2 });
    await expect(store.put("too-large", new Uint8Array([1, 2, 3]))).rejects.toBeInstanceOf(
      ObjectWriteIndeterminateError,
    );
    expect(fixture.objects.size).toBe(0);
  });

  it("deletes only the version it observed", async () => {
    const fixture = fakeSdk();
    const store = new VercelBlobObjectStore({ sdk: fixture.sdk });
    await store.put("k", new Uint8Array([1]));
    const head = fixture.raw.head;
    fixture.raw.head = async (key, options) => {
      const seen = await head(key, options);
      fixture.objects.set(key, { bytes: new Uint8Array([2]), contentType: "application/octet-stream", etag: "newer" });
      return seen;
    };
    await expect(store.delete("k")).rejects.toBeInstanceOf(BlobPreconditionFailedError);
    expect(fixture.objects.get("k")?.etag).toBe("newer");
  });

  it("rejects a non-positive byte limit", () => {
    expect(() => new VercelBlobObjectStore({ maxBytes: 0 })).toThrow(RangeError);
  });
});
