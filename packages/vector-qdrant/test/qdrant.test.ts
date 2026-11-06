import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantProtocolError, QdrantVectorStore, pointIdFor, migrateLegacyQdrantVectors } from "../src/index.js";

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
    store = await QdrantVectorStore.open(client, { collectionName: physical,  pageSize: 1 });
    await store.ensureSpace("default", { dimensions: 3 });
  });

  afterEach(async () => {
    await client.deleteCollection(physical);
  });

  it("stores differently sized text/image spaces, replaces complete maps, and isolates namespaces", async () => {
    await store.ensureSpace("text", { dimensions: 2 });
    await store.ensureSpace("image", { dimensions: 4 });
    await store.upsert("assets", { id: "a", vectors: { text: vector(1, 0), image: vector(0, 1, 0, 0) } });
    await store.upsert("assets", { id: "b", vectors: { text: vector(0, 1) } });
    expect(await store.count("assets")).toBe(2);
    expect((await store.search("assets", { space: "image", vector: vector(0, 1, 0, 0) })).map((row) => row.id)).toEqual(["a"]);
    await expect(store.ensureSpace("text", { dimensions: 3 })).rejects.toMatchObject({ code: "space-definition-conflict" });
    await store.upsert("assets", { id: "a", vectors: { text: vector(1, 0) } });
    expect(await store.search("assets", { space: "image", vector: vector(0, 1, 0, 0) })).toEqual([]);
    const other = await QdrantVectorStore.open(client, { collectionName: physical, namespace: "other" });
    await other.ensureSpace("text", { dimensions: 5 });
    expect(await other.count("assets")).toBe(0);
    expect((await other.listSpaces()).map((space) => space.dimensions)).toEqual([5]);
  });

  it("resumes an interrupted legacy copy without exposing a partial destination", async () => {
    const source = physical + "_old";
    const target = physical + "_new";
    await client.createCollection(source, { vectors: { size: 2, distance: "Dot" } });
    try {
      await client.upsert(source, { wait: true, points: ["a", "b"].map((id) => ({ id: pointIdFor("docs", id), vector: [1, 0], payload: {
        _mirk_collection: JSON.stringify("docs"), _mirk_id: JSON.stringify(id), _mirk_vector: Buffer.from(new Float32Array([1, 0]).buffer).toString("base64"), _mirk_usable: true, _mirk_has_metadata: false, _mirk_terms: [],
      } })) });
      await expect(migrateLegacyQdrantVectors(client, { sourceCollectionName: source, collectionName: target, pageSize: 1, onProgress: () => { throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
      await expect(QdrantVectorStore.open(client, { collectionName: target })).rejects.toThrow("incomplete");
      const migrated = await migrateLegacyQdrantVectors(client, { sourceCollectionName: source, collectionName: target, pageSize: 1 });
      expect(await migrated.count("docs")).toBe(2);
      expect((await migrated.get("docs", "a"))!.vectors.default).toEqual(vector(1, 0));
      expect((await client.count(source, { exact: true })).count).toBe(2);
      expect((await migrateLegacyQdrantVectors(client, { sourceCollectionName: source, collectionName: target })).meta.backend).toBe("qdrant");
    } finally { await client.deleteCollection(source); await client.deleteCollection(target); }
  });

  it("round-trips arbitrary ids, scopes counts, and reopens through another client", async () => {
    const loneSurrogate = "id-\ud800";
    await store.upsert("one", { id: loneSurrogate, vectors: { default: vector(1, 0, 0) }, metadata: { tag: "a" } });
    await store.upsert("two", { id: loneSurrogate, vectors: { default: vector(0, 1, 0) } });
    expect(await store.count("one")).toBe(1);
    expect(await store.count("two")).toBe(1);
    expect(await store.count("missing")).toBe(0);
    expect((await store.get("one", loneSurrogate))?.id).toBe(loneSurrogate);
    expect(await store.has("two", loneSurrogate)).toBe(true);

    const reopened = await QdrantVectorStore.open(
      new QdrantClient({ url: qdrantUrl, checkCompatibility: false }),
      { collectionName: physical },
    );
    expect(await reopened.has("one", loneSurrogate)).toBe(true);
  });

  it("uses exact metadata filters, including nested JSON, null, and missing fields", async () => {
    await store.upsertMany("docs", [
      { id: "match", vectors: { default: vector(1, 0, 0) }, metadata: { nested: { b: 2, a: 1 }, values: [null, true] } },
      { id: "different-order", vectors: { default: vector(1, 0, 0) }, metadata: { nested: { a: 1, b: 2 }, values: [null, true] } },
      { id: "null", vectors: { default: vector(1, 0, 0) }, metadata: { value: null } },
      { id: "missing", vectors: { default: vector(1, 0, 0) } },
    ]);
    expect((await store.search("docs", { space: "default", vector: vector(1, 0, 0) }, { where: { nested: { b: 2, a: 1 } } })).map((r) => r.id)).toEqual([
      "match",
    ]);
    expect((await store.search("docs", { space: "default", vector: vector(1, 0, 0) }, { where: { value: null } })).map((r) => r.id)).toEqual([
      "null",
    ]);
    expect((await store.search("docs", { space: "default", vector: vector(1, 0, 0) }, { where: {} })).map((r) => r.id)).toEqual([
      "different-order",
      "match",
      "null",
    ]);
    expect((await store.search("docs", { space: "default", vector: vector(1, 0, 0) }, { whereNot: {} })).map((r) => r.id)).toEqual(["missing"]);
  });

  it("keeps raw float32 vectors, stores unusable values, and excludes them from search", async () => {
    await store.upsert("docs", { id: "finite", vectors: { default: vector(1e20, 1e-20, 0) } });
    await store.upsert("docs", { id: "zero", vectors: { default: vector(0, 0, 0) } });
    await store.upsert("docs", { id: "nan", vectors: { default: vector(Number.NaN, 0, 0) } });
    await store.upsert("docs", { id: "infinity", vectors: { default: vector(Number.POSITIVE_INFINITY, 0, 0) } });
    expect(Array.from((await store.get("docs", "nan"))!.vectors.default!)).toEqual([NaN, 0, 0]);
    expect((await store.search("docs", { space: "default", vector: vector(1e20, 1e-20, 0) }, { minScore: -1 })).map((r) => r.id)).toEqual([
      "finite",
    ]);
    expect((await store.search("docs", { space: "default", vector: vector(0, 0, 0) })).map((r) => r.id)).toEqual(["finite"]);
  });

  it("derives filter terms from persisted JSON metadata", async () => {
    await store.upsert("docs", { id: "undefined", vectors: { default: vector(1, 0, 0) }, metadata: { value: undefined } });
    expect((await store.get("docs", "undefined"))?.metadata).toEqual({});
    expect((await store.search("docs", { space: "default", vector: vector(1, 0, 0) }, { where: { value: null } })).map((r) => r.id)).toEqual([]);
  });

  it("completes native pages for ties beyond pageSize and keeps codepoint order", async () => {
    await store.upsertMany("ties", [
      { id: "c", vectors: { default: vector(1, 0, 0) } },
      { id: "a", vectors: { default: vector(1, 0, 0) } },
      { id: "b", vectors: { default: vector(1, 0, 0) } },
      { id: "\u{10000}", vectors: { default: vector(1, 0, 0) } },
      { id: "z", vectors: { default: vector(1, 0, 0) } },
    ]);
    expect((await store.search("ties", { space: "default", vector: vector(1, 0, 0) }, { topK: 3 })).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect((await store.search("ties", { space: "default", vector: vector(0, 0, 0) }, { topK: 10 })).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
      "z",
      "\u{10000}",
    ]);
  });

  it("applies inclusive score thresholds after exact cosine recomputation", async () => {
    await store.upsert("docs", { id: "same", vectors: { default: vector(1, 0, 0) } });
    await store.upsert("docs", { id: "orthogonal", vectors: { default: vector(0, 1, 0) } });
    const exact = (await store.search("docs", { space: "default", vector: vector(1, 0, 0) }))[0]!.score;
    expect((await store.search("docs", { space: "default", vector: vector(1, 0, 0) }, { minScore: exact })).map((r) => r.id)).toEqual(["same"]);
    expect((await store.search("docs", { space: "default", vector: vector(1e20, 1e-20, 0) }, { minScore: 0.999 })).map((r) => r.id)).toEqual([
      "same",
    ]);
  });

  it("validates every upsert before mutation and makes empty batches no-op", async () => {
    await store.upsert("docs", { id: "existing", vectors: { default: vector(1, 0, 0) } });
    await store.upsertMany("docs", []);
    await expect(store.upsertMany("docs", [
      { id: "valid", vectors: { default: vector(0, 1, 0) } },
      { id: "bad", vectors: { default: vector(0, 1) } },
    ])).rejects.toThrow(expect.objectContaining({ name: "VectorInputError" }));
    expect(await store.count("docs")).toBe(1);
    expect(await store.get("docs", "valid")).toBeNull();
  });

  it("surfaces protocol mismatches and transport failures", async () => {
    await client.upsert(physical, {
      wait: true,
      points: [{ id: pointIdFor(JSON.stringify(["default", "docs"]), "bad"), vector: {}, payload: { _mirk_collection: "\"other\"" } }],
    });
    await expect(store.get("docs", "bad")).rejects.toBeInstanceOf(QdrantProtocolError);

    const badClient = new QdrantClient({ url: "http://127.0.0.1:1", checkCompatibility: false });
    await expect(QdrantVectorStore.open(badClient, { collectionName: "transport_failure" })).rejects.toThrow();
  });

  it("rejects an existing non-float32 collection before creating indexes", async () => {
    const wrongPhysical = `mirk_ts_wrong_${randomUUID().replaceAll("-", "")}`;
    await client.createCollection(wrongPhysical, {
      vectors: { size: 3, distance: "Dot", datatype: "float16" },
    });
    try {
      await expect(QdrantVectorStore.open(client, { collectionName: wrongPhysical })).rejects.toThrow(/Legacy/);
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
      await expect(QdrantVectorStore.open(injectedClient, { collectionName: injectedPhysical }))
        .rejects.toBe(unrelated);
    } finally {
      await injectedClient.deleteCollection(injectedPhysical);
    }
  });
});

describe("QdrantVectorStore configuration", () => {
  it("rejects invalid dimensions and page size before contacting Qdrant", async () => {
    const client = new QdrantClient({ url: qdrantUrl ?? "http://127.0.0.1:1", checkCompatibility: false });
    await expect(QdrantVectorStore.open(client, { collectionName: "invalid", pageSize: 0 })).rejects.toThrow(/pageSize/);
  });
});
