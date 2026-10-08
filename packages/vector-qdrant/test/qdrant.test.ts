import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantProtocolError, QdrantVectorStore, pointIdFor } from "../src/index.js";

const qdrantUrl = process.env.MIRK_QDRANT_URL;
const describeQdrant = qdrantUrl ? describe : describe.skip;

function vector(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

describeQdrant("QdrantVectorStore against the real service", () => {
  let client: QdrantClient;
  let physical: string;
  let store: QdrantVectorStore;

  beforeEach(async () => {
    client = new QdrantClient({ url: qdrantUrl, checkCompatibility: false });
    physical = `mirk_ts_${randomUUID().replaceAll("-", "")}`;
    store = await QdrantVectorStore.open(client, { collectionName: physical, dimensions: 3, pageSize: 1 });
  });

  afterEach(async () => {
    await client.deleteCollection(physical);
  });

  it("round-trips arbitrary ids, scopes counts, and reopens through another client", async () => {
    const loneSurrogate = "id-\ud800";
    await store.upsert("one", { id: loneSurrogate, vector: vector(1, 0, 0), metadata: { tag: "a" } });
    await store.upsert("two", { id: loneSurrogate, vector: vector(0, 1, 0) });
    expect(await store.count("one")).toBe(1);
    expect(await store.count("two")).toBe(1);
    expect(await store.count("missing")).toBe(0);
    expect((await store.get("one", loneSurrogate))?.id).toBe(loneSurrogate);
    expect(await store.has("two", loneSurrogate)).toBe(true);

    const reopened = await QdrantVectorStore.open(
      new QdrantClient({ url: qdrantUrl, checkCompatibility: false }),
      { collectionName: physical, dimensions: 3 },
    );
    expect(await reopened.has("one", loneSurrogate)).toBe(true);
  });

  it("uses exact metadata filters, including nested JSON, null, and missing fields", async () => {
    await store.upsertMany("docs", [
      { id: "match", vector: vector(1, 0, 0), metadata: { nested: { b: 2, a: 1 }, values: [null, true] } },
      { id: "different-order", vector: vector(1, 0, 0), metadata: { nested: { a: 1, b: 2 }, values: [null, true] } },
      { id: "null", vector: vector(1, 0, 0), metadata: { value: null } },
      { id: "missing", vector: vector(1, 0, 0) },
    ]);
    expect((await store.search("docs", vector(1, 0, 0), { where: { nested: { b: 2, a: 1 } } })).map((r) => r.id)).toEqual([
      "match",
    ]);
    expect((await store.search("docs", vector(1, 0, 0), { where: { value: null } })).map((r) => r.id)).toEqual([
      "null",
    ]);
    expect((await store.search("docs", vector(1, 0, 0), { where: {} })).map((r) => r.id)).toEqual([
      "different-order",
      "match",
      "null",
    ]);
    expect((await store.search("docs", vector(1, 0, 0), { whereNot: {} })).map((r) => r.id)).toEqual(["missing"]);
  });

  it("keeps raw float32 vectors, stores unusable values, and excludes them from search", async () => {
    await store.upsert("docs", { id: "finite", vector: vector(1e20, 1e-20, 0) });
    await store.upsert("docs", { id: "zero", vector: vector(0, 0, 0) });
    await store.upsert("docs", { id: "nan", vector: vector(Number.NaN, 0, 0) });
    await store.upsert("docs", { id: "infinity", vector: vector(Number.POSITIVE_INFINITY, 0, 0) });
    expect(Array.from((await store.get("docs", "nan"))!.vector)).toEqual([NaN, 0, 0]);
    expect((await store.search("docs", vector(1e20, 1e-20, 0), { minScore: -1 })).map((r) => r.id)).toEqual([
      "finite",
    ]);
    expect((await store.search("docs", vector(0, 0, 0))).map((r) => r.id)).toEqual(["finite"]);
  });

  it("derives filter terms from persisted JSON metadata", async () => {
    await store.upsert("docs", { id: "undefined", vector: vector(1, 0, 0), metadata: { value: undefined } });
    expect((await store.get("docs", "undefined"))?.metadata).toEqual({});
    expect((await store.search("docs", vector(1, 0, 0), { where: { value: null } })).map((r) => r.id)).toEqual([]);
  });

  it("completes native pages for ties beyond pageSize and keeps codepoint order", async () => {
    await store.upsertMany("ties", [
      { id: "c", vector: vector(1, 0, 0) },
      { id: "a", vector: vector(1, 0, 0) },
      { id: "b", vector: vector(1, 0, 0) },
      { id: "\u{10000}", vector: vector(1, 0, 0) },
      { id: "z", vector: vector(1, 0, 0) },
    ]);
    expect((await store.search("ties", vector(1, 0, 0), { topK: 3 })).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect((await store.search("ties", vector(0, 0, 0), { topK: 10 })).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "z",
      "\u{10000}",
    ]);
  });

  it("applies inclusive score thresholds after exact cosine recomputation", async () => {
    await store.upsert("docs", { id: "same", vector: vector(1, 0, 0) });
    await store.upsert("docs", { id: "orthogonal", vector: vector(0, 1, 0) });
    const exact = (await store.search("docs", vector(1, 0, 0)))[0]!.score;
    expect((await store.search("docs", vector(1, 0, 0), { minScore: exact })).map((r) => r.id)).toEqual(["same"]);
    expect((await store.search("docs", vector(1e20, 1e-20, 0), { minScore: 0.999 })).map((r) => r.id)).toEqual([
      "same",
    ]);
  });

  it("validates every upsert before mutation and makes empty batches no-op", async () => {
    await store.upsert("docs", { id: "existing", vector: vector(1, 0, 0) });
    await store.upsertMany("docs", []);
    await expect(store.upsertMany("docs", [
      { id: "valid", vector: vector(0, 1, 0) },
      { id: "bad", vector: vector(0, 1) },
    ])).rejects.toThrow(expect.objectContaining({ name: "VectorInputError" }));
    expect(await store.count("docs")).toBe(1);
    expect(await store.get("docs", "valid")).toBeNull();
  });

  it("surfaces protocol mismatches and transport failures", async () => {
    await client.upsert(physical, {
      wait: true,
      points: [{ id: pointIdFor("docs", "bad"), vector: [1, 0, 0], payload: { _mirk_collection: "\"other\"" } }],
    });
    await expect(store.get("docs", "bad")).rejects.toBeInstanceOf(QdrantProtocolError);

    const badClient = new QdrantClient({ url: "http://127.0.0.1:1", checkCompatibility: false });
    await expect(QdrantVectorStore.open(badClient, { collectionName: "transport_failure", dimensions: 3 })).rejects.toThrow();
  });

  it("rejects an existing non-float32 collection before creating indexes", async () => {
    const wrongPhysical = `mirk_ts_wrong_${randomUUID().replaceAll("-", "")}`;
    await client.createCollection(wrongPhysical, {
      vectors: { size: 3, distance: "Dot", datatype: "float16" },
    });
    try {
      await expect(QdrantVectorStore.open(client, { collectionName: wrongPhysical, dimensions: 3 })).rejects.toThrow(/datatype/);
      const info = await client.getCollection(wrongPhysical);
      expect(info.payload_schema._mirk_collection).toBeUndefined();
    } finally {
      await client.deleteCollection(wrongPhysical);
    }
  });

  it("rethrows an unrelated 409 from the real create call", async () => {
    const injectedPhysical = `mirk_ts_injected_${randomUUID().replaceAll("-", "")}`;
    const injectedClient = new QdrantClient({ url: qdrantUrl, checkCompatibility: false });
    const realCreate = injectedClient.createCollection.bind(injectedClient);
    const unrelated = Object.assign(new Error("unrelated 409 sentinel"), { status: 409 });
    injectedClient.createCollection = (async (...args: Parameters<QdrantClient["createCollection"]>) => {
      await realCreate(...args);
      throw unrelated;
    }) as QdrantClient["createCollection"];
    try {
      await expect(QdrantVectorStore.open(injectedClient, { collectionName: injectedPhysical, dimensions: 3 }))
        .rejects.toBe(unrelated);
    } finally {
      await injectedClient.deleteCollection(injectedPhysical);
    }
  });
});

describe("QdrantVectorStore configuration", () => {
  it("rejects invalid dimensions and page size before contacting Qdrant", async () => {
    const client = new QdrantClient({ url: qdrantUrl ?? "http://127.0.0.1:1", checkCompatibility: false });
    await expect(QdrantVectorStore.open(client, { collectionName: "invalid", dimensions: 0 })).rejects.toThrow(/positive integer/);
    await expect(QdrantVectorStore.open(client, { collectionName: "invalid", dimensions: 3, pageSize: 0 })).rejects.toThrow(/pageSize/);
  });
});
