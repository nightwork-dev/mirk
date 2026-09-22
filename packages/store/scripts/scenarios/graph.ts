// ─── Scenarios: graph traversal ─────────────────────────────────────────────
// Every behavioral assertion in `src/graph.test.ts` that a real backend can
// express, translated into a corpus scenario. The graph target is the three
// traversal primitives bound over `toAsync(store)` plus the async store surface,
// so a scenario seeds its own edges with `put` before walking them.
//
// Three groups of test assertions are deliberately absent, each for a reason
// that is a property of the corpus, not of the graph module:
//
//   - `depth: NaN` / `depth: Infinity` (graph.test.ts:235-244). Neither value
//     exists in JSON; the spec keeps them in the TypeScript unit test. `depth: 0`
//     and `depth: -3` pin the same guard with JSON numbers.
//   - the native-capability ladder (graph.test.ts:465-630). It needs a store
//     that implements `canTraverseGraph`/`traverseGraph`; neither corpus backend
//     does, and a probe store is not a backend.
//   - the query log of the frontier-batched path (graph.test.ts:426-442). Which
//     store calls happen is an implementation assertion, not a result. The
//     result half of that test is `graph/frontier-batched-edge-filter` below.
//
// The `same-as-traverse` scenarios run both traversal strategies over one graph
// in one scenario. The generator derives each expectation independently from the
// memory reference and checks both against SQLite, so identical expectations in
// the generated file are the pin: every runner must make the two strategies
// agree.

import { defineScenario } from "../../src/conformance/define.js";

const COLLECTION = "edges";

interface EdgeInput {
  id: string;
  from: string;
  to: string;
  type: string;
  published: boolean;
  [field: string]: unknown;
}

function edge(
  id: string,
  from: string,
  to: string,
  type: string,
  published = true,
): EdgeInput {
  return { id, from, to, type, published };
}

// Mirrors graph.test.ts:39-46.
//
//   a → b (follows)   b → c (follows)   c → a (follows)  ← closes the cycle
//   a → d (mentions)  d → e (follows)
//   a → x (follows, unpublished)        ← pruned by edgeFilter {published:true}
//
// node `z` is isolated.
const EDGES: EdgeInput[] = [
  edge("e_ab", "a", "b", "follows"),
  edge("e_bc", "b", "c", "follows"),
  edge("e_ca", "c", "a", "follows"),
  edge("e_ad", "a", "d", "mentions"),
  edge("e_de", "d", "e", "follows"),
  edge("e_ax", "a", "x", "follows", false),
];

const NOISE = edge("noise", "unrelated", "sink", "follows");

/** Seed the shared fixture into `edges`. */
function seed(edges: EdgeInput[] = EDGES): Array<{ op: string; args: unknown[] }> {
  return edges.map((item) => ({ op: "put", args: [COLLECTION, item] as unknown[] }));
}

/** Seed an arbitrary collection. */
function seedInto(
  collection: string,
  items: Array<Record<string, unknown>>,
): Array<{ op: string; args: unknown[] }> {
  return items.map((item) => ({ op: "put", args: [collection, item] as unknown[] }));
}

/** Both traversal strategies over the same options, each pinned exactly. */
function bothStrategies(
  collection: string,
  opts: Record<string, unknown>,
): Array<{ op: string; args: unknown[]; expect: { value: true } }> {
  return [
    { op: "traverse", args: [collection, opts], expect: { value: true } },
    { op: "traverseFrontierBatched", args: [collection, opts], expect: { value: true } },
  ];
}

// U+FFFD REPLACEMENT CHARACTER and U+1F525 FIRE. By code point U+FFFD (65533)
// sorts first; by UTF-16 code unit the fire's leading surrogate (0xD83D, 55357)
// sorts first. A code-unit sort therefore fails these two scenarios.
const REPLACEMENT = "�";
const FIRE = "\u{1F525}";

