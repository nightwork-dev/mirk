import { describe, expect, it } from "vitest";
import { createNodeEngines } from "@surrealdb/node";
import { Surreal, createRemoteEngines } from "surrealdb";

import { ObjectAlreadyExistsError, type ByteStream, type ObjectInfo } from "@mirk/artifact";
import { SurrealConnection } from "./index.js";
import { SurrealObjectStore, type SurrealConnectionLike } from "./storage.js";

interface Upload {
  key: string;
  uploadToken: string;
  expiresAt: number;
  mediaType?: string;
  metadata?: Record<string, unknown>;
}

interface Pointer extends ObjectInfo {
  generationId: string;
}

class FakeSurrealConnection implements SurrealConnectionLike {
  readonly uploads = new Map<string, Upload>();
  readonly chunks = new Map<string, Map<number, Uint8Array>>();
  readonly pointers = new Map<string, Pointer>();
  queryLog: string[] = [];

  async query<T>(surql: string, bindings: Record<string, unknown> = {}): Promise<T> {
    this.queryLog.push(surql);
    if (surql.startsWith("DEFINE TABLE")) return undefined as T;
    if (surql.startsWith("CREATE type::record($uploadTable")) {
        this.uploads.set(requiredString(bindings.generationId), {
          key: requiredString(bindings.key),
          uploadToken: requiredString(bindings.uploadToken),
          expiresAt: requiredNumber(bindings.expiresAt),
          ...(typeof bindings.mediaType === "string" ? { mediaType: bindings.mediaType } : {}),
          ...(bindings.metadata ? { metadata: bindings.metadata as Record<string, unknown> } : {}),
        });
        this.chunks.set(requiredString(bindings.generationId), new Map());
        return undefined as T;
    }
    if (surql.startsWith("SELECT generationId FROM type::record($uploadTable")) return [[...(this.ownedUpload(bindings) ? [{ generationId: requiredString(bindings.generationId) }] : [])]] as T;
    if (surql.startsWith("UPDATE type::record($uploadTable")) {
      const upload = this.ownedUpload(bindings);
      if (upload) upload.expiresAt = requiredNumber(bindings.expiresAt);
      return [[]] as T;
    }
    if (surql.startsWith("UPSERT type::record($chunkTable")) {
      const upload = this.ownedUpload(bindings);
      if (!upload) throw new Error("upload lease is no longer owned");
      this.chunks.get(requiredString(bindings.generationId))?.set(requiredNumber(bindings.index), (bindings.bytes as Uint8Array).slice());
      return [[]] as T;
    }
    if (surql.startsWith("SELECT key, generationId, uploadToken")) return [[...(this.ownedUpload(bindings) ? [this.ownedUpload(bindings)] : [])]] as T;
    if (surql.startsWith("SELECT index, bytes FROM type::table($chunkTable")) {
      const chunks = [...(this.chunks.get(requiredString(bindings.generationId)) ?? new Map()).entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, bytes]) => ({ index, bytes: bytes.slice() }));
      return [chunks] as T;
    }
    if (surql.startsWith("SELECT generationId FROM type::record($pointerTable")) {
      const pointer = this.pointers.get(requiredString(bindings.key));
      return [[...(pointer ? [{ generationId: pointer.generationId }] : [])]] as T;
    }
    if (surql.startsWith("UPSERT type::record($generationTable")) return [[]] as T;
    if (surql.startsWith("UPSERT type::record($pointerTable")) {
      this.pointers.set(requiredString(bindings.key), {
        key: requiredString(bindings.key),
        generationId: requiredString(bindings.generationId),
        sizeBytes: requiredNumber(bindings.sizeBytes),
        ...(typeof bindings.mediaType === "string" ? { mediaType: bindings.mediaType } : {}),
        ...(bindings.metadata ? { metadata: bindings.metadata as ObjectInfo["metadata"] } : {}),
      });
      return [[]] as T;
    }
    if (surql === "DELETE type::record($uploadTable, $generationId)") {
      this.uploads.delete(requiredString(bindings.generationId));
      return [[]] as T;
    }
    if (surql.startsWith("SELECT key, generationId, sizeBytes")) {
      const pointer = this.pointers.get(requiredString(bindings.key));
      return [[...(pointer ? [cloneInfo(pointer)] : [])]] as T;
    }
    if (surql.startsWith("DELETE type::record($pointerTable")) {
      const key = requiredString(bindings.key);
      const pointer = this.pointers.get(key);
      if (pointer) this.pointers.delete(key);
      return [[...(pointer ? [pointer] : [])]] as T;
    }
    if (surql.startsWith("SELECT VALUE key FROM type::table($pointerTable")) return [[...[...this.pointers.values()].filter((pointer) => pointer.generationId === bindings.generationId).map((pointer) => pointer.key).slice(0, 1)]] as T;
    if (surql === "DELETE type::record($generationTable, $generationId)") return [[]] as T;
    if (surql === "DELETE type::table($chunkTable) WHERE generationId = $generationId") {
      if (![...this.pointers.values()].some((pointer) => pointer.generationId === bindings.generationId)) this.chunks.delete(requiredString(bindings.generationId));
      return [[]] as T;
    }
    if (surql.startsWith("DELETE type::record($uploadTable") && surql.includes("WHERE uploadToken")) {
      const generationId = requiredString(bindings.generationId);
      const upload = this.ownedUpload(bindings);
      if (upload) this.uploads.delete(generationId);
      return [[...(upload ? [upload] : [])]] as T;
    }
    if (surql.startsWith("SELECT VALUE generationId FROM type::table($uploadTable")) {
      const now = requiredNumber(bindings.now);
      const limit = requiredNumber(bindings.limit);
      const expired = [...this.uploads.entries()]
        .filter(([, upload]) => upload.expiresAt < now)
        .slice(0, limit)
        .map(([generationId]) => generationId);
      return [expired] as T;
    }
    throw new Error(`unexpected query: ${surql}`);
  }

  private ownedUpload(bindings: Record<string, unknown>): Upload | undefined {
    const upload = this.uploads.get(requiredString(bindings.generationId));
    return upload?.uploadToken === bindings.uploadToken ? upload : undefined;
  }
}

