// ─── Scenarios: full-text search ────────────────────────────────────────────
// Every entry translates a behavior already asserted by `src/search.test.ts`
// (digest `store-vector-search.md` sections C.5 and C.8) or pins one of the
// bm25 parity fixes landed alongside this file.
//
// bm25 floats are NOT cross-backend contract: FTS5 and the in-memory reference
// agree on ranking and on the matching set, and the in-memory magnitudes track
// FTS5's closely but not to the last ulp. Every scenario here therefore uses
// the `ids` form, or `values` with `ignoreFields: ["score"]` where `meta` is
// the thing under test. No scenario pins a score.
//
// Document-side tokenization differs by backend — the in-memory store uses the
// shared tokenizer, FTS5 uses `unicode61`, which folds diacritics. Scenarios
// stay inside the region where the two agree; a case that leaves it fails
// generation rather than getting a per-backend expectation.

import { defineScenario } from "../../src/conformance/define.js";

const FOXES = [
  { id: "quick", text: "the quick brown fox" },
  { id: "lazy", text: "the lazy dog sleeps" },
  { id: "another", text: "a fox in the henhouse" },
];

const FIELDED = [
  { id: "title-hit", fields: { title: "matcha", body: "unrelated words here" } },
  { id: "body-hit", fields: { title: "unrelated", body: "matcha in the body" } },
  { id: "neither", fields: { title: "nothing", body: "nothing at all" } },
];

const TWELVE = Array.from({ length: 12 }, (_, i) => ({
  id: `doc-${String(i).padStart(2, "0")}`,
  text: "identical text everywhere",
}));

