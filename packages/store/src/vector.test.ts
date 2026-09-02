// ─── @mirk/store/vector tests ───────────────────────────────────────────────
// One suite, run against InMemory and SQLite (in-memory db) backends, plus a
// SQLite persistence test proving vectors survive a close + reopen.
// FR-1 (AsyncVectorStore), FR-3a (has()), and FR-3b (where/whereNot) are covered
// in dedicated describe blocks at the bottom of this file.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

import type { VectorStore, Vector } from "./vector/types.js";
import type { AsyncVectorStore } from "./vector/types.js";
import { InMemoryVectorStore } from "./vector/memory.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { cosineSimilarity, vectorToBuffer, bufferToVector } from "./vector/cosine.js";
import { toAsyncVector } from "./vector/to-async-vector.js";

const DIMS = 4;
function v(...nums: number[]): Vector {
  return Float32Array.from(nums);
}

interface Made {
  store: VectorStore;
  cleanup?: () => void;
}

function suite(name: string, make: () => Promise<Made>): void {
  describe(name, () => {
    let store: VectorStore;
    let cleanup: (() => void) | undefined;

    beforeEach(async () => {
      const made = await make();
      store = made.store;
      cleanup = made.cleanup;
    });
    afterEach(() => cleanup?.());

    it("upsert + get round-trips vector and metadata", () => {
      store.upsert("docs", { id: "a", vector: v(1, 0, 0, 0), metadata: { tag: "x" } });
      const got = store.get("docs", "a");
      expect(got).not.toBeNull();
      expect(Array.from(got!.vector)).toEqual([1, 0, 0, 0]);
      expect(got!.metadata).toEqual({ tag: "x" });
    });

    it("get returns null for a missing id", () => {
      expect(store.get("docs", "ghost")).toBeNull();
    });

    it("upsert replaces an existing doc (no duplicate)", () => {
      store.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
      store.upsert("docs", { id: "a", vector: v(0, 1, 0, 0) });
      expect(Array.from(store.get("docs", "a")!.vector)).toEqual([0, 1, 0, 0]);
      expect(store.count("docs")).toBe(1);
    });

    it("has returns true for present docs, false for absent", () => {
      store.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
      expect(store.has("docs", "a")).toBe(true);
      expect(store.has("docs", "ghost")).toBe(false);
      expect(store.has("other", "a")).toBe(false);
    });

    it("has returns false after remove", () => {
      store.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
      store.remove("docs", "a");
      expect(store.has("docs", "a")).toBe(false);
    });

    it("search where filters to matching metadata only", () => {
      store.upsertMany("docs", [
        { id: "cat-a", vector: v(1, 0, 0, 0), metadata: { type: "cat" } },
        { id: "dog-a", vector: v(1, 0, 0, 0), metadata: { type: "dog" } },
        { id: "cat-b", vector: v(0.9, 0.1, 0, 0), metadata: { type: "cat" } },
      ]);
      const res = store.search("docs", v(1, 0, 0, 0), { where: { type: "cat" } });
      expect(res.map((r) => r.id).sort()).toEqual(["cat-a", "cat-b"]);
    });

    it("search whereNot excludes matching metadata", () => {
      store.upsertMany("docs", [
        { id: "cat-a", vector: v(1, 0, 0, 0), metadata: { type: "cat" } },
        { id: "dog-a", vector: v(1, 0, 0, 0), metadata: { type: "dog" } },
        { id: "cat-b", vector: v(0.9, 0.1, 0, 0), metadata: { type: "cat" } },
      ]);
      const res = store.search("docs", v(1, 0, 0, 0), { whereNot: { type: "cat" } });
      expect(res.map((r) => r.id)).toEqual(["dog-a"]);
    });

    it("search where + whereNot can be combined", () => {
      store.upsertMany("docs", [
        { id: "a", vector: v(1, 0, 0, 0), metadata: { type: "cat", color: "black" } },
        { id: "b", vector: v(1, 0, 0, 0), metadata: { type: "cat", color: "white" } },
        { id: "c", vector: v(1, 0, 0, 0), metadata: { type: "dog", color: "black" } },
      ]);
      const res = store.search("docs", v(1, 0, 0, 0), {
        where: { type: "cat" },
        whereNot: { color: "black" },
      });
      expect(res.map((r) => r.id)).toEqual(["b"]);
    });

    it("search where excludes docs with no metadata", () => {
      store.upsertMany("docs", [
        { id: "has-meta", vector: v(1, 0, 0, 0), metadata: { type: "cat" } },
        { id: "no-meta", vector: v(1, 0, 0, 0) },
      ]);
      const res = store.search("docs", v(1, 0, 0, 0), { where: { type: "cat" } });
      expect(res.map((r) => r.id)).toEqual(["has-meta"]);
    });

    it("search where + topK applies topK to the post-filter set", () => {
      store.upsertMany("docs", [
        { id: "cat-1", vector: v(1, 0, 0, 0), metadata: { type: "cat" } },
        { id: "cat-2", vector: v(0.9, 0.1, 0, 0), metadata: { type: "cat" } },
        { id: "cat-3", vector: v(0.8, 0.2, 0, 0), metadata: { type: "cat" } },
        { id: "dog-1", vector: v(1, 0, 0, 0), metadata: { type: "dog" } },
      ]);
      const res = store.search("docs", v(1, 0, 0, 0), { where: { type: "cat" }, topK: 2 });
      expect(res.length).toBe(2);
      expect(res.every((r) => r.id.startsWith("cat-"))).toBe(true);
    });

    it("remove deletes and reports prior existence", () => {
      store.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
      expect(store.remove("docs", "a")).toBe(true);
      expect(store.remove("docs", "a")).toBe(false);
      expect(store.get("docs", "a")).toBeNull();
    });

    it("count is scoped per collection", () => {
      store.upsert("a", { id: "1", vector: v(1, 0, 0, 0) });
      store.upsert("a", { id: "2", vector: v(0, 1, 0, 0) });
      store.upsert("b", { id: "1", vector: v(0, 0, 1, 0) });
      expect(store.count("a")).toBe(2);
      expect(store.count("b")).toBe(1);
      expect(store.count("empty")).toBe(0);
    });

    it("search ranks by cosine similarity, closest first", () => {
      store.upsertMany("docs", [
        { id: "near", vector: v(1, 0.1, 0, 0) },
        { id: "mid", vector: v(0.5, 0.5, 0, 0) },
        { id: "far", vector: v(0, 1, 0, 0) },
      ]);
      const res = store.search("docs", v(1, 0, 0, 0));
      expect(res.map((r) => r.id)).toEqual(["near", "mid", "far"]);
      expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
      expect(res[1]!.score).toBeGreaterThan(res[2]!.score);
    });

    it("search respects topK", () => {
      store.upsertMany("docs", [
        { id: "a", vector: v(1, 0, 0, 0) },
        { id: "b", vector: v(0, 1, 0, 0) },
        { id: "c", vector: v(0, 0, 1, 0) },
      ]);
      expect(store.search("docs", v(1, 0, 0, 0), { topK: 2 }).length).toBe(2);
    });

    it("search respects minScore", () => {
      store.upsertMany("docs", [
        { id: "same", vector: v(1, 0, 0, 0) },
        { id: "orth", vector: v(0, 1, 0, 0) },
      ]);
      const res = store.search("docs", v(1, 0, 0, 0), { minScore: 0.5 });
      expect(res.map((r) => r.id)).toEqual(["same"]);
    });

    it("search on an empty collection returns []", () => {
      expect(store.search("nope", v(1, 0, 0, 0))).toEqual([]);
    });

    it("rejects a dimension mismatch on upsert and search", () => {
      const bad = Float32Array.from([1, 0, 0, 0, 0]);
      expect(() => store.upsert("docs", { id: "b", vector: bad })).toThrow(/dimension/);
      expect(() => store.search("docs", bad)).toThrow(/dimension/);
    });

    it("upsertMany is atomic — a mid-array mismatch inserts nothing", () => {
      store.upsert("docs", { id: "pre", vector: v(1, 0, 0, 0) });
      const bad = Float32Array.from([1, 0, 0]); // wrong dimensionality
      expect(() =>
        store.upsertMany("docs", [
          { id: "a", vector: v(1, 0, 0, 0) },
          { id: "b", vector: bad },
          { id: "c", vector: v(0, 1, 0, 0) },
        ]),
      ).toThrow(/dimension/);
      expect(store.count("docs")).toBe(1);
      expect(store.get("docs", "a")).toBeNull();
      expect(store.get("docs", "c")).toBeNull();
    });

    it("metadata round-trips nested objects, arrays, booleans, and null", () => {
      const meta = { nested: { deep: [1, "two", null] }, flag: true };
      store.upsert("docs", { id: "m", vector: v(1, 0, 0, 0), metadata: meta });
      expect(store.get("docs", "m")!.metadata).toEqual(meta);
    });

    it("a doc with no metadata round-trips as undefined", () => {
      store.upsert("docs", { id: "n", vector: v(1, 0, 0, 0) });
      const got = store.get("docs", "n");
      expect(got).not.toBeNull();
      expect(got!.metadata).toBeUndefined();
    });

    it("a NaN in a stored vector does not poison search results", () => {
      store.upsert("docs", { id: "good", vector: v(1, 0, 0, 0) });
      store.upsert("docs", { id: "nan", vector: v(NaN, 0, 0, 0) });
      // minScore well below any real score; without the finite guard the NaN doc
      // (score NaN, and NaN < minScore === false) would leak into results.
      const res = store.search("docs", v(1, 0, 0, 0), { minScore: -1 });
      expect(res.map((r) => r.id)).toEqual(["good"]);
    });

    it("excludes a stored ZERO vector from results (directionless)", () => {
      store.upsert("docs", { id: "good", vector: v(1, 0, 0, 0) });
      store.upsert("docs", { id: "zero", vector: v(0, 0, 0, 0) });
      // minScore at the floor so a zero vector (cosine 0) could only be excluded
      // by the directionless gate, not by a score filter.
      const res = store.search("docs", v(1, 0, 0, 0), { minScore: -1 });
      expect(res.map((r) => r.id)).toEqual(["good"]);
    });

    it("excludes a stored NON-FINITE (Infinity) vector from results", () => {
      store.upsert("docs", { id: "good", vector: v(1, 0, 0, 0) });
      store.upsert("docs", { id: "inf", vector: v(Infinity, 0, 0, 0) });
      const res = store.search("docs", v(1, 0, 0, 0), { minScore: -1 });
      expect(res.map((r) => r.id)).toEqual(["good"]);
    });

    it("breaks score ties deterministically by id (insertion order independent)", () => {
      // Insert out of id-order; all share an identical vector → identical score.
      store.upsert("docs", { id: "c", vector: v(1, 1, 0, 0) });
      store.upsert("docs", { id: "a", vector: v(1, 1, 0, 0) });
      store.upsert("docs", { id: "b", vector: v(1, 1, 0, 0) });
      const ids = store.search("docs", v(1, 1, 0, 0), { topK: 3 }).map((r) => r.id);
      expect(ids).toEqual(["a", "b", "c"]); // id tiebreak, NOT insertion order
    });
  });
}

