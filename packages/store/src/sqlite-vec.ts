import { createRequire } from "node:module";
import { vectorToBuffer } from "./vector/cosine.js";
import type { SqliteDb } from "./adapters/sqlite-driver.js";
import type { SqliteVectorEngine, SqliteVectorSearchRequest } from "./adapters/sqlite-vector-engine.js";

export class SqliteVecError extends Error {
  readonly code = "native-vector-engine";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SqliteVecError";
  }
}

function metadataMatch(filter: Record<string, unknown>, params: unknown[]): string {
  const conditions = ["d.metadata IS NOT NULL"];
  for (const [key, value] of Object.entries(filter)) {
    const encoded = JSON.stringify(value);
    params.push(key);
    if (encoded === undefined) {
      conditions.push("NOT EXISTS (SELECT 1 FROM json_each(d.metadata) f WHERE f.key=?)");
    } else {
      const parsed: unknown = JSON.parse(encoded);
      const kind = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
      if (kind === "object" || kind === "array") {
        params.push(kind, encoded);
        conditions.push("EXISTS (SELECT 1 FROM json_each(d.metadata) f WHERE f.key=? AND f.type=? AND f.value=?)");
      } else if (kind === "null") {
        conditions.push("EXISTS (SELECT 1 FROM json_each(d.metadata) f WHERE f.key=? AND f.type='null')");
      } else {
        params.push(parsed === true ? 1 : parsed === false ? 0 : parsed);
        const types = kind === "boolean" ? "'true','false'" : kind === "number" ? "'integer','real'" : "'text'";
        conditions.push(`EXISTS (SELECT 1 FROM json_each(d.metadata) f WHERE f.key=? AND f.type IN (${types}) AND f.value=?)`);
      }
    }
  }
  return `(${conditions.join(" AND ")})`;
}

function search(db: SqliteDb, request: SqliteVectorSearchRequest) {
  const { namespace, collection, space, vector, options } = request;
  const params: unknown[] = [namespace, collection, space];
  const filters: string[] = [];
  if (options?.where) filters.push(metadataMatch(options.where, params));
  if (options?.whereNot) filters.push(`NOT ${metadataMatch(options.whereNot, params)}`);
  params.push(vectorToBuffer(vector));
  const minimum = options?.minScore;
  const floor = minimum === undefined || Number.isNaN(minimum) ? "" : " AND score>=?";
  if (floor) params.push(minimum);
  const requested = options?.topK ?? 10;
  const limit = Number.isNaN(requested) ? 0 : Math.trunc(requested);
  const limitSql = !Number.isFinite(limit) ? (limit > 0 ? "-1" : "0") : limit < 0
    ? `max((SELECT count(*) FROM accepted) + ${limit},0)` : String(limit);
  const sql = `WITH population AS NOT MATERIALIZED (
      SELECT v.id,v.vec,d.metadata FROM _mirk_vector_values v
      JOIN _mirk_vector_documents d USING(namespace,collection,id)
      WHERE v.namespace=? AND v.collection=? AND v.space=? ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
    ), ranked AS MATERIALIZED (
      SELECT id,metadata,vec_cosine_similarity_f64(vec,?) score FROM population
    ), accepted AS MATERIALIZED (
      SELECT id,metadata,score FROM ranked WHERE score IS NOT NULL ${floor}
    ) SELECT id,score,metadata FROM accepted
      ORDER BY score DESC,id COLLATE BINARY LIMIT ${limitSql}`;
  return (db.prepare(sql).all(...params) as { id: string; score: number; metadata: string | null }[])
    .map(row => ({ id: row.id, score: row.score,
      metadata: row.metadata === null ? undefined : JSON.parse(row.metadata) as Record<string, unknown> }));
}

export function sqliteVecEngine(): SqliteVectorEngine {
  return {
    name: "sqlite-vec",
    initialize(db) {
      try {
        const extension = createRequire(import.meta.url)("@mirk/sqlite-vec-native") as { getLoadablePath(): string };
        db.loadExtension(extension.getLoadablePath());
        const row = db.prepare("SELECT vec_version() version,vec_cosine_similarity_f64(vec_f32('[1,0]'),vec_f32('[1,0]')) score").get() as {version:string;score:number};
        if (row.version !== "v0.1.6" || row.score !== 1) throw new Error("Expected Mirk sqlite-vec v0.1.6 with float64 cosine");
      } catch (cause) {
        throw new SqliteVecError("sqlite-vec initialization failed", { cause });
      }
    },
    search(db, request) {
      try { return search(db, request); }
      catch (cause) { throw new SqliteVecError("sqlite-vec search failed", { cause }); }
    },
  };
}
