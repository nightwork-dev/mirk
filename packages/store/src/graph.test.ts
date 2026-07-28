// ─── @mirk/store/graph tests ──────────────────────────────────────────────
// Real traversal semantics over an InMemoryStore lifted via toAsync. Edges are
// flat collection records. The same port backs sqlite/libsql, so these
// guarantees (direction, depth, cycles, policy) carry to those adapters for free.

import { describe, it, expect, beforeEach } from "vitest";
import type { AsyncStore, AsyncStoreInQuery, StoreFilter } from "./types.js";
import { InMemoryKv, toAsync } from "./kv.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import {
  neighbors,
  traverse,
  traverseFrontierBatched,
  type AsyncGraphTraversal,
  type Edge,
  type GraphTraversalOptions,
  type GraphTraversalResult,
} from "./graph.js";

const COLLECTION = "edges";

// Graph built below (out-direction):
//
//   a → b (follows)        b → c (follows)        c → a (follows)   ← cycle a→b→c→a
//   a → d (mentions)       d → e (follows)
//   a → x (follows, unpublished)   ← pruned by edgeFilter {published:true}
//
// node `z` is isolated (no edges).
function edge(
  id: string,
  from: string,
  to: string,
  type: string,
  published = true,
): Edge {
  return { id, from, to, type, published };
}

const EDGES: Edge[] = [
  edge("e_ab", "a", "b", "follows"),
  edge("e_bc", "b", "c", "follows"),
  edge("e_ca", "c", "a", "follows"), // closes the a→b→c→a cycle
  edge("e_ad", "a", "d", "mentions"),
  edge("e_de", "d", "e", "follows"),
  edge("e_ax", "a", "x", "follows", false), // unpublished — policy-pruned
];

function matchesWhere(edge: Edge, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [field, value] of Object.entries(where)) {
    if (edge[field] !== value) return false;
  }
  return true;
}

function batchOnlyStore(edges: Edge[]): {
  store: AsyncStore & AsyncStoreInQuery;
  queries: Array<{ field: string; values: readonly unknown[]; filter?: StoreFilter }>;
} {
  const queries: Array<{ field: string; values: readonly unknown[]; filter?: StoreFilter }> = [];
  const store: AsyncStore & AsyncStoreInQuery = {
    meta: { backend: "batch-probe" },
    async get<T>(): Promise<T | null> {
      throw new Error("unused");
    },
    async set(): Promise<void> {
      throw new Error("unused");
    },
    async has(): Promise<boolean> {
      throw new Error("unused");
    },
    async delete(): Promise<boolean> {
      throw new Error("unused");
    },
    async keys(): Promise<string[]> {
      throw new Error("unused");
    },
    async list<T>(): Promise<T[]> {
      throw new Error("traverseFrontierBatched must not call list() when listWhereIn exists");
    },
    async listWhereIn<T>(
      _collection: string,
      field: string,
      values: readonly unknown[],
      filter?: StoreFilter,
    ): Promise<T[]> {
      queries.push({ field, values: [...values], filter });
      const set = new Set(values);
      return edges.filter((e) => set.has(e[field]) && matchesWhere(e, filter?.where)) as T[];
    },
    async getById<T>(): Promise<T | null> {
      throw new Error("unused");
    },
    async put<T extends { id: string }>(_: string, item: T): Promise<T> {
      return item;
    },
    async remove(): Promise<boolean> {
      throw new Error("unused");
    },
    async count(): Promise<number> {
      throw new Error("unused");
    },
  };
  return { store, queries };
}

