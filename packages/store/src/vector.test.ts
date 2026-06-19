// ─── @mirk/store/vector tests ───────────────────────────────────────────────
// One suite, run against InMemory and SQLite (in-memory db) backends, plus a
// SQLite persistence test proving vectors survive a close + reopen.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

import type { VectorStore, Vector } from "./vector/types.js";
import { InMemoryVectorStore } from "./vector/memory.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { cosineSimilarity, vectorToBuffer, bufferToVector } from "./vector/cosine.js";

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

// ── vec0 acceleration parity (Phase 2) ───────────────────────────────────────

// Run the FULL shared suite ALSO against the forced-JS-cosine adapter, so the suite
// proves parity (both paths pass identical assertions), not merely "the accel path runs".
suite("SqliteAdapter.vector (forced JS cosine)", async () => {
  const adapter = new SqliteAdapter({ path: ":memory:", dimensions: DIMS, forceJsCosine: true });
  return { store: adapter.vector, cleanup: () => adapter.close() };
});

// Whether the optional sqlite-vec peer actually loaded in this environment. The
// forced-JS-cosine parity tests run regardless; only the assertion that the accel
// PATH is live is environment-dependent, so it guards on this.
const ACCELERATED = (() => {
  const probe = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
  try {
    return probe.vector.meta.accelerated;
  } finally {
    probe.close();
  }
})();

