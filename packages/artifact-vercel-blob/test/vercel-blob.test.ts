import { BlobAccessError, BlobError, BlobNotFoundError, BlobPreconditionFailedError } from "@vercel/blob";
import {
  ArtifactCoordinator,
  ArtifactWriteError,
  InMemoryArtifactRepository,
  ObjectAlreadyExistsError,
  ObjectWriteIndeterminateError,
  ObjectWriteRejectedError,
} from "@mirk/artifact";
import { ArtifactMaintenance } from "@mirk/artifact/maintenance";
import { describe, expect, it } from "vitest";

import { drain, objectStoreConformance } from "../../artifact/test/object-store-conformance.js";
import { VercelBlobObjectStore, VercelBlobObjectStoreError, type VercelBlobSdk } from "../src/index.js";

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
      if (objects.has(key) && !options.allowOverwrite) {
        throw new BlobError("This blob already exists, use `allowOverwrite: true` if you want to overwrite it.");
      }
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
      const row = objects.get(key);
      if (options.ifMatch && !row) throw new BlobNotFoundError();
      if (options.ifMatch && row?.etag !== options.ifMatch) throw new BlobPreconditionFailedError();
      objects.delete(key);
    },
    async list(options: { prefix?: string; cursor?: string; limit?: number }) {
      calls.push({ operation: "list", options });
      const keys = [...objects.keys()].filter((key) => key.startsWith(options.prefix ?? "")).sort();
      const start = Number(options.cursor ?? 0);
      const limit = options.limit ?? 1000;
      const page = keys.slice(start, start + limit);
      const more = start + limit < keys.length;
      return {
        blobs: page.map((key) => ({
          pathname: key,
          size: objects.get(key)!.bytes.byteLength,
          uploadedAt: new Date(0),
          etag: objects.get(key)!.etag,
          url: `https://private.invalid/${key}`,
          downloadUrl: `https://private.invalid/${key}`,
        })),
        hasMore: more,
        ...(more ? { cursor: String(start + limit) } : {}),
      };
    },
  };
  return { sdk: sdk as unknown as VercelBlobSdk, raw: sdk, calls, objects };
}

const ROOT = "mirk-artifacts";

objectStoreConformance("VercelBlobObjectStore", {
  createStore: () => new VercelBlobObjectStore({ root: ROOT, sdk: fakeSdk().sdk }),
  supportsMetadata: false,
});

