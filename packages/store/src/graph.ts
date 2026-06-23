// ─── @mirk/store/graph ──────────────────────────────────────────────────────
// A PURE graph-traversal primitive over the AsyncStore port. Edges are flat
// collection records, so any field is matchable through StoreFilter.where (exact
// match) — there is no dedicated edge table or graph engine. Because it runs over
// the port, the SAME traversal works over every backing (in-memory, sqlite,
// libsql) for free.
//
// Explicitly NOT graphRAG: there is no embed → vectorSearch → expand → score
// here. Policy (which edges are eligible) stays OUT of the primitive — the caller
// supplies `edgeFilter` (a StoreFilter on edge fields, e.g. {where:{published:true}})
// and it is applied at load. graphRAG composes this primitive with @mirk/store/vector;
// it does not live here.

import type { AsyncStore, StoreFilter } from "./types.js";

/**
 * A directed edge stored as a flat collection record. `from`/`to` are node ids,
 * `type` is the relation kind. Arbitrary metadata fields (e.g. `published`,
 * `weight`) live alongside and are matchable via StoreFilter.where / edgeFilter.
 */
export interface Edge {
  id: string;
  from: string;
  to: string;
  type: string;
  [field: string]: unknown;
}

/** Which way to walk an edge. "both" treats every edge as bidirectional. */
export type Direction = "out" | "in" | "both";

/** Keep edges whose `type` is in the set. No-op when `edgeTypes` is undefined.
 *  Done in-memory because StoreFilter.where is exact-match only and cannot
 *  express "type IN [...]". */
function filterByTypes(edges: Edge[], edgeTypes?: string[]): Edge[] {
  if (!edgeTypes || edgeTypes.length === 0) return edges;
  const set = new Set(edgeTypes);
  return edges.filter((e) => set.has(e.type));
}

/** Dedup edges by id, preserving first-seen order. */
function dedupById(edges: Edge[]): Edge[] {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const e of edges) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** Merge a caller `where` with an override, keeping the override authoritative. */
function withWhere(
  filter: StoreFilter | undefined,
  override: Record<string, unknown>,
): StoreFilter {
  return { ...filter, where: { ...filter?.where, ...override } };
}

/**
 * Single-hop adjacent edges of `opts.from`.
 *
 * - "out": edges where `from === opts.from`.
 * - "in":  edges where `to === opts.from`.
 * - "both": the union of the two (deduped by edge id).
 *
 * `opts.edgeFilter` (a StoreFilter on edge fields) is applied at the store level;
 * `opts.edgeTypes`, if given, is applied in-memory afterward (the port's `where`
 * is exact-match only and cannot express "type IN [...]").
 *
 * Returns the full stored edge record untouched — no projection. All extra fields
 * (e.g. `from_type`, `to_type`, `weight`) are present on every returned edge.
 */
export async function neighbors(
  store: AsyncStore,
  collection: string,
  opts: {
    from: string;
    direction?: Direction;
    edgeTypes?: string[];
    edgeFilter?: StoreFilter;
  },
): Promise<Edge[]> {
  const direction = opts.direction ?? "out";

  let edges: Edge[];
  if (direction === "out") {
    edges = await store.list<Edge>(
      collection,
      withWhere(opts.edgeFilter, { from: opts.from }),
    );
  } else if (direction === "in") {
    edges = await store.list<Edge>(
      collection,
      withWhere(opts.edgeFilter, { to: opts.from }),
    );
  } else {
    const [out, inc] = await Promise.all([
      store.list<Edge>(collection, withWhere(opts.edgeFilter, { from: opts.from })),
      store.list<Edge>(collection, withWhere(opts.edgeFilter, { to: opts.from })),
    ]);
    edges = dedupById([...out, ...inc]);
  }

  return filterByTypes(edges, opts.edgeTypes);
}

/**
 * Batched, fanout-free BFS to `depth` hops from `start`.
 *
 * Load-once strategy (the fanout avoidance): the candidate edge set is loaded
 * with ONE store call — `store.list(collection, edgeFilter)` — applying the
 * caller's policy `edgeFilter` at load. Everything after is in-memory: filter by
 * `edgeTypes`, build an adjacency index, then BFS level-by-level. No per-node
 * query fan-out, regardless of graph size.
 *
 * Return shape:
 * - `nodes`: reached node ids, EXCLUDING `start`. `start` is the origin, not a
 *   discovered neighbor — depth 0 therefore yields `[]`, depth 1 yields the
 *   direct neighbors, etc. Cycles terminate: a node is expanded at most once.
 * - `edges`: every edge actually traversed, deduped by id.
 *
 * Both arrays are sorted by id so results are deterministic across backings
 * (the parity test relies on this). depth ≤ 0 → `{ nodes: [], edges: [] }`.
 *
 * "both" adjacency: an edge {from:a,to:b} makes a→b AND b→a reachable.
 *
 * Returns the full stored edge record untouched — no projection. All extra fields
 * (e.g. `from_type`, `to_type`, `weight`) are present on every returned edge.
 */
export async function traverse(
  store: AsyncStore,
  collection: string,
  opts: {
    start: string;
    depth: number;
    direction?: Direction;
    edgeTypes?: string[];
    edgeFilter?: StoreFilter;
  },
): Promise<{ nodes: string[]; edges: Edge[] }> {
  const direction = opts.direction ?? "out";

  if (!Number.isFinite(opts.depth) || opts.depth <= 0) {
    return { nodes: [], edges: [] };
  }

  // ── One store call. Policy applied at load, types filtered in-memory. ──
  const loaded = await store.list<Edge>(collection, opts.edgeFilter);
  const all = filterByTypes(loaded, opts.edgeTypes);

  // ── Adjacency index: node id → outgoing edges for the chosen direction. ──
  // "out": index by `from`. "in": index by `to`. "both": an edge contributes
  // to both its endpoints, so a→b and b→a are each one step.
  const adjacency = new Map<string, Edge[]>();
  const addAdj = (node: string, edge: Edge) => {
    const list = adjacency.get(node);
    if (list) list.push(edge);
    else adjacency.set(node, [edge]);
  };
  for (const e of all) {
    if (direction === "out") {
      addAdj(e.from, e);
    } else if (direction === "in") {
      addAdj(e.to, e);
    } else {
      addAdj(e.from, e);
      addAdj(e.to, e);
    }
  }

  // ── BFS level-by-level. `visited` includes `start` so it is never re-expanded
  //    (cycle-safe) and never appears in `nodes`. `frontier` is the current
  //    level's nodes; each hop expands it once. ──
  const visited = new Set<string>([opts.start]);
  const reached: string[] = [];
  const traversedEdges: Edge[] = [];
  const seenEdgeIds = new Set<string>();

  let frontier: string[] = [opts.start];
  for (let hop = 0; hop < opts.depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const node of frontier) {
      const out = adjacency.get(node);
      if (!out) continue;
      for (const edge of out) {
        if (!seenEdgeIds.has(edge.id)) {
          seenEdgeIds.add(edge.id);
          traversedEdges.push(edge);
        }
        // The far endpoint of this edge relative to `node`.
        const neighbor = edge.from === node ? edge.to : edge.from;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          reached.push(neighbor);
          next.push(neighbor);
        }
      }
    }
    frontier = next;
  }

  // ── Deterministic ordering for cross-backing parity. ──
  reached.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  traversedEdges.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return { nodes: reached, edges: traversedEdges };
}
