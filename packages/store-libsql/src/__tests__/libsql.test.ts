// ─── @mirk/store-libsql tests ────────────────────────────────────────────────
// Real libSQL — file: databases in a tmpdir and :memory: — no mocks. Exercises
// the KV facet (AsyncStore), the vector facet (AsyncVectorStore) on libSQL's
// NATIVE vector search, the load-bearing filter-before-KNN correctness property,
// and parity against @mirk/store's InMemoryVectorStore.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";

import { InMemoryVectorStore, type Vector } from "@mirk/store";
import { LibsqlAdapter } from "../libsql-adapter.js";

const DIMS = 4;
function v(...nums: number[]): Vector {
  return Float32Array.from(nums);
}

let tmpRoot: string;
let dbCounter = 0;
function fileUrl(): { url: string; path: string } {
  const path = join(tmpRoot, `t${dbCounter++}.db`);
  return { url: `file:${path}`, path };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "mirk-libsql-"));
});
afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── KV facet (AsyncStore) ─────────────────────────────────────────────────

describe("LibsqlKvFacet (AsyncStore)", () => {
  let adapter: LibsqlAdapter;

  beforeEach(async () => {
    adapter = await LibsqlAdapter.open({ url: ":memory:" });
  });
  afterEach(() => adapter.close());

  it("get/set/has/delete round-trip", async () => {
    expect(await adapter.kv.get("k")).toBeNull();
    expect(await adapter.kv.has("k")).toBe(false);
    await adapter.kv.set("k", { n: 1, s: "hi" });
    expect(await adapter.kv.get("k")).toEqual({ n: 1, s: "hi" });
    expect(await adapter.kv.has("k")).toBe(true);
    expect(await adapter.kv.delete("k")).toBe(true);
    expect(await adapter.kv.delete("k")).toBe(false);
    expect(await adapter.kv.get("k")).toBeNull();
  });

  it("set overwrites an existing key", async () => {
    await adapter.kv.set("k", 1);
    await adapter.kv.set("k", 2);
    expect(await adapter.kv.get("k")).toBe(2);
  });

  it("keys() lists all and filters by literal prefix", async () => {
    await adapter.kv.set("a:1", 1);
    await adapter.kv.set("a:2", 2);
    await adapter.kv.set("b:1", 3);
    expect(await adapter.kv.keys()).toEqual(["a:1", "a:2", "b:1"]);
    expect(await adapter.kv.keys("a:")).toEqual(["a:1", "a:2"]);
  });

  it("keys() treats LIKE wildcards in the prefix literally", async () => {
    await adapter.kv.set("100%done", 1);
    await adapter.kv.set("100Xdone", 2);
    // "%" must match literally, not as a wildcard.
    expect(await adapter.kv.keys("100%")).toEqual(["100%done"]);
  });

  it("collection put/getById/remove/count", async () => {
    expect(await adapter.kv.getById("users", "u1")).toBeNull();
    await adapter.kv.put("users", { id: "u1", name: "Ada" });
    await adapter.kv.put("users", { id: "u2", name: "Lin" });
    expect(await adapter.kv.getById("users", "u1")).toEqual({ id: "u1", name: "Ada" });
    expect(await adapter.kv.count("users")).toBe(2);
    expect(await adapter.kv.remove("users", "u1")).toBe(true);
    expect(await adapter.kv.remove("users", "u1")).toBe(false);
    expect(await adapter.kv.count("users")).toBe(1);
  });

  it("put overwrites (same id, no duplicate)", async () => {
    await adapter.kv.put("users", { id: "u1", name: "Ada" });
    await adapter.kv.put("users", { id: "u1", name: "Ada Lovelace" });
    expect(await adapter.kv.getById("users", "u1")).toEqual({ id: "u1", name: "Ada Lovelace" });
    expect(await adapter.kv.count("users")).toBe(1);
  });

  it("list() honours where / sortBy / sortDir / limit / offset", async () => {
    await adapter.kv.put("items", { id: "1", group: "a", rank: 3 });
    await adapter.kv.put("items", { id: "2", group: "a", rank: 1 });
    await adapter.kv.put("items", { id: "3", group: "a", rank: 2 });
    await adapter.kv.put("items", { id: "4", group: "b", rank: 9 });

    const where = await adapter.kv.list<{ id: string }>("items", { where: { group: "a" } });
    expect(where.map((r) => r.id).sort()).toEqual(["1", "2", "3"]);

    const asc = await adapter.kv.list<{ id: string }>("items", {
      where: { group: "a" },
      sortBy: "rank",
      sortDir: "asc",
    });
    expect(asc.map((r) => r.id)).toEqual(["2", "3", "1"]);

    const desc = await adapter.kv.list<{ id: string }>("items", {
      where: { group: "a" },
      sortBy: "rank",
      sortDir: "desc",
    });
    expect(desc.map((r) => r.id)).toEqual(["1", "3", "2"]);

    const page = await adapter.kv.list<{ id: string }>("items", {
      where: { group: "a" },
      sortBy: "rank",
      sortDir: "asc",
      limit: 1,
      offset: 1,
    });
    expect(page.map((r) => r.id)).toEqual(["3"]);

    expect(await adapter.kv.count("items", { where: { group: "a" } })).toBe(3);
  });

  it("KV persists across close + reopen (file: db)", async () => {
    const { url } = fileUrl();
    const a1 = await LibsqlAdapter.open({ url });
    await a1.kv.set("k", "persisted");
    await a1.kv.put("c", { id: "x", v: 1 });
    a1.close();

    const a2 = await LibsqlAdapter.open({ url });
    expect(await a2.kv.get("k")).toBe("persisted");
    expect(await a2.kv.getById("c", "x")).toEqual({ id: "x", v: 1 });
    a2.close();
  });
});

