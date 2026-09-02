// ─── Scenarios: vector ──────────────────────────────────────────────────────
// Every entry translates a behavior already asserted by `src/vector.test.ts`
// (digest `store-vector-search.md` section C.1–C.3) or pins one of the parity
// fixes landed alongside this file, so the generated expectations are
// cross-checked by an independent unit assertion rather than self-certifying.
//
// Vectors travel as JSON number arrays; the runner converts them to
// Float32Array and sizes both stores from the FIRST vector argument it finds.
// Every vector in a scenario is therefore the same length, except the two
// mismatch scenarios where the odd length deliberately comes second.
//
// Scores are float, so a scenario that pins one uses `approxFields: ["score"]`
// with the corpus tolerance. Where only ranking is contract, the `ids` form
// says so.

import { defineScenario } from "../../src/conformance/define.js";

/** Twelve unit-ish vectors, decreasing in similarity to [1, 0, 0]. */
const LADDER = Array.from({ length: 12 }, (_, i) => ({
  id: `d${String(i).padStart(2, "0")}`,
  vector: [1, i / 12, 0],
}));

export const scenarios = [
  // ── round trip, presence, removal ────────────────────────────────────────
  defineScenario({
    id: "vector/upsert-get-metadata",
    title: "a vector and its nested metadata round-trip through upsert and get",
    ports: ["vector"],
    steps: [
      {
        op: "upsert",
        args: [
          "docs",
          {
            id: "a",
            vector: [1, 0, 0],
            metadata: { type: "cat", tags: ["black", "small"], live: true, owner: null },
          },
        ],
      },
      { op: "get", args: ["docs", "a"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "vector/get-missing-returns-null",
    title: "get on an id that was never upserted returns null",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "a", vector: [1, 0, 0] }] },
      { op: "get", args: ["docs", "ghost"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "vector/metadata-absent",
    title: "a document upserted without metadata comes back without the field",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "a", vector: [1, 0, 0] }] },
      { op: "get", args: ["docs", "a"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "vector/upsert-replaces-by-id",
    title: "upserting the same id twice keeps the second vector and one row",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "a", vector: [1, 0, 0], metadata: { v: 1 } }] },
      { op: "upsert", args: ["docs", { id: "a", vector: [0, 1, 0], metadata: { v: 2 } }] },
      { op: "get", args: ["docs", "a"], expect: { value: true } },
      { op: "count", args: ["docs"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "vector/has-is-per-collection",
    title: "has is true only for an id present in that collection",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["one", { id: "a", vector: [1, 0, 0] }] },
      { op: "has", args: ["one", "a"], expect: { value: true } },
      { op: "has", args: ["one", "b"], expect: { value: true } },
      { op: "has", args: ["two", "a"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "vector/remove-reports-existence",
    title: "remove returns true once, then false, and the document is gone",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "a", vector: [1, 0, 0] }] },
      { op: "remove", args: ["docs", "a"], expect: { value: true } },
      { op: "remove", args: ["docs", "a"], expect: { value: true } },
      { op: "get", args: ["docs", "a"], expect: { value: true } },
      { op: "count", args: ["docs"], expect: { value: true } },
      { op: "has", args: ["docs", "a"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "vector/count-is-per-collection",
    title: "count is scoped to its collection and zero for an unknown one",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["one", { id: "a", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["one", { id: "b", vector: [0, 1, 0] }] },
      { op: "upsert", args: ["two", { id: "a", vector: [0, 0, 1] }] },
      { op: "count", args: ["one"], expect: { value: true } },
      { op: "count", args: ["two"], expect: { value: true } },
      { op: "count", args: ["nothing"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "vector/float32-round-trip",
    title: "components are rounded to float32 on store and read back rounded",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "a", vector: [0.1, 0.2, 0.3] }] },
      { op: "get", args: ["docs", "a"], expect: { value: true } },
    ],
  }),

  // ── dimensions ──────────────────────────────────────────────────────────
  defineScenario({
    id: "vector/dimension-mismatch-upsert",
    title: "upserting a vector of the wrong length throws the shared mismatch message",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "a", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["docs", { id: "b", vector: [1, 0, 0, 0] }], expect: { throws: true } },
      { op: "count", args: ["docs"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "vector/dimension-mismatch-search",
    title: "searching with a query of the wrong length throws the shared mismatch message",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "a", vector: [1, 0, 0] }] },
      { op: "search", args: ["docs", [1, 0, 0, 0]], expect: { throws: true } },
    ],
  }),

  defineScenario({
    id: "vector/upsert-many-atomic-on-mismatch",
    title: "a mid-array dimension mismatch in upsertMany persists nothing",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "keep", vector: [1, 0, 0] }] },
      {
        op: "upsertMany",
        args: [
          "docs",
          [
            { id: "b", vector: [0, 1, 0] },
            { id: "c", vector: [0, 0, 1, 1] },
          ],
        ],
        expect: { throws: true },
      },
      { op: "count", args: ["docs"], expect: { value: true } },
      { op: "get", args: ["docs", "b"], expect: { value: true } },
      { op: "get", args: ["docs", "keep"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "vector/upsert-many-inserts-all",
    title: "upsertMany inserts every document when all vectors are valid",
    ports: ["vector"],
    steps: [
      {
        op: "upsertMany",
        args: [
          "docs",
          [
            { id: "a", vector: [1, 0, 0], metadata: { n: 1 } },
            { id: "b", vector: [0, 1, 0] },
          ],
        ],
      },
      { op: "count", args: ["docs"], expect: { value: true } },
      { op: "get", args: ["docs", "a"], expect: { value: true } },
      { op: "get", args: ["docs", "b"], expect: { value: true } },
    ],
  }),

  // ── search ordering and limits ──────────────────────────────────────────
  defineScenario({
    id: "vector/search-orders-by-score",
    title: "search returns near, mid and far in descending similarity",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "near", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["docs", { id: "mid", vector: [1, 1, 0] }] },
      { op: "upsert", args: ["docs", { id: "far", vector: [0, 1, 0] }] },
      {
        op: "search",
        args: ["docs", [1, 0, 0]],
        expect: { approxFields: ["score"], tol: 1e-6 },
      },
    ],
  }),

  defineScenario({
    id: "vector/search-topk-default-is-ten",
    title: "search without topK returns at most ten results",
    ports: ["vector"],
    steps: [
      { op: "upsertMany", args: ["docs", LADDER] },
      { op: "count", args: ["docs"], expect: { value: true } },
      { op: "search", args: ["docs", [1, 0, 0]], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "vector/search-topk-limits-results",
    title: "topK caps the result count at the nearest documents",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "near", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["docs", { id: "mid", vector: [1, 1, 0] }] },
      { op: "upsert", args: ["docs", { id: "far", vector: [0, 1, 0] }] },
      { op: "search", args: ["docs", [1, 0, 0], { topK: 2 }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "vector/search-min-score-is-inclusive",
    title: "minScore keeps a document whose score equals the floor exactly",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "same", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["docs", { id: "orthogonal", vector: [0, 1, 0] }] },
      {
        op: "search",
        args: ["docs", [1, 0, 0], { minScore: 1 }],
        expect: { approxFields: ["score"], tol: 1e-6 },
      },
      {
        op: "search",
        args: ["docs", [1, 0, 0], { minScore: 0 }],
        expect: { approxFields: ["score"], tol: 1e-6 },
      },
    ],
  }),

  defineScenario({
    id: "vector/search-min-score-before-topk",
    title: "minScore filters the candidate set before topK slices it",
    ports: ["vector"],
    steps: [
      { op: "upsertMany", args: ["docs", LADDER] },
      {
        op: "search",
        args: ["docs", [1, 0, 0], { topK: 3, minScore: 0.99 }],
        expect: { ids: true },
      },
      {
        op: "search",
        args: ["docs", [1, 0, 0], { minScore: 0.99 }],
        expect: { ids: true },
      },
      // More documents clear the floor than topK admits, so the accelerated
      // path has to filter the whole candidate set and slice afterwards.
      {
        op: "search",
        args: ["docs", [1, 0, 0], { topK: 2, minScore: 0.9 }],
        expect: { ids: true },
      },
      {
        op: "search",
        args: ["docs", [1, 0, 0], { minScore: 0.9 }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "vector/search-unknown-collection",
    title: "search on a collection that was never written returns nothing",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "a", vector: [1, 0, 0] }] },
      { op: "search", args: ["other", [1, 0, 0]], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "vector/search-is-per-collection",
    title: "identical vectors in two collections do not leak across a search",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["one", { id: "a", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["two", { id: "b", vector: [1, 0, 0] }] },
      { op: "search", args: ["one", [1, 0, 0]], expect: { ids: true } },
      { op: "search", args: ["two", [1, 0, 0]], expect: { ids: true } },
    ],
  }),

  // ── tie-breaks ──────────────────────────────────────────────────────────
  defineScenario({
    id: "vector/tie-break-by-id",
    title: "equal scores break by id ascending, not by insertion order",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "c", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["docs", { id: "a", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["docs", { id: "b", vector: [1, 0, 0] }] },
      { op: "search", args: ["docs", [1, 0, 0]], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "vector/tie-break-astral-id",
    title: "id tie-breaks compare Unicode code points, so an astral id sorts last",
    ports: ["vector"],
    steps: [
      // U+1F600 is one code point above U+E000, but its UTF-16 surrogate
      // (U+D83D) is BELOW it — a code-unit sort puts the emoji first.
      { op: "upsert", args: ["docs", { id: "\u{1F600}", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["docs", { id: "\uE000", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["docs", { id: "z", vector: [1, 0, 0] }] },
      { op: "search", args: ["docs", [1, 0, 0]], expect: { ids: true } },
    ],
  }),

  // ── usability gate ──────────────────────────────────────────────────────
  defineScenario({
    id: "vector/zero-vector-stored-not-searchable",
    title: "an all-zero stored vector is stored and counted but never scored",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "zero", vector: [0, 0, 0] }] },
      { op: "upsert", args: ["docs", { id: "unit", vector: [1, 0, 0] }] },
      { op: "count", args: ["docs"], expect: { value: true } },
      { op: "has", args: ["docs", "zero"], expect: { value: true } },
      { op: "get", args: ["docs", "zero"], expect: { value: true } },
      { op: "search", args: ["docs", [1, 0, 0], { minScore: -1 }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "vector/zero-query-scores-zero-in-id-order",
    title: "an all-zero query scores every usable document zero, ordered by id",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["docs", { id: "c", vector: [1, 0, 0] }] },
      { op: "upsert", args: ["docs", { id: "a", vector: [0, 1, 0] }] },
      { op: "upsert", args: ["docs", { id: "b", vector: [0, 0, 1] }] },
      { op: "upsert", args: ["docs", { id: "zero", vector: [0, 0, 0] }] },
      {
        op: "search",
        args: ["docs", [0, 0, 0]],
        expect: { approxFields: ["score"], tol: 1e-6 },
      },
    ],
  }),

  // ── metadata filters ────────────────────────────────────────────────────
  defineScenario({
    id: "vector/where-filters-before-scoring",
    title: "where keeps only documents matching every condition",
    ports: ["vector"],
    steps: [
      {
        op: "upsertMany",
        args: [
          "pets",
          [
            { id: "cat-black", vector: [1, 0, 0], metadata: { type: "cat", color: "black" } },
            { id: "cat-white", vector: [0.9, 0.1, 0], metadata: { type: "cat", color: "white" } },
            { id: "dog-a", vector: [0, 1, 0], metadata: { type: "dog", color: "black" } },
          ],
        ],
      },
      {
        op: "search",
        args: ["pets", [1, 0, 0], { where: { type: "cat" } }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "vector/where-not-excludes-matches",
    title: "whereNot drops documents that satisfy every condition",
    ports: ["vector"],
    steps: [
      {
        op: "upsertMany",
        args: [
          "pets",
          [
            { id: "cat-black", vector: [1, 0, 0], metadata: { type: "cat", color: "black" } },
            { id: "cat-white", vector: [0.9, 0.1, 0], metadata: { type: "cat", color: "white" } },
            { id: "dog-a", vector: [0, 1, 0], metadata: { type: "dog", color: "black" } },
          ],
        ],
      },
      {
        op: "search",
        args: ["pets", [1, 0, 0], { whereNot: { type: "cat" } }],
        expect: { ids: true },
      },
      {
        op: "search",
        args: ["pets", [1, 0, 0], { where: { type: "cat" }, whereNot: { color: "black" } }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "vector/where-excludes-metadata-less-document",
    title: "a document with no metadata never satisfies a where filter",
    ports: ["vector"],
    steps: [
      { op: "upsert", args: ["pets", { id: "tagged", vector: [1, 0, 0], metadata: { type: "cat" } }] },
      { op: "upsert", args: ["pets", { id: "bare", vector: [1, 0, 0] }] },
      { op: "search", args: ["pets", [1, 0, 0], { where: { type: "cat" } }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "vector/topk-applies-after-where",
    title: "topK counts filtered survivors, not nearest documents overall",
    ports: ["vector"],
    steps: [
      {
        op: "upsertMany",
        args: [
          "pets",
          [
            { id: "cat-1", vector: [1, 0, 0], metadata: { type: "cat" } },
            { id: "cat-2", vector: [0.9, 0.1, 0], metadata: { type: "cat" } },
            { id: "cat-3", vector: [0.8, 0.2, 0], metadata: { type: "cat" } },
            { id: "dog-1", vector: [0.95, 0.05, 0], metadata: { type: "dog" } },
          ],
        ],
      },
      {
        op: "search",
        args: ["pets", [1, 0, 0], { where: { type: "cat" }, topK: 2 }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "vector/where-compares-nested-json-exactly",
    title: "where compares nested objects and arrays by exact JSON, key order included",
    ports: ["vector"],
    steps: [
      {
        op: "upsert",
        args: [
          "docs",
          { id: "a", vector: [1, 0, 0], metadata: { spec: { a: 1, b: 2 }, tags: ["x", "y"] } },
        ],
      },
      {
        op: "search",
        args: ["docs", [1, 0, 0], { where: { spec: { a: 1, b: 2 } } }],
        expect: { ids: true },
      },
      {
        op: "search",
        args: ["docs", [1, 0, 0], { where: { spec: { b: 2, a: 1 } } }],
        expect: { ids: true },
      },
      {
        op: "search",
        args: ["docs", [1, 0, 0], { where: { tags: ["y", "x"] } }],
        expect: { ids: true },
      },
      {
        op: "search",
        args: ["docs", [1, 0, 0], { where: { tags: "x" } }],
        expect: { ids: true },
      },
    ],
  }),
];