async function drain(stream: ByteStream | undefined): Promise<Uint8Array> {
  if (!stream) throw new Error("expected stream");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe("SurrealObjectStore", () => {
  it("stores and reads chunked immutable generations through a shared connection", async () => {
    const connection = new FakeSurrealConnection();
    const store = await SurrealObjectStore.open(connection, { chunkSizeBytes: 2, idFactory: ids("g1"), tokenFactory: ids("t1") });

    const info = await store.put("images/a", new Uint8Array([1, 2, 3, 4, 5]), { mediaType: "image/png", metadata: { source: "test" } });

    expect(info).toEqual({ key: "images/a", sizeBytes: 5, mediaType: "image/png", metadata: { source: "test" } });
    expect(connection.chunks.get("g1")?.size).toBe(3);
    expect(await drain(await store.get("images/a"))).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(await store.head("images/a")).toEqual(info);
  });

  it("enforces atomic ifAbsent so concurrent writes have one winner", async () => {
    const connection = new FakeSurrealConnection();
    const store = await SurrealObjectStore.open(connection, { chunkSizeBytes: 2, idFactory: ids("g1", "g2"), tokenFactory: ids("t1", "t2") });

    const writes = await Promise.allSettled([
      store.put("once", new Uint8Array([1]), { ifAbsent: true }),
      store.put("once", new Uint8Array([2]), { ifAbsent: true }),
    ]);

    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = writes.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(ObjectAlreadyExistsError);
    expect(await drain(await store.get("once"))).toEqual(new Uint8Array([1]));
  });

  it("keeps a reader on the generation captured before overwrite", async () => {
    const connection = new FakeSurrealConnection();
    const store = await SurrealObjectStore.open(connection, { chunkSizeBytes: 1, idFactory: ids("old", "new"), tokenFactory: ids("t1", "t2") });
    await store.put("k", new Uint8Array([1, 2, 3]));

    const oldRead = await store.get("k");
    await store.put("k", new Uint8Array([9]));

    expect(await drain(oldRead)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await drain(await store.get("k"))).toEqual(new Uint8Array([9]));
    expect(connection.chunks.has("new")).toBe(true);
  });

  it("cleans failed streaming uploads in-process without publishing a pointer", async () => {
    const connection = new FakeSurrealConnection();
    const store = await SurrealObjectStore.open(connection, { chunkSizeBytes: 1, idFactory: ids("g1"), tokenFactory: ids("t1") });

    await expect(store.put("k", failingSource())).rejects.toThrow(/source failed/);

    expect(await store.head("k")).toBeUndefined();
    expect(connection.uploads.has("g1")).toBe(false);
    expect(connection.chunks.has("g1")).toBe(false);
  });

  it("scavenges only expired uploads and leaves current finalized generations intact", async () => {
    let now = 10;
    const connection = new FakeSurrealConnection();
    const store = await SurrealObjectStore.open(connection, { now: () => now, leaseMs: 5, idFactory: ids("current"), tokenFactory: ids("token") });
    await store.put("k", new Uint8Array([1]));
    connection.uploads.set("expired", { key: "stale", uploadToken: "lost", expiresAt: 1 });
    connection.chunks.set("expired", new Map([[0, new Uint8Array([8])]]));

    now = 20;
    expect(await store.scavengeExpiredUploads()).toBe(1);

    expect(connection.chunks.has("expired")).toBe(false);
    expect(connection.chunks.has("current")).toBe(true);
    expect(await drain(await store.get("k"))).toEqual(new Uint8Array([1]));
  });

  it("renews a slow owned upload before scavenging can reclaim it", async () => {
    let now = 0;
    const connection = new FakeSurrealConnection();
    const store = await SurrealObjectStore.open(connection, {
      now: () => now,
      leaseMs: 5,
      renewEveryMs: 3,
      chunkSizeBytes: 1,
      idFactory: ids("g1"),
      tokenFactory: ids("t1"),
    });

    async function* slow(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1]);
      now = 4;
      yield new Uint8Array([2]);
      now = 6;
      await store.scavengeExpiredUploads();
      yield new Uint8Array([3]);
    }

    await store.put("slow", slow());
    expect(await drain(await store.get("slow"))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("deletes the pointer atomically and does not reclaim a new current generation", async () => {
    const connection = new FakeSurrealConnection();
    const store = await SurrealObjectStore.open(connection, { idFactory: ids("g1", "g2"), tokenFactory: ids("t1", "t2") });
    await store.put("k", new Uint8Array([1]));
    await store.put("k", new Uint8Array([2]));

    expect(connection.chunks.has("g1")).toBe(false);
    expect(connection.chunks.has("g2")).toBe(true);
    expect(await store.delete("k")).toBe(true);
    expect(await store.head("k")).toBeUndefined();
    expect(connection.chunks.has("g2")).toBe(false);
  });

  it("round-trips bytes through embedded SurrealDB", async () => {
    const client = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
    const connection = await SurrealConnection.open({
      client,
      endpoint: "mem://",
      namespace: "mirk",
      database: `storage_${Date.now()}`,
    });
    try {
      const store = await SurrealObjectStore.open(connection, { chunkSizeBytes: 2 });
      const info = await store.put("real/k", new Uint8Array([4, 5, 6]), { mediaType: "application/octet-stream" });
      expect(info).toEqual({ key: "real/k", sizeBytes: 3, mediaType: "application/octet-stream" });
      expect(await drain(await store.get("real/k"))).toEqual(new Uint8Array([4, 5, 6]));
      expect(await store.delete("real/k")).toBe(true);
      expect(await store.head("real/k")).toBeUndefined();
    } finally {
      await connection.close();
      await client.close();
    }
  });
});

async function* failingSource(): AsyncIterable<Uint8Array> {
  yield new Uint8Array([1]);
  throw new Error("source failed");
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected string binding");
  return value;
}

function requiredNumber(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("expected number binding");
  return value;
}

function cloneInfo<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