suite("InMemoryVectorStore", async () => ({
  store: new InMemoryVectorStore({ dimensions: DIMS }),
}));

suite("SqliteAdapter.vector (in-memory db)", async () => {
  const adapter = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
  return { store: adapter.vector, cleanup: () => adapter.close() };
});

describe("SqliteAdapter.vector — lazy dimensions", () => {
  it("infers and persists dimensions from the first upsert", () => {
    const path = join(tmpdir(), `mirk-vec-lazy-${process.pid}-${Date.now()}.db`);
    try {
      const a = new SqliteAdapter({ path });
      expect(a.vector.meta.dimensions).toBe(0);
      expect(a.vector.meta.accelerated).toBe(false);
      a.vector.upsert("docs", { id: "x", vector: v(1, 0, 0, 0), metadata: { k: 1 } });
      expect(a.vector.meta.dimensions).toBe(DIMS);
      expect(a.vector.search("docs", v(1, 0, 0, 0))[0]!.id).toBe("x");
      a.close();

      const b = new SqliteAdapter({ path });
      expect(b.vector.meta.dimensions).toBe(DIMS);
      expect(b.vector.get("docs", "x")?.metadata).toEqual({ k: 1 });
      expect(() => b.vector.upsert("docs", { id: "bad", vector: Float32Array.from([1, 0, 0]) })).toThrow(/dimension/);
      b.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("requires dimensions for search until a write or persisted dimension configures the facet", () => {
    const adapter = new SqliteAdapter({ path: ":memory:" });
    try {
      expect(() => adapter.vector.search("docs", v(1, 0, 0, 0))).toThrow(/no dimensions yet/);
      expect(adapter.vector.meta.dimensions).toBe(0);
    } finally {
      adapter.close();
    }
  });

  it("does not persist lazy dimensions when upsertMany rejects before writing", () => {
    const path = join(tmpdir(), `mirk-vec-lazy-atomic-${process.pid}-${Date.now()}.db`);
    try {
      const a = new SqliteAdapter({ path });
      expect(() =>
        a.vector.upsertMany("docs", [
          { id: "a", vector: v(1, 0, 0, 0) },
          { id: "bad", vector: Float32Array.from([1, 0, 0]) },
        ]),
      ).toThrow(/dimension/);
      expect(a.vector.count("docs")).toBe(0);
      a.close();

      const b = new SqliteAdapter({ path });
      expect(b.vector.meta.dimensions).toBe(0);
      b.vector.upsert("docs", { id: "three", vector: Float32Array.from([1, 0, 0]) });
      expect(b.vector.meta.dimensions).toBe(3);
      b.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});

describe("SqliteAdapter.vector — persistence", () => {
  it("vectors survive a close + reopen", async () => {
    const path = join(tmpdir(), `mirk-vec-test-${process.pid}-${Date.now()}.db`);
    try {
      const a = new SqliteAdapter({ path, dimensions: DIMS });
      a.vector.upsert("docs", { id: "x", vector: v(1, 0, 0, 0), metadata: { k: 1 } });
      a.close();

      const b = new SqliteAdapter({ path, dimensions: DIMS });
      const got = b.vector.get("docs", "x");
      expect(got).not.toBeNull();
      expect(Array.from(got!.vector)).toEqual([1, 0, 0, 0]);
      expect(got!.metadata).toEqual({ k: 1 });
      expect(b.vector.search("docs", v(1, 0, 0, 0))[0]!.id).toBe("x");
      b.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("rejects reopening a store at a different dimensionality", async () => {
    const path = join(tmpdir(), `mirk-vec-dim-${process.pid}-${Date.now()}.db`);
    try {
      const a = new SqliteAdapter({ path, dimensions: 4 });
      a.vector.upsert("docs", { id: "x", vector: v(1, 0, 0, 0) });
      a.close();
      expect(() => new SqliteAdapter({ path, dimensions: 3 })).toThrow(/dimension/i);
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});

// ── cosine helpers (exported utilities) ─────────────────────────────────────

describe("cosine helpers", () => {
  it("cosineSimilarity guards zero vector and length mismatch", () => {
    expect(cosineSimilarity(v(0, 0, 0, 0), v(1, 0, 0, 0))).toBe(0);
    expect(cosineSimilarity(Float32Array.from([1, 0]), v(1, 0, 0, 0))).toBe(0);
    expect(cosineSimilarity(v(1, 0, 0, 0), v(1, 0, 0, 0))).toBeCloseTo(1);
  });

  it("vectorToBuffer/bufferToVector round-trip a sliced (non-zero byteOffset) vector", () => {
    const backing = Float32Array.from([9, 9, 1, 0.5, -0.25, 0]);
    const sliced = backing.subarray(2, 6); // byteOffset = 8, length 4
    expect(sliced.byteOffset).toBe(8);
    const round = bufferToVector(vectorToBuffer(sliced));
    expect(Array.from(round)).toEqual([1, 0.5, -0.25, 0]);
  });
});

// ── SQLite cosine search ─────────────────────────────────────────────────────

describe("SqliteAdapter.vector — exact cosine search", () => {
  it("per-collection isolation — a query in A never returns B's docs", () => {
    const a = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    try {
      a.vector.upsert("A", { id: "a1", vector: v(1, 0, 0, 0) });
      a.vector.upsert("B", { id: "b1", vector: v(1, 0, 0, 0) }); // identical vector, other collection
      expect(a.vector.search("A", v(1, 0, 0, 0), { topK: 10 }).map((r) => r.id)).toEqual(["a1"]);
    } finally {
      a.close();
    }
  });

  it("upsert-replace and remove are reflected by the next search", () => {
    const a = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    try {
      a.vector.upsert("docs", { id: "x", vector: v(1, 0, 0, 0) });
      a.vector.upsert("docs", { id: "x", vector: v(0, 1, 0, 0) }); // replace
      expect(a.vector.search("docs", v(0, 1, 0, 0), { topK: 1 })[0]!.id).toBe("x");
      a.vector.remove("docs", "x");
      expect(a.vector.search("docs", v(0, 1, 0, 0), { topK: 1 })).toEqual([]);
    } finally {
      a.close();
    }
  });

  it("excludes zero / non-finite stored vectors", () => {
    const a = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    try {
      a.vector.upsert("docs", { id: "good", vector: v(1, 0, 0, 0) });
      a.vector.upsert("docs", { id: "zero", vector: v(0, 0, 0, 0) });
      a.vector.upsert("docs", { id: "nan", vector: v(NaN, 0, 0, 0) });
      const ids = a.vector.search("docs", v(1, 0, 0, 0), { topK: 10 }).map((r) => r.id);
      expect(ids).toEqual(["good"]); // zero + nan are directionless → excluded
    } finally {
      a.close();
    }
  });

  it("handles a zero / non-finite query deterministically", () => {
    const a = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    try {
      a.vector.upsert("docs", { id: "x", vector: v(1, 0, 0, 0) });
      a.vector.upsert("docs", { id: "y", vector: v(0, 1, 0, 0) });
      const res = a.vector.search("docs", v(0, 0, 0, 0), { topK: 10 });
      expect(res.map((r) => r.id)).toEqual(["x", "y"]); // cosine 0 for all → id order
      expect(res.every((r) => r.score === 0)).toBe(true);
    } finally {
      a.close();
    }
  });

  it("breaks ties deterministically by id", () => {
    const a = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    try {
      a.vector.upsert("docs", { id: "c", vector: v(1, 1, 0, 0) });
      a.vector.upsert("docs", { id: "a", vector: v(1, 1, 0, 0) });
      a.vector.upsert("docs", { id: "b", vector: v(1, 1, 0, 0) });
      const q = v(1, 1, 0, 0); // identical cosine to all three → tie
      expect(a.vector.search("docs", q, { topK: 3 }).map((r) => r.id)).toEqual(["a", "b", "c"]);
    } finally {
      a.close();
    }
  });
});

// ── FR-1: AsyncVectorStore + toAsyncVector ───────────────────────────────────

describe("AsyncVectorStore (toAsyncVector over InMemoryVectorStore)", () => {
  let async: AsyncVectorStore;

  beforeEach(() => {
    async = toAsyncVector(new InMemoryVectorStore({ dimensions: DIMS }));
  });

  it("meta is delegated synchronously", () => {
    expect(async.meta.backend).toBe("memory");
    expect(async.meta.dimensions).toBe(DIMS);
  });

  it("upsert + get round-trips via Promise", async () => {
    await async.upsert("docs", { id: "a", vector: v(1, 0, 0, 0), metadata: { x: 1 } });
    const got = await async.get("docs", "a");
    expect(got).not.toBeNull();
    expect(Array.from(got!.vector)).toEqual([1, 0, 0, 0]);
    expect(got!.metadata).toEqual({ x: 1 });
  });

  it("get returns null for a missing id", async () => {
    expect(await async.get("docs", "ghost")).toBeNull();
  });

  it("has returns true for present, false for absent", async () => {
    await async.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
    expect(await async.has("docs", "a")).toBe(true);
    expect(await async.has("docs", "missing")).toBe(false);
  });

  it("upsertMany + search work via Promise", async () => {
    await async.upsertMany("docs", [
      { id: "near", vector: v(1, 0.1, 0, 0) },
      { id: "far", vector: v(0, 1, 0, 0) },
    ]);
    const res = await async.search("docs", v(1, 0, 0, 0));
    expect(res[0]!.id).toBe("near");
    expect(res[1]!.id).toBe("far");
  });

  it("remove returns true when it existed, false when it didn't", async () => {
    await async.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
    expect(await async.remove("docs", "a")).toBe(true);
    expect(await async.remove("docs", "a")).toBe(false);
  });

  it("count returns the number of documents", async () => {
    await async.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
    await async.upsert("docs", { id: "b", vector: v(0, 1, 0, 0) });
    expect(await async.count("docs")).toBe(2);
  });

  it("search passes where/whereNot through to the sync backend", async () => {
    await async.upsertMany("docs", [
      { id: "cat", vector: v(1, 0, 0, 0), metadata: { type: "cat" } },
      { id: "dog", vector: v(1, 0, 0, 0), metadata: { type: "dog" } },
    ]);
    const res = await async.search("docs", v(1, 0, 0, 0), { where: { type: "cat" } });
    expect(res.map((r) => r.id)).toEqual(["cat"]);
  });
});