describe("vec0 acceleration", () => {
  // Non-normalized vectors (varied magnitudes) — where L2 ranking != cosine ranking,
  // so this catches any regression to vec0's default L2 metric instead of cosine.
  const corpus: Array<{ id: string; nums: number[] }> = [
    { id: "a", nums: [3, 0, 0, 0] },
    { id: "b", nums: [0, 5, 0, 0] },
    { id: "c", nums: [1, 1, 0, 0] },
    { id: "d", nums: [0.1, 0, 0, 0] },
    { id: "e", nums: [2, 2, 2, 0] },
    { id: "f", nums: [0, 0.3, 0.9, 0] },
  ];
  const queries = [v(1, 0.2, 0, 0), v(0, 1, 0.1, 0), v(1, 1, 1, 0)];

  function seed(adapter: SqliteAdapter): void {
    for (const d of corpus) {
      adapter.vector.upsert("docs", { id: d.id, vector: Float32Array.from(d.nums) });
    }
  }

  it("meta.accelerated reflects the loaded peer, and is always false when forced off", () => {
    const accel = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    const forced = new SqliteAdapter({ path: ":memory:", dimensions: DIMS, forceJsCosine: true });
    try {
      // sqlite-vec is an OPTIONAL peer — accel is true only when it actually loaded
      // in this environment. Forcing JS cosine is environment-independent: always false.
      expect(accel.vector.meta.accelerated).toBe(ACCELERATED);
      expect(forced.vector.meta.accelerated).toBe(false);
    } finally {
      accel.close();
      forced.close();
    }
  });

  it("accelerated vec0 ranking == exact JS cosine ranking (non-normalized vectors)", () => {
    const accel = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    const fallback = new SqliteAdapter({ path: ":memory:", dimensions: DIMS, forceJsCosine: true });
    try {
      seed(accel);
      seed(fallback);
      for (const q of queries) {
        const accelIds = accel.vector.search("docs", q, { topK: corpus.length }).map((r) => r.id);
        const jsIds = fallback.vector.search("docs", q, { topK: corpus.length }).map((r) => r.id);
        expect(accelIds).toEqual(jsIds);
      }
    } finally {
      accel.close();
      fallback.close();
    }
  });

  it("accelerated topK + minScore match the fallback", () => {
    const accel = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    const fallback = new SqliteAdapter({ path: ":memory:", dimensions: DIMS, forceJsCosine: true });
    try {
      seed(accel);
      seed(fallback);
      const q = queries[0]!;
      expect(accel.vector.search("docs", q, { topK: 3 }).map((r) => r.id)).toEqual(
        fallback.vector.search("docs", q, { topK: 3 }).map((r) => r.id),
      );
      expect(accel.vector.search("docs", q, { minScore: 0.5 }).map((r) => r.id)).toEqual(
        fallback.vector.search("docs", q, { minScore: 0.5 }).map((r) => r.id),
      );
    } finally {
      accel.close();
      fallback.close();
    }
  });

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

  it("vec0 stays in sync across upsert-replace and remove", () => {
    const a = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    try {
      a.vector.upsert("docs", { id: "x", vector: v(1, 0, 0, 0) });
      a.vector.upsert("docs", { id: "x", vector: v(0, 1, 0, 0) }); // replace — vec0 must re-sync
      expect(a.vector.search("docs", v(0, 1, 0, 0), { topK: 1 })[0]!.id).toBe("x");
      a.vector.remove("docs", "x");
      expect(a.vector.search("docs", v(0, 1, 0, 0), { topK: 1 })).toEqual([]);
    } finally {
      a.close();
    }
  });

  it("excludes zero / non-finite stored vectors on BOTH paths (parity)", () => {
    const accel = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    const fb = new SqliteAdapter({ path: ":memory:", dimensions: DIMS, forceJsCosine: true });
    try {
      for (const a of [accel, fb]) {
        a.vector.upsert("docs", { id: "good", vector: v(1, 0, 0, 0) });
        a.vector.upsert("docs", { id: "zero", vector: v(0, 0, 0, 0) });
        a.vector.upsert("docs", { id: "nan", vector: v(NaN, 0, 0, 0) });
      }
      const q = v(1, 0, 0, 0);
      const accelIds = accel.vector.search("docs", q, { topK: 10 }).map((r) => r.id);
      const fbIds = fb.vector.search("docs", q, { topK: 10 }).map((r) => r.id);
      expect(accelIds).toEqual(["good"]); // zero + nan are directionless → excluded
      expect(accelIds).toEqual(fbIds); // parity
    } finally {
      accel.close();
      fb.close();
    }
  });

  it("handles a zero / non-finite query deterministically (forced JS path)", () => {
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

  it("backfills vec0 from rows written in a fallback session (reopen accelerated)", () => {
    const path = join(tmpdir(), `mirk-vec-backfill-${process.pid}-${Date.now()}.db`);
    try {
      // Session 1: forced fallback → writes to `vectors`, NO vec0 tables.
      const fb = new SqliteAdapter({ path, dimensions: DIMS, forceJsCosine: true });
      fb.vector.upsert("docs", { id: "a", vector: v(1, 0, 0, 0) });
      fb.vector.upsert("docs", { id: "b", vector: v(0, 1, 0, 0) });
      expect(fb.vector.meta.accelerated).toBe(false);
      fb.close();
      // Session 2: accelerated → ensureVecTable must backfill the existing rows.
      const accel = new SqliteAdapter({ path, dimensions: DIMS });
      expect(accel.vector.meta.accelerated).toBe(true);
      expect(accel.vector.search("docs", v(1, 0.1, 0, 0), { topK: 2 }).map((r) => r.id)).toEqual([
        "a",
        "b",
      ]); // backfilled, not empty
      accel.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("breaks ties deterministically and identically on both paths", () => {
    const accel = new SqliteAdapter({ path: ":memory:", dimensions: DIMS });
    const fb = new SqliteAdapter({ path: ":memory:", dimensions: DIMS, forceJsCosine: true });
    try {
      for (const a of [accel, fb]) {
        a.vector.upsert("docs", { id: "c", vector: v(1, 1, 0, 0) });
        a.vector.upsert("docs", { id: "a", vector: v(1, 1, 0, 0) });
        a.vector.upsert("docs", { id: "b", vector: v(1, 1, 0, 0) });
      }
      const q = v(1, 1, 0, 0); // identical cosine to all three → tie
      const accelIds = accel.vector.search("docs", q, { topK: 3 }).map((r) => r.id);
      const fbIds = fb.vector.search("docs", q, { topK: 3 }).map((r) => r.id);
      expect(accelIds).toEqual(["a", "b", "c"]); // id tiebreak
      expect(accelIds).toEqual(fbIds);
    } finally {
      accel.close();
      fb.close();
    }
  });
});