export const scenarios = [
  // ── neighbors ───────────────────────────────────────────────────────────
  defineScenario({
    id: "graph/neighbors-out",
    title: "neighbors defaults to out: the direct outgoing edges of a node",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      { op: "neighbors", args: [COLLECTION, { from: "a" }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "graph/neighbors-in",
    title: "neighbors direction in: only edges pointing at the node",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      {
        op: "neighbors",
        args: [COLLECTION, { from: "a", direction: "in" }],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/neighbors-both",
    title: "neighbors direction both: outgoing then incoming, deduped by edge id",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      {
        op: "neighbors",
        args: [COLLECTION, { from: "a", direction: "both" }],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/neighbors-edge-types",
    title: "neighbors edgeTypes keeps only the named relation kinds",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      {
        op: "neighbors",
        args: [COLLECTION, { from: "a", edgeTypes: ["mentions"] }],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/neighbors-edge-filter",
    title: "neighbors edgeFilter prunes at the store: the unpublished edge is gone",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      {
        op: "neighbors",
        args: [COLLECTION, { from: "a", edgeFilter: { where: { published: true } } }],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/neighbors-edge-filter-and-types",
    title: "neighbors edgeFilter and edgeTypes compose",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      {
        op: "neighbors",
        args: [
          COLLECTION,
          { from: "a", edgeTypes: ["follows"], edgeFilter: { where: { published: true } } },
        ],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/neighbors-isolated-node",
    title: "neighbors of a node with no edges is empty",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      { op: "neighbors", args: [COLLECTION, { from: "z" }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "graph/neighbors-structural-from-wins",
    title: "a caller edgeFilter on the structural from field cannot hijack the query",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      {
        op: "neighbors",
        args: [COLLECTION, { from: "a", edgeFilter: { where: { from: "zzz" } } }],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/full-edge-record-preserved",
    title: "neighbors and traverse return the stored edge record untouched",
    ports: ["collection", "graph"],
    steps: [
      ...seedInto("rich", [
        {
          id: "e_ft",
          from: "a",
          to: "b",
          type: "ref",
          from_type: "doc",
          to_type: "term",
          weight: 3,
        },
      ]),
      { op: "neighbors", args: ["rich", { from: "a" }], expect: { value: true } },
      { op: "traverse", args: ["rich", { start: "a", depth: 1 }], expect: { value: true } },
    ],
  }),

  // ── traverse ────────────────────────────────────────────────────────────
  defineScenario({
    id: "graph/traverse-depth-zero",
    title: "depth 0 yields no nodes and no edges",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      { op: "traverse", args: [COLLECTION, { start: "a", depth: 0 }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "graph/traverse-depth-negative",
    title: "a negative depth yields no nodes and no edges",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      { op: "traverse", args: [COLLECTION, { start: "a", depth: -3 }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "graph/traverse-depth-one",
    title: "depth 1 reaches the direct neighbors and excludes the start node",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      { op: "traverse", args: [COLLECTION, { start: "a", depth: 1 }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "graph/traverse-depth-two",
    title: "depth 2 walks two hops, sorted by node id and edge id",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      { op: "traverse", args: [COLLECTION, { start: "a", depth: 2 }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "graph/traverse-cycle-closes",
    title: "depth 3 records the cycle-closing edge without re-adding the start node",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      { op: "traverse", args: [COLLECTION, { start: "a", depth: 3 }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "graph/traverse-cycle-terminates",
    title: "a two-node cycle terminates at depth 100",
    ports: ["collection", "graph"],
    steps: [
      ...seedInto("c", [edge("c_pq", "p", "q", "link"), edge("c_qp", "q", "p", "link")]),
      { op: "traverse", args: ["c", { start: "p", depth: 100 }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "graph/traverse-direction-in",
    title: "direction in walks edges backwards",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      {
        op: "traverse",
        args: [COLLECTION, { start: "a", depth: 3, direction: "in" }],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/traverse-direction-both",
    title: "direction both makes an edge traversable from either endpoint",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      {
        op: "traverse",
        args: [COLLECTION, { start: "e", depth: 1, direction: "both" }],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/traverse-edge-types",
    title: "edgeTypes restricts the walk and leaves nodes behind the excluded type unreachable",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      {
        op: "traverse",
        args: [COLLECTION, { start: "a", depth: 5, edgeTypes: ["follows"] }],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/traverse-edge-filter",
    title: "edgeFilter prunes edges at load, before the walk",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      {
        op: "traverse",
        args: [COLLECTION, { start: "a", depth: 5, edgeFilter: { where: { published: true } } }],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/traverse-isolated-start",
    title: "traversal from an isolated node is empty",
    ports: ["collection", "graph"],
    steps: [
      ...seed(),
      { op: "traverse", args: [COLLECTION, { start: "z", depth: 5 }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "graph/traverse-self-loop",
    title: "a self-loop edge is traversed once and never puts the start node in nodes",
    ports: ["collection", "graph"],
    steps: [
      ...seed([...EDGES, edge("e_aa", "a", "a", "self")]),
      { op: "traverse", args: [COLLECTION, { start: "a", depth: 3 }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "graph/traverse-chain-both-directions",
    title: "direction both from the middle of a directed chain reaches both ends",
    ports: ["collection", "graph"],
    steps: [
      ...seedInto("chain", [edge("e_ab", "a", "b", "link"), edge("e_bc", "b", "c", "link")]),
      {
        op: "traverse",
        args: ["chain", { start: "b", depth: 2, direction: "both" }],
        expect: { value: true },
      },
    ],
  }),

  // ── frontier-batched ────────────────────────────────────────────────────
  defineScenario({
    id: "graph/frontier-batched-edge-filter",
    title: "frontier-batched traversal pushes the edgeFilter down and ignores unrelated edges",
    ports: ["collection", "graph"],
    capabilities: ["listWhereIn"],
    steps: [
      ...seed([...EDGES, NOISE]),
      {
        op: "traverseFrontierBatched",
        args: [COLLECTION, { start: "a", depth: 2, edgeFilter: { where: { published: true } } }],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "graph/frontier-batched-structural-field-wins",
    title: "the frontier field overrides a caller where on from, where load-once obeys it",
    ports: ["collection", "graph"],
    capabilities: ["listWhereIn"],
    // The two strategies are NOT interchangeable under a caller `where` on the
    // structural field, and the corpus pins the difference rather than hiding
    // it. `traverse` pushes the whole edgeFilter into one `list`, so
    // `from: "zzz"` matches nothing and the walk is empty. The frontier path
    // strips `from` before the `listWhereIn`, because the frontier values
    // already express that constraint, so it walks the graph normally — the
    // same override `neighbors` performs by spreading the structural field last.
    steps: [
      ...seed(),
      ...bothStrategies(COLLECTION, {
        start: "a",
        depth: 2,
        edgeFilter: { where: { from: "zzz", published: true } },
      }),
    ],
  }),

  defineScenario({
    id: "graph/frontier-batched-same-as-traverse-both",
    title: "both strategies agree on a both-direction walk with an edgeFilter",
    ports: ["collection", "graph"],
    capabilities: ["listWhereIn"],
    steps: [
      ...seed([...EDGES, NOISE]),
      ...bothStrategies(COLLECTION, {
        start: "a",
        depth: 5,
        direction: "both",
        edgeFilter: { where: { published: true } },
      }),
    ],
  }),

  defineScenario({
    id: "graph/frontier-batched-same-as-traverse-in",
    title: "both strategies agree on a backwards walk through the cycle",
    ports: ["collection", "graph"],
    capabilities: ["listWhereIn"],
    steps: [...seed(), ...bothStrategies(COLLECTION, { start: "a", depth: 3, direction: "in" })],
  }),

  defineScenario({
    id: "graph/frontier-batched-same-as-traverse-edge-types",
    title: "both strategies agree when edgeTypes filters the walk in memory",
    ports: ["collection", "graph"],
    capabilities: ["listWhereIn"],
    steps: [
      ...seed([...EDGES, NOISE]),
      ...bothStrategies(COLLECTION, { start: "a", depth: 5, edgeTypes: ["follows"] }),
    ],
  }),

  defineScenario({
    id: "graph/frontier-batched-same-as-traverse-self-loop",
    title: "both strategies agree on a graph carrying a self-loop",
    ports: ["collection", "graph"],
    capabilities: ["listWhereIn"],
    steps: [
      ...seed([...EDGES, edge("e_aa", "a", "a", "self")]),
      ...bothStrategies(COLLECTION, { start: "a", depth: 3 }),
    ],
  }),

  // ── code point ordering ─────────────────────────────────────────────────
  defineScenario({
    id: "graph/astral-node-id-sort",
    title: "node and edge ids sort by Unicode code point, not by UTF-16 code unit",
    ports: ["collection", "graph"],
    capabilities: ["listWhereIn"],
    steps: [
      // U+FFFD sorts before U+1F525 by code point and after it by code unit, so
      // a UTF-16 sort fails this scenario on both backends.
      ...seedInto("astral", [
        edge(`e${FIRE}`, "origin", FIRE, "link"),
        edge(`e${REPLACEMENT}`, "origin", REPLACEMENT, "link"),
      ]),
      ...bothStrategies("astral", { start: "origin", depth: 1 }),
    ],
  }),
];