function nativeGraphStore(
  collections: readonly string[],
  result: GraphTraversalResult,
): {
  store: AsyncStore & AsyncStoreInQuery & AsyncGraphTraversal;
  traversals: Array<{ collection: string; options: GraphTraversalOptions }>;
  listWhereInCalls: number;
} {
  const configured = new Set(collections);
  const traversals: Array<{ collection: string; options: GraphTraversalOptions }> = [];
  let listWhereInCalls = 0;
  const base = toAsync(new InMemoryKv()) as AsyncStore & AsyncStoreInQuery;
  const baseListWhereIn = base.listWhereIn.bind(base);
  const store = Object.assign(base, {
    canTraverseGraph(collection: string): boolean {
      return configured.has(collection);
    },
    async traverseGraph(collection: string, options: GraphTraversalOptions): Promise<GraphTraversalResult> {
      traversals.push({ collection, options });
      return result;
    },
    async listWhereIn<T>(
      collection: string,
      field: string,
      values: readonly unknown[],
      filter?: StoreFilter,
    ): Promise<T[]> {
      listWhereInCalls++;
      return baseListWhereIn<T>(collection, field, values, filter);
    },
  }) as AsyncStore & AsyncStoreInQuery & AsyncGraphTraversal;
  return {
    store,
    traversals,
    get listWhereInCalls() {
      return listWhereInCalls;
    },
  };
}

describe("graph — neighbors", () => {
  let store: AsyncStore;

  beforeEach(async () => {
    store = toAsync(new InMemoryKv());
    for (const e of EDGES) await store.put(COLLECTION, e);
  });

  it("out: direct outgoing edges of a node", async () => {
    const result = await neighbors(store, COLLECTION, { from: "a" });
    // a → b, a → d, and a → x(unpublished). No edgeFilter here, so x is present.
    expect(result.map((e) => e.id).sort()).toEqual(["e_ab", "e_ad", "e_ax"]);
  });

  it("in: direct incoming edges of a node", async () => {
    const result = await neighbors(store, COLLECTION, {
      from: "a",
      direction: "in",
    });
    // only c → a points into a
    expect(result.map((e) => e.id)).toEqual(["e_ca"]);
  });

  it("both: incoming and outgoing, deduped by id", async () => {
    const result = await neighbors(store, COLLECTION, {
      from: "a",
      direction: "both",
    });
    // out: e_ab, e_ad, e_ax ; in: e_ca
    expect(result.map((e) => e.id).sort()).toEqual([
      "e_ab",
      "e_ad",
      "e_ax",
      "e_ca",
    ]);
  });

  it("edgeTypes restricts by relation kind (in-memory, since where can't IN)", async () => {
    const result = await neighbors(store, COLLECTION, {
      from: "a",
      edgeTypes: ["mentions"],
    });
    expect(result.map((e) => e.id)).toEqual(["e_ad"]);
  });

  it("edgeFilter policy prunes unpublished edges at the store level", async () => {
    const result = await neighbors(store, COLLECTION, {
      from: "a",
      edgeFilter: { where: { published: true } },
    });
    // e_ax is unpublished → excluded
    expect(result.map((e) => e.id).sort()).toEqual(["e_ab", "e_ad"]);
  });

  it("edgeFilter and edgeTypes compose", async () => {
    const result = await neighbors(store, COLLECTION, {
      from: "a",
      edgeTypes: ["follows"],
      edgeFilter: { where: { published: true } },
    });
    // follows edges out of a: e_ab (published), e_ax (unpublished, pruned)
    expect(result.map((e) => e.id)).toEqual(["e_ab"]);
  });

  it("isolated node yields no neighbors", async () => {
    const result = await neighbors(store, COLLECTION, { from: "z" });
    expect(result).toEqual([]);
  });
});

