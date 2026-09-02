// Prints vec0 scores next to exact-cosine scores for the same corpus.
// Against the tree as it stands both rows are identical, because the vec0
// branch throws and falls back to the exact path (see the sibling probe).
// Apply the `AND vv.k = ?` fix in SqliteVectorFacet.searchVec to see the
// float32-vs-float64 ranking divergence this probe exists to show.

import { SqliteAdapter } from "../../../../packages/store/src/adapters/sqlite.js";

const corpus = [
  { id: "a", nums: [3, 0, 0, 0] },
  { id: "b", nums: [0, 5, 0, 0] },
  { id: "c", nums: [1, 1, 0, 0] },
  { id: "d", nums: [0.1, 0, 0, 0] },
  { id: "e", nums: [2, 2, 2, 0] },
  { id: "f", nums: [0, 0.3, 0.9, 0] },
];

const accel = new SqliteAdapter({ path: ":memory:", dimensions: 4 });
const exact = new SqliteAdapter({ path: ":memory:", dimensions: 4, forceJsCosine: true });
for (const d of corpus) {
  accel.vector.upsert("docs", { id: d.id, vector: Float32Array.from(d.nums) });
  exact.vector.upsert("docs", { id: d.id, vector: Float32Array.from(d.nums) });
}

const query = Float32Array.from([1, 1, 1, 0]);
const av = accel.vector.search("docs", query, { topK: 6 });
const ev = exact.vector.search("docs", query, { topK: 6 });

console.log("vec0  :", av.map((r) => `${r.id}=${r.score.toPrecision(17)}`).join("\n         "));
console.log("exact :", ev.map((r) => `${r.id}=${r.score.toPrecision(17)}`).join("\n         "));
