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
  const blob = vectorToBuffer(vector);
  params.push(blob, blob, blob, vector.length);
  const minimum = options?.minScore;
  const floor = minimum === undefined || Number.isNaN(minimum) ? "" : " AND score>=?";
  if (floor) params.push(minimum);
  const requested = options?.topK ?? 10;
  const limit = Number.isNaN(requested) ? 0 : Math.trunc(requested);
  const limitSql = !Number.isFinite(limit) ? (limit > 0 ? "-1" : "0") : limit < 0
    ? `max((SELECT count(*) FROM accepted) + ${limit},0)` : String(limit);
  // Recursive accumulation uses the same ordered float64 additions as the port.
  // SQLite's SUM uses compensated arithmetic on some supported SQLite releases.
  // For n<=65536, u=2^-24 and g=gamma_(2n+4)+1e-22, the pinned
  // scalar cosine error is <=2g/(1-g)+2u+16(n+1)*2^-53 <16(n+1)u.
  // Native L2 norms in [1e-8,1e8] bound true norms in [0.5e-8,2e8]:
  // positive square sums have relative error <=gamma_(2n+4), plus
  // <=2n*2^-149 absolute underflow error. Consequently AB>=2.5e-17,
  // the relative underflow term is <1e-22, and overflow is impossible.
  // Cauchy bounds absolute dot-product error by g*AB; norm-product
  // relative error is <=g. Division gives 2g/(1-g), f32 distance
  // rounding adds <=2u, and the final term covers double arithmetic
  // including the port's ordered additions. Outside these proof
  // conditions [-2,2] includes every possible usable cosine score.
  // The kth largest lower bound is <=the true kth score. Every row
  // whose upper bound reaches it must be refined, including ties and
  // every unsafe row. These are proof conditions, never capacity limits.
  const epsilon = 16 * (vector.length + 1) * 2 ** -24;
  const coarseLimit = Number.isFinite(limit) && limit > 0 ? String(limit) : "-1";
  const sql = `WITH RECURSIVE
    population AS MATERIALIZED (
      SELECT v.id,v.vec,d.metadata FROM _mirk_vector_values v
      JOIN _mirk_vector_documents d USING(namespace,collection,id)
      WHERE v.namespace=? AND v.collection=? AND v.space=? ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
    ), query_norm AS MATERIALIZED (
      SELECT vec_distance_l2(?,zeroblob(${vector.byteLength})) norm
    ), coarse AS MATERIALIZED (
      SELECT p.*,1-vec_distance_cosine(p.vec,?) estimate,
        vec_distance_l2(p.vec,zeroblob(length(p.vec))) norm FROM population p
    ), bounds AS MATERIALIZED (
      SELECT c.*,
        CASE WHEN ${vector.length}<=65536 AND c.norm BETWEEN 1e-8 AND 1e8
          AND q.norm BETWEEN 1e-8 AND 1e8 AND c.estimate BETWEEN -2 AND 2
          THEN c.estimate-${epsilon} ELSE -2 END lower_score,
        CASE WHEN ${vector.length}<=65536 AND c.norm BETWEEN 1e-8 AND 1e8
          AND q.norm BETWEEN 1e-8 AND 1e8 AND c.estimate BETWEEN -2 AND 2
          THEN c.estimate+${epsilon} ELSE 2 END upper_score
      FROM coarse c CROSS JOIN query_norm q
    ), threshold AS (
      SELECT min(lower_score) value FROM
        (SELECT lower_score FROM bounds ORDER BY lower_score DESC LIMIT ${coarseLimit})
    ), candidates AS MATERIALIZED (
      SELECT b.id,b.vec,b.metadata FROM bounds b,threshold t
      WHERE b.upper_score>=t.value
    ), query_components AS MATERIALIZED (
      SELECT rowid pos,value FROM vec_each(?)
    ), components AS MATERIALIZED (
      SELECT c.id,a.rowid pos,a.value av,b.value bv
      FROM candidates c,vec_each(c.vec) a JOIN query_components b ON b.pos=a.rowid
    ), scores(id,pos,dot,an,bn,valid) AS (
      SELECT id,0,0.0,0.0,0.0,1 FROM candidates
      UNION ALL
      SELECT s.id,s.pos+1,s.dot+c.av*c.bv,s.an+c.av*c.av,s.bn+c.bv*c.bv,
        s.valid AND c.av IS NOT NULL AND abs(c.av)<=3.4028234663852886e38
          AND c.bv IS NOT NULL AND abs(c.bv)<=3.4028234663852886e38
      FROM scores s JOIN components c ON c.id=s.id AND c.pos=s.pos
    ), ranked AS MATERIALIZED (
      SELECT id,CASE WHEN bn=0 THEN 0.0 ELSE dot/(sqrt(an)*sqrt(bn)) END score FROM scores
      WHERE pos=? AND valid AND an>0 AND bn>=0
    ), accepted AS MATERIALIZED (
      SELECT id,score FROM ranked WHERE score IS NOT NULL ${floor}
    ) SELECT a.id,a.score,c.metadata FROM accepted a JOIN candidates c USING(id)
      ORDER BY a.score DESC,a.id COLLATE BINARY LIMIT ${limitSql}`;
  return (db.prepare(sql).all(...params) as { id: string; score: number; metadata: string | null }[])
    .map(row => ({ id: row.id, score: row.score,
      ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) as Record<string, unknown> }) }));
}

export function sqliteVecEngine(): SqliteVectorEngine {
  return {
    name: "sqlite-vec",
    initialize(db) {
      try {
        const extension = createRequire(import.meta.url)("sqlite-vec") as { getLoadablePath(): string };
        db.loadExtension(extension.getLoadablePath());
        const row = db.prepare("SELECT vec_version() version,sqrt(4.0) root").get() as {version:string;root:number};
        if (row.version !== "v0.1.6" || row.root !== 2) throw new Error("Expected sqlite-vec v0.1.6 and SQLite math functions");
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