describe("graph — traverse", () => {
  let store: AsyncStore;

  beforeEach(async () => {
    store = toAsync(new InMemoryKv());
    for (const e of EDGES) await store.put(COLLECTION, e);
  });

  it("depth 0 → empty nodes and edges", async () => {
    const result = await traverse(store, COLLECTION, { start: "a", depth: 0 });
    expect(result).toEqual({ nodes: [], edges: [] });
  });

  it("negative depth → empty", async () => {
    const result = await traverse(store, COLLECTION, { start: "a", depth: -3 });
    expect(result).toEqual({ nodes: [], edges: [] });
  });

  it("non-finite depth (NaN, Infinity) → empty", async () => {
    // NaN and Infinity fail the Number.isFinite guard and must return empty,
    // not hang or throw.
    const nan = await traverse(store, COLLECTION, { start: "a", depth: NaN });
    expect(nan).toEqual({ nodes: [], edges: [] });

    const inf = await traverse(store, COLLECTION, { start: "a", depth: Infinity });
    expect(inf).toEqual({ nodes: [], edges: [] });
  });

  it("depth 1 → direct neighbors only (start excluded from nodes)", async () => {
    const result = await traverse(store, COLLECTION, { start: "a", depth: 1 });
    // out of a: b, d, x ; start `a` excluded
    expect(result.nodes).toEqual(["b", "d", "x"]);
    expect(result.edges.map((e) => e.id)).toEqual(["e_ab", "e_ad", "e_ax"]);
  });

  it("depth 2 → two hops, deterministic ordering", async () => {
    const result = await traverse(store, COLLECTION, { start: "a", depth: 2 });
    // hop1: b,d,x ; hop2 from b→c, from d→e ; (x has no out-edges)
    expect(result.nodes).toEqual(["b", "c", "d", "e", "x"]);
    expect(result.edges.map((e) => e.id)).toEqual([
      "e_ab",
      "e_ad",
      "e_ax",
      "e_bc",
      "e_de",
    ]);
  });

  it("depth 3 → completes the a→b→c→a cycle without re-expanding a", async () => {
    const result = await traverse(store, COLLECTION, { start: "a", depth: 3 });
    // hop3: c→a, but `a` is the origin (visited) → not added to nodes; the edge
    // e_ca IS traversed once. No infinite loop.
    expect(result.nodes).toEqual(["b", "c", "d", "e", "x"]);
    expect(result.edges.map((e) => e.id)).toEqual([
      "e_ab",
      "e_ad",
      "e_ax",
      "e_bc",
      "e_ca",
      "e_de",
    ]);
  });

  it("cycle: a node is expanded at most once (no double-expand / no hang)", async () => {
    // A tight 2-cycle p↔q. Even at large depth, terminates immediately.
    const cyc: Edge[] = [
      edge("c_pq", "p", "q", "link"),
      edge("c_qp", "q", "p", "link"),
    ];
    const s = toAsync(new InMemoryKv());
    for (const e of cyc) await s.put("c", e);
    const result = await traverse(s, "c", { start: "p", depth: 100 });
    // reachable from p (out): q (p→q). q→p closes the loop; p is origin.
    expect(result.nodes).toEqual(["q"]);
    expect(result.edges.map((e) => e.id)).toEqual(["c_pq", "c_qp"]);
  });

  it("direction in: walks edges backward", async () => {
    // Into a, depth 3. in-adjacency: c→a, b→c, a→b, d→e... walking `in` from a:
    // hop1: edges where to===a → c→a ⇒ reach c
    // hop2: edges where to===c → b→c ⇒ reach b
    // hop3: edges where to===b → a→b ⇒ a (origin, excluded)
    const result = await traverse(store, COLLECTION, {
      start: "a",
      depth: 3,
      direction: "in",
    });
    expect(result.nodes).toEqual(["b", "c"]);
    expect(result.edges.map((e) => e.id)).toEqual(["e_ab", "e_bc", "e_ca"]);
  });

  it("direction both: edges are bidirectional for reachability", async () => {
    // From e, depth 1, both: d→e makes e↔d reachable ⇒ d.
    const result = await traverse(store, COLLECTION, {
      start: "e",
      depth: 1,
      direction: "both",
    });
    expect(result.nodes).toEqual(["d"]);
    expect(result.edges.map((e) => e.id)).toEqual(["e_de"]);
  });

  it("edgeTypes restricts the walk", async () => {
    // Only `follows`. mentions edge a→d is excluded, so d (and via it e) unreachable.
    const result = await traverse(store, COLLECTION, {
      start: "a",
      depth: 5,
      edgeTypes: ["follows"],
    });
    // follows reachable from a: b (a→b), c (b→c), x (a→x); cycle c→a closes.
    expect(result.nodes).toEqual(["b", "c", "x"]);
    expect(result.edges.map((e) => e.id)).toEqual([
      "e_ab",
      "e_ax",
      "e_bc",
      "e_ca",
    ]);
  });

  it("edgeFilter policy prunes edges BEFORE the walk", async () => {
    // published-only: a→x (unpublished) is gone, so x unreachable.
    const result = await traverse(store, COLLECTION, {
      start: "a",
      depth: 5,
      edgeFilter: { where: { published: true } },
    });
    expect(result.nodes).toEqual(["b", "c", "d", "e"]);
    expect(result.edges.map((e) => e.id)).toEqual([
      "e_ab",
      "e_ad",
      "e_bc",
      "e_ca",
      "e_de",
    ]);
  });

  it("isolated start node → empty result", async () => {
    const result = await traverse(store, COLLECTION, { start: "z", depth: 5 });
    expect(result).toEqual({ nodes: [], edges: [] });
  });

  it("self-loop edge terminates without adding start to nodes", async () => {
    // e_aa: a → a. In BFS hop 1: the self-loop is traversed (edge recorded),
    // but the neighbor resolves to "a" which is already in visited — so "a"
    // is NOT added to nodes. Depth 3 terminates cleanly.
    const s = toAsync(new InMemoryKv());
    for (const e of EDGES) await s.put(COLLECTION, e);
    await s.put(COLLECTION, edge("e_aa", "a", "a", "self"));
    const result = await traverse(s, COLLECTION, { start: "a", depth: 3 });
    // nodes should not contain "a" (start is always excluded)
    expect(result.nodes).not.toContain("a");
    // the self-loop edge IS traversed and appears in edges output
    expect(result.edges.map((e) => e.id)).toContain("e_aa");
  });

  it("edgeFilter.where.from is overridden by structural from — caller cannot hijack the query", async () => {
    // If the caller passes edgeFilter: { where: { from: "zzz" } }, the traversal's
    // own `from: opts.from` must win (withWhere spreads opts.from last). The result
    // should be a's outgoing edges, NOT zzz's (which don't exist).
    const result = await neighbors(store, COLLECTION, {
      from: "a",
      edgeFilter: { where: { from: "zzz" } },
    });
    // a's out-edges including unpublished x; NOT empty (zzz has no edges)
    expect(result.map((e) => e.id).sort()).toEqual(["e_ab", "e_ad", "e_ax"]);
  });

  it("full edge record preserved — extra fields (from_type, to_type, weight) survive round-trip", async () => {
    // Consumer contract: graph functions never project edge records
    // down to {id,from,to,type}. Every stored field must be present on returned edges.
    const richEdge = {
      id: "e_ft",
      from: "a",
      to: "b",
      type: "ref",
      from_type: "doc",
      to_type: "term",
      weight: 3,
    };
    const s = toAsync(new InMemoryKv());
    await s.put("rich", richEdge);

    // neighbors: full record returned, not just the four structural fields
    const nbrs = await neighbors(s, "rich", { from: "a" });
    expect(nbrs).toHaveLength(1);
    expect(nbrs[0]).toEqual(richEdge);

    // traverse: edge record in `edges` carries all extra fields
    const trv = await traverse(s, "rich", { start: "a", depth: 1 });
    expect(trv.edges).toHaveLength(1);
    expect(trv.edges[0]).toEqual(richEdge);
  });

  it("both-direction depth 2 over directed chain a→b→c starting from b reaches a and c", async () => {
    // Fresh graph: a→b→c only. Starting from b with direction "both":
    // hop 1: e_ab (b is `to`, neighbor = a) and e_bc (b is `from`, neighbor = c) → reach a, c
    // hop 2: from a → e_ab neighbor b (visited); from c → e_bc neighbor b (visited) — no new nodes
    const s = toAsync(new InMemoryKv());
    await s.put("chain", edge("e_ab", "a", "b", "link"));
    await s.put("chain", edge("e_bc", "b", "c", "link"));
    const result = await traverse(s, "chain", {
      start: "b",
      depth: 2,
      direction: "both",
    });
    expect(result.nodes).toEqual(["a", "c"]); // sorted by id
    expect(result.edges.map((e) => e.id)).toEqual(["e_ab", "e_bc"]);
  });

  it("frontier-batched traversal uses listWhereIn instead of list and pushes edgeFilter into each query", async () => {
    const { store: s, queries } = batchOnlyStore([
      ...EDGES,
      edge("noise", "unrelated", "sink", "follows"),
    ]);
    const result = await traverseFrontierBatched(s, COLLECTION, {
      start: "a",
      depth: 2,
      edgeFilter: { where: { published: true } },
    });

    expect(result.nodes).toEqual(["b", "c", "d", "e"]);
    expect(result.edges.map((e) => e.id)).toEqual(["e_ab", "e_ad", "e_bc", "e_de"]);
    expect(queries.map((q) => q.field)).toEqual(["from", "from"]);
    expect(queries.map((q) => q.values)).toEqual([["a"], ["b", "d"]]);
    expect(queries.every((q) => q.filter?.where?.published === true)).toBe(true);
  });

  it("frontier-batched traversal reads through the sqlite provider and matches load-once semantics", async () => {
    const adapter = new SqliteAdapter({ path: ":memory:" });
    try {
      const s = toAsync(adapter.kv);
      for (const e of EDGES) await s.put(COLLECTION, e);
      await s.put(COLLECTION, edge("noise", "unrelated", "sink", "follows"));

      const opts = {
        start: "a",
        depth: 5,
        direction: "both" as const,
        edgeFilter: { where: { published: true } },
      };
      await expect(traverseFrontierBatched(s, COLLECTION, opts)).resolves.toEqual(
        await traverse(s, COLLECTION, opts),
      );
    } finally {
      adapter.close();
    }
  });

  it("traverse delegates to native graph traversal for configured collections", async () => {
    const native = nativeGraphStore(["native-edges"], {
      nodes: ["native-node"],
      edges: [edge("native-edge", "a", "native-node", "link")],
    });

    const opts = { start: "a", depth: 2, edgeTypes: ["link"] };
    await expect(traverse(native.store, "native-edges", opts)).resolves.toEqual({
      nodes: ["native-node"],
      edges: [edge("native-edge", "a", "native-node", "link")],
    });
    expect(native.traversals).toEqual([{ collection: "native-edges", options: opts }]);
  });

  it("frontier-batched delegates to native graph traversal when that is the only fast path", async () => {
    const traversals: Array<{ collection: string; options: GraphTraversalOptions }> = [];
    const store: AsyncStore & AsyncGraphTraversal = {
      meta: { backend: "native-only-probe" },
      canTraverseGraph(collection: string): boolean {
        return collection === "native-edges";
      },
      async traverseGraph(collection: string, options: GraphTraversalOptions): Promise<GraphTraversalResult> {
        traversals.push({ collection, options });
        return { nodes: ["b"], edges: [edge("e_ab", "a", "b", "follows")] };
      },
      async get<T>(): Promise<T | null> {
        throw new Error("unused");
      },
      async set(): Promise<void> {
        throw new Error("unused");
      },
      async has(): Promise<boolean> {
        throw new Error("unused");
      },
      async delete(): Promise<boolean> {
        throw new Error("unused");
      },
      async keys(): Promise<string[]> {
        throw new Error("unused");
      },
      async list<T>(): Promise<T[]> {
        throw new Error("native traversal must not call list()");
      },
      async getById<T>(): Promise<T | null> {
        throw new Error("unused");
      },
      async put<T extends { id: string }>(_: string, item: T): Promise<T> {
        return item;
      },
      async remove(): Promise<boolean> {
        throw new Error("unused");
      },
      async count(): Promise<number> {
        throw new Error("unused");
      },
    };

    const opts = { start: "a", depth: 1 };
    await expect(traverseFrontierBatched(store, "native-edges", opts)).resolves.toEqual({
      nodes: ["b"],
      edges: [edge("e_ab", "a", "b", "follows")],
    });
    expect(traversals).toEqual([{ collection: "native-edges", options: opts }]);
  });

  it("frontier-batched native traversal wins over listWhereIn when both capabilities apply", async () => {
    const native = nativeGraphStore(["native-edges"], {
      nodes: ["b"],
      edges: [edge("e_ab", "a", "b", "follows")],
    });
    await native.store.put("native-edges", edge("fallback", "a", "fallback", "follows"));

    const result = await traverseFrontierBatched(native.store, "native-edges", {
      start: "a",
      depth: 1,
    });

    expect(result.nodes).toEqual(["b"]);
    expect(native.traversals).toHaveLength(1);
    expect(native.listWhereInCalls).toBe(0);
  });

  it("unconfigured collections on a native-capable store use listWhereIn before load-once fallback", async () => {
    const native = nativeGraphStore(["native-edges"], {
      nodes: ["wrong"],
      edges: [edge("wrong", "a", "wrong", "link")],
    });
    for (const e of EDGES) await native.store.put("flat-edges", e);

    const result = await traverseFrontierBatched(native.store, "flat-edges", {
      start: "a",
      depth: 2,
      edgeFilter: { where: { published: true } },
    });

    expect(result.nodes).toEqual(["b", "c", "d", "e"]);
    expect(result.edges.map((e) => e.id)).toEqual(["e_ab", "e_ad", "e_bc", "e_de"]);
    expect(native.traversals).toEqual([]);
    expect(native.listWhereInCalls).toBe(2);
  });

  it("stores without native or listWhereIn use the load-once traversal fallback", async () => {
    let listCalls = 0;
    const store: AsyncStore = {
      meta: { backend: "load-once-probe" },
      async get<T>(): Promise<T | null> {
        throw new Error("unused");
      },
      async set(): Promise<void> {
        throw new Error("unused");
      },
      async has(): Promise<boolean> {
        throw new Error("unused");
      },
      async delete(): Promise<boolean> {
        throw new Error("unused");
      },
      async keys(): Promise<string[]> {
        throw new Error("unused");
      },
      async list<T>(): Promise<T[]> {
        listCalls++;
        return EDGES as T[];
      },
      async getById<T>(): Promise<T | null> {
        throw new Error("unused");
      },
      async put<T extends { id: string }>(_: string, item: T): Promise<T> {
        return item;
      },
      async remove(): Promise<boolean> {
        throw new Error("unused");
      },
      async count(): Promise<number> {
        throw new Error("unused");
      },
    };

    const result = await traverseFrontierBatched(store, COLLECTION, {
      start: "a",
      depth: 2,
    });

    expect(result.nodes).toEqual(["b", "c", "d", "e", "x"]);
    expect(listCalls).toBe(1);
  });

  it("native-capable stores do not treat arbitrary from/to records as configured graphs", async () => {
    const native = nativeGraphStore(["native-edges"], {
      nodes: ["wrong"],
      edges: [edge("wrong", "source", "wrong", "link")],
    });
    await native.store.put("notes", {
      id: "note-1",
      from: "source",
      to: "target",
      type: "mentions",
      body: "plain collection record",
    });

    const result = await traverse(native.store, "notes", { start: "source", depth: 1 });

    expect(result.nodes).toEqual(["target"]);
    expect(result.edges.map((e) => e.id)).toEqual(["note-1"]);
    expect(native.traversals).toEqual([]);
  });
});