describe("VercelBlobObjectStore", () => {
  it("uses private objects at deterministic keys, reads from origin, and never returns URLs", async () => {
    const fixture = fakeSdk();
    const store = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk, token: "token", storeId: "store" });
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
      new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk }),
      new InMemoryArtifactRepository(),
      { idFactory: () => "lost-reply" },
    );
    const failure = await coordinator
      .write({ mediaType: "application/octet-stream", bytes: new Uint8Array([4, 5]) })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ArtifactWriteError);
    expect((failure as ArtifactWriteError).cleanup).toBe("preserved-indeterminate");
    expect((failure as ArtifactWriteError).cause).toBeInstanceOf(ObjectWriteIndeterminateError);
    expect(fixture.objects.size).toBe(1);
    expect(fixture.calls.some((call) => call.operation === "del")).toBe(false);
  });

  it("reports a lost ifAbsent race as the existing object and keeps the winner", async () => {
    const fixture = fakeSdk();
    const put = fixture.raw.put;
    fixture.raw.put = async (key, source, options) => {
      fixture.objects.set(key, { bytes: new Uint8Array([9]), contentType: "application/octet-stream", etag: "winner" });
      return put(key, source, options);
    };
    const store = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk });
    const coordinator = new ArtifactCoordinator(store, new InMemoryArtifactRepository(), { idFactory: () => "race" });
    await expect(
      coordinator.write({ mediaType: "application/octet-stream", bytes: new Uint8Array([1]) }),
    ).rejects.toMatchObject({
      cleanup: "not-needed",
      cause: expect.any(ObjectAlreadyExistsError),
    });
    expect(await drain(await store.get("artifacts/race"))).toEqual(new Uint8Array([9]));
    expect(fixture.calls.some((call) => call.operation === "del")).toBe(false);
  });

  it("reports a source over the byte limit as a write that stored nothing", async () => {
    const fixture = fakeSdk();
    const store = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk, maxBytes: 2 });
    const failure = await store.put("too-large", new Uint8Array([1, 2, 3])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ObjectWriteRejectedError);
    expect((failure as Error).cause).toBeInstanceOf(RangeError);
    expect(fixture.objects.size).toBe(0);
  });

  it("reports a request the service refused as itself", async () => {
    const fixture = fakeSdk();
    fixture.raw.put = async () => {
      throw new BlobAccessError();
    };
    const store = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk });
    const failure = await store.put("refused", new Uint8Array([1])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ObjectWriteRejectedError);
    expect((failure as Error).cause).toBeInstanceOf(BlobAccessError);
  });

  it("returns false to the loser of a delete race", async () => {
    const fixture = fakeSdk();
    const store = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk });
    await store.put("k", new Uint8Array([1]));
    expect((await Promise.all([store.delete("k"), store.delete("k")])).sort()).toEqual([false, true]);
    expect(fixture.objects.has(`${ROOT}/k`)).toBe(false);
  });

  it("deletes only the version it observed and returns false after a concurrent overwrite", async () => {
    const fixture = fakeSdk();
    const store = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk });
    await store.put("k", new Uint8Array([1]));
    const head = fixture.raw.head;
    fixture.raw.head = async (key, options) => {
      const seen = await head(key, options);
      fixture.objects.set(key, { bytes: new Uint8Array([2]), contentType: "application/octet-stream", etag: "newer" });
      return seen;
    };
    expect(await store.delete("k")).toBe(false);
    expect(fixture.objects.get(`${ROOT}/k`)?.etag).toBe("newer");
  });

  it("refuses to delete an object it cannot pin to a version", async () => {
    const fixture = fakeSdk();
    const store = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk });
    await store.put("k", new Uint8Array([1]));
    const head = fixture.raw.head;
    fixture.raw.head = async (key, options) => ({ ...(await head(key, options)), etag: "" });
    const refusal = await store.delete("k").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(VercelBlobObjectStoreError);
    expect(refusal).toMatchObject({ code: "missing-etag" });
    expect(fixture.objects.has(`${ROOT}/k`)).toBe(true);
    expect(fixture.calls.some((call) => call.operation === "del")).toBe(false);
  });

  it("lists objects by prefix across pages, in key order", async () => {
    const fixture = fakeSdk();
    const store = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk, listPageSize: 2 });
    for (const key of ["b/2", "a/1", "b/1", "b/3"]) await store.put(key, new Uint8Array([1]));
    expect((await store.list("b/")).map((info) => info.key)).toEqual(["b/1", "b/2", "b/3"]);
    expect((await store.list()).map((info) => info.key)).toEqual(["a/1", "b/1", "b/2", "b/3"]);
  });

  it("lets maintenance find and remove the object an indeterminate write kept", async () => {
    const fixture = fakeSdk();
    const put = fixture.raw.put;
    fixture.raw.put = async (...args) => {
      await put(...args);
      throw new Error("reply lost");
    };
    const objects = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk });
    const repository = new InMemoryArtifactRepository();
    const coordinator = new ArtifactCoordinator(objects, repository, { idFactory: () => "orphan" });
    await expect(
      coordinator.write({ mediaType: "application/octet-stream", bytes: new Uint8Array([7]) }),
    ).rejects.toMatchObject({ cleanup: "preserved-indeterminate" });
    fixture.raw.put = put;

    const maintenance = new ArtifactMaintenance(objects, repository);
    const report = await maintenance.audit();
    expect(report.coverage).toBe("complete");
    expect(report.findings.map((finding) => finding.code)).toEqual(["object-without-record"]);
    const plan = await maintenance.planRepair(report);
    expect(plan.actions.map((action) => action.operation)).toEqual(["delete-unreferenced-object"]);
    expect((await maintenance.applyRepair(plan)).map((result) => result.status)).toEqual(["applied"]);
    expect(fixture.objects.size).toBe(0);
  });

  for (const [label, fail] of [
    ["an over-limit upload", "limit"],
    ["a refused upload", "refused"],
  ] as const) {
    it(`never deletes a concurrent writer's object after ${label}`, async () => {
      const fixture = fakeSdk();
      const put = fixture.raw.put;
      fixture.raw.put = async (key, source, options) => {
        // Another writer with the same deterministic id lands first.
        fixture.objects.set(key, { bytes: new Uint8Array([9]), contentType: "application/octet-stream", etag: "winner" });
        if (fail === "refused") throw new BlobAccessError();
        return put(key, source, { ...options, allowOverwrite: true });
      };
      const store = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk, maxBytes: 2 });
      const coordinator = new ArtifactCoordinator(store, new InMemoryArtifactRepository(), { idFactory: () => "same" });
      await expect(
        coordinator.write({ mediaType: "application/octet-stream", bytes: new Uint8Array([1, 2, 3]) }),
      ).rejects.toMatchObject({ cleanup: "not-needed" });
      expect(fixture.objects.get(`${ROOT}/artifacts/same`)?.etag).toBe("winner");
      expect(fixture.calls.some((call) => call.operation === "del")).toBe(false);
    });
  }

  it("keeps every key under its root and never lists or repairs outside it", async () => {
    const fixture = fakeSdk();
    const outside = ["other-app/upload", "mirk-artifacts-old/x", "artifacts/at-bucket-root"];
    for (const key of outside) {
      fixture.objects.set(key, { bytes: new Uint8Array([1]), contentType: "application/octet-stream", etag: "x" });
    }
    const objects = new VercelBlobObjectStore({ root: ROOT, sdk: fixture.sdk });
    await objects.put("artifacts/orphan", new Uint8Array([2]));
    await objects.put("imports/elsewhere", new Uint8Array([3]));
    expect(fixture.objects.has(`${ROOT}/artifacts/orphan`)).toBe(true);
    expect((await objects.list()).map((info) => info.key)).toEqual(["artifacts/orphan", "imports/elsewhere"]);
    expect(await objects.head("other-app/upload")).toBeUndefined();

    const maintenance = new ArtifactMaintenance(objects, new InMemoryArtifactRepository(), { namespace: "artifacts" });
    const plan = await maintenance.planRepair(await maintenance.audit());
    expect(plan.actions.map((action) => action.operation)).toEqual(["delete-unreferenced-object"]);
    await maintenance.applyRepair(plan);
    expect(fixture.objects.has(`${ROOT}/artifacts/orphan`)).toBe(false);
    expect(fixture.objects.has(`${ROOT}/imports/elsewhere`)).toBe(true);
    for (const key of outside) expect(fixture.objects.has(key)).toBe(true);
  });

  it("requires a valid root", () => {
    expect(() => new VercelBlobObjectStore({} as never)).toThrow();
    expect(() => new VercelBlobObjectStore({ root: "" })).toThrow();
    expect(() => new VercelBlobObjectStore({ root: "../escape" })).toThrow();
  });

  it("rejects a non-positive byte limit", () => {
    expect(() => new VercelBlobObjectStore({ root: ROOT, maxBytes: 0 })).toThrow(RangeError);
  });
});