// ─── Vector facet (AsyncVectorStore) — native libSQL vector search ───────────

describe("LibsqlVectorFacet (AsyncVectorStore)", () => {
  let adapter: LibsqlAdapter;

  beforeEach(async () => {
    adapter = await LibsqlAdapter.open({ url: ":memory:", dimensions: DIMS });
  });
  afterEach(() => adapter.close());

  it("upsert + get round-trips vector and metadata", async () => {
    await adapter.vector.upsert("docs", {
      id: "a",
      vector: v(1, 0, 0, 0),
      metadata: { tag: "x" },
    });
    const got = await adapter.vector.get("docs", "a");
    expect(got).not.toBeNull();
    expect(Array.from(got!.vector)).toEqual([1, 0, 0, 0]);
    expect(got!.metadata).toEqual({ tag: "x" });
  });

  it("get returns null for a missing id", async () => {
    expect(await adapter.vector.get("docs", "ghost")).toBeNull();
  });

  it("has returns true for present, false for absent", async () => {
    await adapter.vector.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
    expect(await adapter.vector.has("docs", "a")).toBe(true);
    expect(await adapter.vector.has("docs", "z")).toBe(false);
  });

  it("upsert replaces existing (count stays 1)", async () => {
    await adapter.vector.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
    await adapter.vector.upsert("docs", { id: "a", vector: v(0, 1, 0, 0) });
    expect(await adapter.vector.count("docs")).toBe(1);
    expect(Array.from((await adapter.vector.get("docs", "a"))!.vector)).toEqual([0, 1, 0, 0]);
  });

  it("remove returns true then false; count tracks it", async () => {
    await adapter.vector.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
    expect(await adapter.vector.count("docs")).toBe(1);
    expect(await adapter.vector.remove("docs", "a")).toBe(true);
    expect(await adapter.vector.remove("docs", "a")).toBe(false);
    expect(await adapter.vector.count("docs")).toBe(0);
  });

  it("upsertMany + search returns nearest before far", async () => {
    await adapter.vector.upsertMany("docs", [
      { id: "near", vector: v(1, 0, 0, 0) },
      { id: "mid", vector: v(0.7, 0.7, 0, 0) },
      { id: "far", vector: v(0, 0, 1, 0) },
    ]);
    const res = await adapter.vector.search("docs", v(1, 0, 0, 0), { topK: 3 });
    expect(res.map((r) => r.id)).toEqual(["near", "mid", "far"]);
    expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
    expect(res[1]!.score).toBeGreaterThan(res[2]!.score);
  });

  it("minScore floors out weak matches", async () => {
    await adapter.vector.upsertMany("docs", [
      { id: "near", vector: v(1, 0, 0, 0) },
      { id: "ortho", vector: v(0, 1, 0, 0) },
    ]);
    const res = await adapter.vector.search("docs", v(1, 0, 0, 0), { topK: 10, minScore: 0.5 });
    expect(res.map((r) => r.id)).toEqual(["near"]);
  });

  it("vectors persist across close + reopen (file: db)", async () => {
    const { url } = fileUrl();
    const a1 = await LibsqlAdapter.open({ url, dimensions: DIMS });
    await a1.vector.upsertMany("docs", [
      { id: "a", vector: v(1, 0, 0, 0), metadata: { k: 1 } },
      { id: "b", vector: v(0, 1, 0, 0), metadata: { k: 2 } },
    ]);
    a1.close();

    const a2 = await LibsqlAdapter.open({ url, dimensions: DIMS });
    expect(await a2.vector.count("docs")).toBe(2);
    const got = await a2.vector.get("docs", "a");
    expect(Array.from(got!.vector)).toEqual([1, 0, 0, 0]);
    expect(got!.metadata).toEqual({ k: 1 });
    const res = await a2.vector.search("docs", v(1, 0, 0, 0), { topK: 1 });
    expect(res[0]!.id).toBe("a");
    a2.close();
  });

  it("reopening at a different dimension throws", async () => {
    const { url } = fileUrl();
    const a1 = await LibsqlAdapter.open({ url, dimensions: DIMS });
    a1.close();
    await expect(LibsqlAdapter.open({ url, dimensions: DIMS + 1 })).rejects.toThrow(
      /dimensions/,
    );
  });
});

