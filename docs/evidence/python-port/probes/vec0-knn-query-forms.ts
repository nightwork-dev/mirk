// Which KNN query forms sqlite-vec accepts through a join. The form the
// adapter ships is the one that throws.

import type Database from "better-sqlite3";
import { SqliteAdapter } from "../../../../packages/store/src/adapters/sqlite.js";

const adapter = new SqliteAdapter({ path: ":memory:", dimensions: 3 });
adapter.vector.upsertMany("docs", [
  { id: "z0", vector: [0, 0, 0] },
  { id: "a", vector: [1, 0, 0] },
  { id: "b", vector: [0.9, 0.1, 0] },
  { id: "c", vector: [0.8, 0.2, 0] },
  { id: "d", vector: [-1, 0, 0] },
]);

const db = (adapter as unknown as { db: Database.Database }).db;
const facet = adapter.vector as unknown as { ensureVecTable(c: string): string };
const table = facet.ensureVecTable("docs");
const query = Buffer.from(new Float32Array([1, 0, 0]).buffer);

console.log("vec table:", table);
console.log(
  "vec0 row count:",
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  "| vectors row count:",
  (db.prepare(`SELECT COUNT(*) AS n FROM vectors WHERE collection = 'docs'`).get() as { n: number }).n,
);

function attempt(label: string, sql: string, params: unknown[]): void {
  try {
    const out = db.prepare(sql).all(...(params as never[])) as Array<{ id: string; distance: number | null }>;
    console.log(
      `OK    ${label} -> ` +
        out.map((r) => `${r.id}:${r.distance === null ? "NULL" : Number(r.distance).toFixed(4)}`).join("  "),
    );
  } catch (error) {
    console.log(`THROW ${label} -> ${error instanceof Error ? error.message : String(error)}`);
  }
}

const join = `SELECT v.id AS id, vv.distance AS distance FROM ${table} vv JOIN vectors v ON v.rowid = vv.rowid`;
attempt("join + LIMIT ?  (what the adapter ships)", `${join} WHERE vv.embedding MATCH ? ORDER BY vv.distance LIMIT ?`, [query, 3]);
attempt("join + LIMIT 3 literal                  ", `${join} WHERE vv.embedding MATCH ? ORDER BY vv.distance LIMIT 3`, [query]);
attempt("join + k = ? (3)                        ", `${join} WHERE vv.embedding MATCH ? AND vv.k = ? ORDER BY vv.distance`, [query, 3]);
attempt("join + k = ? (10, more than stored)     ", `${join} WHERE vv.embedding MATCH ? AND vv.k = ? ORDER BY vv.distance`, [query, 10]);
attempt("bare vtab + LIMIT ?                     ", `SELECT rowid AS id, distance FROM ${table} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`, [query, 3]);
