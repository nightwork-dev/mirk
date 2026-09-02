// Calls SqliteVectorFacet.searchVec directly, bypassing the bare catch in
// `search` that hides its failure.

import { SqliteAdapter } from "../../../../packages/store/src/adapters/sqlite.js";

const adapter = new SqliteAdapter({ path: ":memory:", dimensions: 3 });
adapter.vector.upsertMany("docs", [
  { id: "a", vector: [1, 0, 0] },
  { id: "b", vector: [0.9, 0.1, 0] },
  { id: "c", vector: [0.8, 0.2, 0] },
]);

const facet = adapter.vector as unknown as {
  accelerated: boolean;
  searchVec(c: string, q: number[], topK: number, minScore: number | undefined): unknown;
};

console.log("meta.accelerated =", adapter.vector.meta.accelerated);
try {
  const out = facet.searchVec("docs", [1, 0, 0], 2, undefined);
  console.log("searchVec RAN ->", JSON.stringify(out));
} catch (error) {
  console.log("searchVec THREW ->", error instanceof Error ? error.message : String(error));
  console.log("=> search() silently falls back to the exact JS path; the vec0 branch is dead.");
}