// ─── THE HEADLINE TEST: filter-before-KNN correctness ───────────────────────
// Five docs whose metadata.type ∈ {document, element} sit at varying distances
// from the query. A naive "KNN first, filter after" would compute the top-K over
// ALL docs and then drop the wrong type — yielding fewer than K, or the wrong
// members. Filtering FIRST guarantees topK is the true nearest WITHIN the type.

describe("filter-before-KNN (load-bearing correctness)", () => {
  let adapter: LibsqlAdapter;

  beforeEach(async () => {
    adapter = await LibsqlAdapter.open({ url: ":memory:", dimensions: DIMS });
    // Arrange so the global nearest are mostly `element`, but the `document` set
    // has its own clear top-2. Distances to query v(1,0,0,0) increase down the list.
    await adapter.vector.upsertMany("mix", [
      { id: "el-1", vector: v(1, 0, 0, 0), metadata: { type: "element" } }, // closest overall
      { id: "el-2", vector: v(0.98, 0.02, 0, 0), metadata: { type: "element" } },
      { id: "doc-1", vector: v(0.9, 0.1, 0, 0), metadata: { type: "document" } }, // doc top-1
      { id: "doc-2", vector: v(0.8, 0.2, 0, 0), metadata: { type: "document" } }, // doc top-2
      { id: "doc-3", vector: v(0, 1, 0, 0), metadata: { type: "document" } }, // doc, far
    ]);
  });
  afterEach(() => adapter.close());

  it("where:{type:document} topK:2 returns the true nearest TWO documents", async () => {
    const res = await adapter.vector.search<{ type: string }>("mix", v(1, 0, 0, 0), {
      topK: 2,
      where: { type: "document" },
    });
    // If filtering happened AFTER a top-2 KNN, the global top-2 (el-1, el-2) would be
    // dropped and this would be empty. Filter-first yields the document set's top-2.
    expect(res.map((r) => r.id)).toEqual(["doc-1", "doc-2"]);
    expect(res.every((r) => r.metadata!.type === "document")).toBe(true);
  });

  it("whereNot:{type:element} topK:2 excludes elements and returns doc top-2", async () => {
    const res = await adapter.vector.search<{ type: string }>("mix", v(1, 0, 0, 0), {
      topK: 2,
      whereNot: { type: "element" },
    });
    expect(res.map((r) => r.id)).toEqual(["doc-1", "doc-2"]);
    expect(res.every((r) => r.metadata!.type !== "element")).toBe(true);
  });
});

// ─── PARITY: LibsqlVectorFacet vs InMemoryVectorStore ───────────────────────
// Identical id ordering and scores (within float tolerance) across both backends,
// proving the libSQL adapter is a drop-in for the reference port — native path AND
// forced-JS path.

describe("parity with InMemoryVectorStore", () => {
  const docs = [
    { id: "a", vector: v(1, 0, 0, 0), metadata: { g: "x" } },
    { id: "b", vector: v(0.6, 0.8, 0, 0), metadata: { g: "y" } },
    { id: "c", vector: v(0, 1, 0, 0), metadata: { g: "x" } },
    { id: "d", vector: v(0.5, 0.5, 0.5, 0.5), metadata: { g: "y" } },
    { id: "e", vector: v(0.2, 0.1, 0.9, 0), metadata: { g: "x" } },
  ];
  const query = v(0.9, 0.2, 0.1, 0);

  async function compare(forceJsCosine: boolean): Promise<void> {
    const mem = new InMemoryVectorStore({ dimensions: DIMS });
    mem.upsertMany("docs", docs);

    const adapter = await LibsqlAdapter.open({
      url: ":memory:",
      dimensions: DIMS,
      forceJsCosine,
    });
    try {
      await adapter.vector.upsertMany("docs", docs);

      const memRes = mem.search("docs", query, { topK: 5 });
      const libRes = await adapter.vector.search("docs", query, { topK: 5 });
      expect(libRes.map((r) => r.id)).toEqual(memRes.map((r) => r.id));
      for (let i = 0; i < memRes.length; i++) {
        expect(libRes[i]!.score).toBeCloseTo(memRes[i]!.score, 5);
      }

      // With a filter (forces the JS path on the lib side either way).
      const memFiltered = mem.search("docs", query, { topK: 5, where: { g: "x" } });
      const libFiltered = await adapter.vector.search("docs", query, {
        topK: 5,
        where: { g: "x" },
      });
      expect(libFiltered.map((r) => r.id)).toEqual(memFiltered.map((r) => r.id));
      for (let i = 0; i < memFiltered.length; i++) {
        expect(libFiltered[i]!.score).toBeCloseTo(memFiltered[i]!.score, 5);
      }
    } finally {
      adapter.close();
    }
  }

  it("matches InMemory ordering + scores on the NATIVE path", async () => {
    await compare(false);
  });

  it("matches InMemory ordering + scores on the forced-JS path", async () => {
    await compare(true);
  });
});