export const scenarios = [
  // ── matching ────────────────────────────────────────────────────────────
  defineScenario({
    id: "search/term-matches-containing-documents",
    title: "a query term returns exactly the documents containing it",
    ports: ["search"],
    steps: [
      { op: "indexMany", args: ["docs", FOXES] },
      { op: "search", args: ["docs", "fox"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/term-in-no-document",
    title: "a term present in no document returns nothing",
    ports: ["search"],
    steps: [
      { op: "indexMany", args: ["docs", FOXES] },
      { op: "search", args: ["docs", "aardvark"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "search/or-semantics-across-terms",
    title: "a multi-term query matches documents holding any of the terms",
    ports: ["search"],
    steps: [
      { op: "indexMany", args: ["docs", FOXES] },
      { op: "search", args: ["docs", "fox dog"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/fields-document-matches-any-field",
    title: "a fielded document matches on a term in any of its fields",
    ports: ["search"],
    steps: [
      { op: "indexMany", args: ["docs", FIELDED] },
      { op: "search", args: ["docs", "matcha"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/text-and-fields-text-coexist",
    title: "a text document and a fields document naming text share one schema",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "plain", text: "shared term here" }] },
      { op: "index", args: ["docs", { id: "fielded", fields: { text: "shared term also" } }] },
      { op: "search", args: ["docs", "shared"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/unknown-collection-returns-empty",
    title: "search on a collection that was never indexed returns nothing",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", text: "hello" }] },
      { op: "search", args: ["other", "hello"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "search/is-per-collection",
    title: "identical text in two collections does not leak across a search",
    ports: ["search"],
    steps: [
      { op: "index", args: ["one", { id: "a", text: "shared vocabulary" }] },
      { op: "index", args: ["two", { id: "b", text: "shared vocabulary" }] },
      { op: "search", args: ["one", "shared"], expect: { ids: true } },
      { op: "search", args: ["two", "shared"], expect: { ids: true } },
    ],
  }),

  // ── schema and validation ───────────────────────────────────────────────
  defineScenario({
    id: "search/field-list-is-pinned-per-collection",
    title: "a document whose field list differs from the collection's throws",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", fields: { title: "one", body: "two" } }] },
      {
        op: "index",
        args: ["docs", { id: "b", fields: { title: "one", summary: "two" } }],
        expect: { throws: true },
      },
      { op: "index", args: ["docs", { id: "c", text: "plain" }], expect: { throws: true } },
    ],
  }),

  defineScenario({
    id: "search/document-with-both-text-and-fields",
    title: "a document carrying both text and fields is rejected",
    ports: ["search"],
    steps: [
      {
        op: "index",
        args: ["docs", { id: "a", text: "one", fields: { title: "two" } }],
        expect: { throws: true },
      },
    ],
  }),

  defineScenario({
    id: "search/document-with-neither-text-nor-fields",
    title: "a document carrying neither text nor fields is rejected",
    ports: ["search"],
    steps: [{ op: "index", args: ["docs", { id: "a" }], expect: { throws: true } }],
  }),

  defineScenario({
    id: "search/empty-fields-object",
    title: "a document with an empty fields object is rejected",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", fields: {} }], expect: { throws: true } },
    ],
  }),

  defineScenario({
    id: "search/non-string-field-value",
    title: "a non-string field value is rejected by name",
    ports: ["search"],
    steps: [
      {
        op: "index",
        args: ["docs", { id: "a", fields: { title: "ok", count: 3 } }],
        expect: { throws: true },
      },
    ],
  }),

  defineScenario({
    id: "search/negative-field-weight",
    title: "a negative field weight is rejected",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", fields: { title: "x", body: "y" } }] },
      {
        op: "search",
        args: ["docs", "x", { fieldWeights: { title: -1 } }],
        expect: { throws: true },
      },
    ],
  }),

  defineScenario({
    id: "search/unknown-field-weight-name",
    title: "a weight naming a field the collection does not have is rejected",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", fields: { title: "x", body: "y" } }] },
      {
        op: "search",
        args: ["docs", "x", { fieldWeights: { subtitle: 2 } }],
        expect: { throws: true },
      },
    ],
  }),

  defineScenario({
    id: "search/weight-values-validate-before-collection-lookup",
    title: "a bad weight value throws even for a collection that does not exist",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", text: "x" }] },
      {
        op: "search",
        args: ["missing", "x", { fieldWeights: { text: -1 } }],
        expect: { throws: true },
      },
      {
        op: "search",
        args: ["missing", "x", { fieldWeights: { text: 2 } }],
        expect: { value: true },
      },
    ],
  }),

  // ── query handling ──────────────────────────────────────────────────────
  defineScenario({
    id: "search/empty-and-punctuation-queries",
    title: "empty, whitespace and punctuation-only queries return nothing",
    ports: ["search"],
    steps: [
      { op: "indexMany", args: ["docs", FOXES] },
      { op: "search", args: ["docs", ""], expect: { value: true } },
      { op: "search", args: ["docs", "   "], expect: { value: true } },
      { op: "search", args: ["docs", "!!!"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "search/query-operators-are-ordinary-terms",
    title: "FTS operators and quotes in a query are tokenized, not parsed",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", text: "shell scripting guide" }] },
      { op: "search", args: ["docs", 'shell "OR" scripting;'], expect: { ids: true } },
      { op: "search", args: ["docs", "shell AND missing"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/query-is-case-insensitive",
    title: "query terms are lowercased before matching",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", text: "MiXeD Case Words" }] },
      { op: "search", args: ["docs", "mixed"], expect: { ids: true } },
      { op: "search", args: ["docs", "CASE"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/tokenizer-splits-on-punctuation",
    title: "a dot and an apostrophe split a token rather than joining it",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "release", text: "release v1.2 shipped" }] },
      { op: "index", args: ["docs", { id: "contraction", text: "it don't matter" }] },
      { op: "search", args: ["docs", "v1"], expect: { ids: true } },
      { op: "search", args: ["docs", "2"], expect: { ids: true } },
      { op: "search", args: ["docs", "v1.2"], expect: { ids: true } },
      { op: "search", args: ["docs", "don"], expect: { ids: true } },
      { op: "search", args: ["docs", "t"], expect: { ids: true } },
      { op: "search", args: ["docs", "don't"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/tokenizer-underscore-is-a-separator",
    title: "an underscore separates tokens",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", text: "snake_case_name" }] },
      { op: "search", args: ["docs", "snake"], expect: { ids: true } },
      { op: "search", args: ["docs", "case"], expect: { ids: true } },
    ],
  }),

  // ── ranking ─────────────────────────────────────────────────────────────
  defineScenario({
    id: "search/ranking-term-frequency",
    title: "with the term kept rare, more occurrences rank higher",
    ports: ["search"],
    steps: [
      {
        op: "indexMany",
        args: [
          "docs",
          [
            { id: "thrice", text: "matcha matcha matcha" },
            { id: "once", text: "matcha and other things entirely" },
            { id: "filler-a", text: "unrelated words about nothing" },
            { id: "filler-b", text: "more unrelated words here" },
            { id: "filler-c", text: "still nothing to do with it" },
          ],
        ],
      },
      { op: "search", args: ["docs", "matcha"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/ranking-three-tiers",
    title: "a three-tier relevance fixture ranks high, mid, low",
    ports: ["search"],
    steps: [
      {
        op: "indexMany",
        args: [
          "docs",
          [
            { id: "high", text: "matcha matcha matcha tea" },
            { id: "mid", text: "matcha matcha with milk and sugar added" },
            { id: "low", text: "one mention of matcha buried in a much longer document body" },
            { id: "filler-a", text: "unrelated words about nothing" },
            { id: "filler-b", text: "more unrelated words here" },
          ],
        ],
      },
      { op: "search", args: ["docs", "matcha"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/weighted-fields-rank-title-first",
    title: "a heavier title weight ranks the title hit above the body hit",
    ports: ["search"],
    steps: [
      { op: "indexMany", args: ["docs", FIELDED] },
      {
        op: "search",
        args: ["docs", "matcha", { fieldWeights: { title: 5, body: 1 } }],
        expect: { ids: true },
      },
      {
        op: "search",
        args: ["docs", "matcha", { fieldWeights: { title: 1, body: 5 } }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "search/odd-field-names-with-weights",
    title: "fields with dots, spaces and emoji sort into a stable weighted schema",
    ports: ["search"],
    steps: [
      {
        op: "indexMany",
        args: [
          "docs",
          [
            {
              id: "dot-hit",
              fields: { "title.with.dot": "matcha", "emoji \u{1F525}": "nothing", text: "nothing" },
            },
            {
              id: "emoji-hit",
              fields: { "title.with.dot": "nothing", "emoji \u{1F525}": "matcha", text: "nothing" },
            },
          ],
        ],
      },
      {
        op: "search",
        args: ["docs", "matcha", { fieldWeights: { "title.with.dot": 5, "emoji \u{1F525}": 1 } }],
        expect: { ids: true },
      },
    ],
  }),

  // ── the bm25 parity fixes ───────────────────────────────────────────────
  defineScenario({
    id: "search/every-document-holds-the-term",
    title: "when every document holds the term, the shorter document ranks first",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", text: "mirk storage layer" }] },
      { op: "index", args: ["docs", { id: "b", text: "storage" }] },
      { op: "search", args: ["docs", "storage"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/common-term-ranks-by-length",
    title: "a term in every document still ranks by document length, shortest first",
    ports: ["search"],
    steps: [
      {
        op: "indexMany",
        args: [
          "docs",
          [
            { id: "long", text: "term padding padding padding padding" },
            { id: "medium", text: "term padding padding" },
            { id: "short", text: "term" },
          ],
        ],
      },
      { op: "search", args: ["docs", "term"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/zero-weight-field-still-matches",
    title: "a zero-weighted field still matches the document, scoring it last",
    ports: ["search"],
    steps: [
      {
        op: "indexMany",
        args: [
          "docs",
          [
            { id: "title-only", fields: { title: "quantum", body: "nothing here" } },
            { id: "body-only", fields: { title: "other", body: "quantum" } },
            { id: "filler", fields: { title: "filler", body: "filler words" } },
          ],
        ],
      },
      {
        op: "search",
        args: ["docs", "quantum", { fieldWeights: { title: 0, body: 1 } }],
        expect: { ids: true },
      },
      {
        op: "search",
        args: ["docs", "quantum", { fieldWeights: { title: 1, body: 0 } }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "search/duplicate-query-token",
    title: "a repeated query term leaves the ranking unchanged",
    ports: ["search"],
    steps: [
      {
        op: "indexMany",
        args: [
          "docs",
          [
            { id: "a", text: "fox fox tail" },
            { id: "b", text: "fox" },
            { id: "c", text: "cat dog bird owl" },
          ],
        ],
      },
      { op: "search", args: ["docs", "fox"], expect: { ids: true } },
      { op: "search", args: ["docs", "fox fox"], expect: { ids: true } },
    ],
  }),

  // ── tie-breaks ──────────────────────────────────────────────────────────
  defineScenario({
    id: "search/tie-break-by-id",
    title: "identical documents come back in id order, not insertion order",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "c", text: "identical text" }] },
      { op: "index", args: ["docs", { id: "a", text: "identical text" }] },
      { op: "index", args: ["docs", { id: "b", text: "identical text" }] },
      { op: "search", args: ["docs", "identical"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/tie-break-astral-id",
    title: "id tie-breaks compare Unicode code points, so an astral id sorts last",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "\u{1F600}", text: "identical text" }] },
      { op: "index", args: ["docs", { id: "\uE000", text: "identical text" }] },
      { op: "index", args: ["docs", { id: "z", text: "identical text" }] },
      { op: "search", args: ["docs", "identical"], expect: { ids: true } },
    ],
  }),

  // ── limits, meta and mutation ───────────────────────────────────────────
  defineScenario({
    id: "search/limit-caps-results",
    title: "limit caps the number of results returned",
    ports: ["search"],
    steps: [
      { op: "indexMany", args: ["docs", TWELVE] },
      { op: "search", args: ["docs", "identical", { limit: 2 }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/default-limit-is-ten",
    title: "search without a limit returns at most ten results",
    ports: ["search"],
    steps: [
      { op: "indexMany", args: ["docs", TWELVE] },
      { op: "search", args: ["docs", "identical"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/meta-round-trips",
    title: "meta round-trips including nesting, and defaults to an empty object",
    ports: ["search"],
    steps: [
      {
        op: "index",
        args: [
          "docs",
          {
            id: "tagged",
            text: "shared term",
            meta: { type: "cat", nested: { deep: [1, 2] }, live: true, owner: null },
          },
        ],
      },
      { op: "index", args: ["docs", { id: "bare", text: "shared term" }] },
      {
        op: "search",
        args: ["docs", "shared"],
        expect: { ignoreFields: ["score"] },
      },
    ],
  }),

  defineScenario({
    id: "search/meta-filter-narrows-results",
    title: "filter.where keeps only documents whose meta matches every condition",
    ports: ["search"],
    steps: [
      {
        op: "indexMany",
        args: [
          "docs",
          [
            { id: "cat-a", text: "shared term", meta: { type: "cat" } },
            { id: "cat-b", text: "shared term", meta: { type: "cat" } },
            { id: "dog-a", text: "shared term", meta: { type: "dog" } },
          ],
        ],
      },
      {
        op: "search",
        args: ["docs", "shared", { filter: { where: { type: "cat" } } }],
        expect: { ignoreFields: ["score"] },
      },
    ],
  }),

  defineScenario({
    id: "search/meta-filter-excludes-meta-less-document",
    title: "a document indexed without meta never satisfies a filter",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "tagged", text: "shared term", meta: { type: "cat" } }] },
      { op: "index", args: ["docs", { id: "bare", text: "shared term" }] },
      {
        op: "search",
        args: ["docs", "shared", { filter: { where: { type: "cat" } } }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "search/meta-filter-applies-before-limit",
    title: "the meta filter runs before the limit, so the limit counts survivors",
    ports: ["search"],
    steps: [
      {
        op: "indexMany",
        args: [
          "docs",
          [
            { id: "dog-a", text: "identical text", meta: { type: "dog" } },
            { id: "dog-b", text: "identical text", meta: { type: "dog" } },
            { id: "dog-c", text: "identical text", meta: { type: "dog" } },
            { id: "cat-a", text: "identical text", meta: { type: "cat" } },
            { id: "cat-b", text: "identical text", meta: { type: "cat" } },
          ],
        ],
      },
      {
        op: "search",
        args: ["docs", "identical", { filter: { where: { type: "cat" } }, limit: 2 }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "search/filter-sort-and-offset-are-ignored",
    title: "sortBy, sortDir and offset on the filter object do not affect search",
    ports: ["search"],
    steps: [
      {
        op: "indexMany",
        args: [
          "docs",
          [
            { id: "a", text: "identical text", meta: { rank: 3 } },
            { id: "b", text: "identical text", meta: { rank: 1 } },
            { id: "c", text: "identical text", meta: { rank: 2 } },
          ],
        ],
      },
      {
        op: "search",
        args: ["docs", "identical", { filter: { sortBy: "rank", sortDir: "desc", offset: 2 } }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "search/reindex-replaces-terms",
    title: "re-indexing an id drops its old terms",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", text: "original wording" }] },
      { op: "index", args: ["docs", { id: "a", text: "replacement wording" }] },
      { op: "search", args: ["docs", "original"], expect: { value: true } },
      { op: "search", args: ["docs", "replacement"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "search/remove-reports-existence",
    title: "remove returns true once, then false, and the document stops matching",
    ports: ["search"],
    steps: [
      { op: "index", args: ["docs", { id: "a", text: "removable text" }] },
      { op: "remove", args: ["docs", "a"], expect: { value: true } },
      { op: "remove", args: ["docs", "a"], expect: { value: true } },
      { op: "search", args: ["docs", "removable"], expect: { value: true } },
      { op: "remove", args: ["never-written", "a"], expect: { value: true } },
    ],
  }),
];
