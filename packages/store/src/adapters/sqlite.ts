// ─── @mirk/store/sqlite ─────────────────────────────────────────────────────
// The sqlite SOURCE ADAPTER. One better-sqlite3 connection, multiple capability
// facets: `.kv` is a SyncStore (KV + collections), `.vector` is a VectorStore.
//
// Why facets and not "class implements SyncStore, VectorStore": the two ports
// both declare get/remove/count with DIFFERENT shapes (kv `get(key)` vs vector
// `get(collection, id)`), so a single class can't implement both. A multi-
// capability handle exposing one facet per capability is the collision-free
// shape — and it's exactly how one source (SurrealDB: kv + vector + blob +
// graph) serves many capabilities over one connection.
//
// better-sqlite3 is the ONLY native reference in @mirk/store, reachable solely
// through this subpath. Vector search uses sqlite-vec (vec0, cosine metric) when
// the optional sqlite-vec peer is installed (meta.accelerated=true), else an exact
// JS-cosine fallback with identical rankings (meta.accelerated=false).

import Database from 'better-sqlite3';

import type { SyncStore, StoreMeta, StoreFilter } from '../types.js';
import type {
  VectorStore,
  VectorStoreMeta,
  VectorDocument,
  VectorSearchResult,
  VectorSearchOptions,
  Vector,
} from '../vector/types.js';
import { matchesWhere } from '../vector/filter.js';
import {
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
  assertDimensions,
  isUsableVector,
} from '../vector/cosine.js';
import { buildWhereClause, buildOrderBy, buildLimitOffset, hashName } from '../sql.js';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/** Try to load the sqlite-vec extension into a connection. Optional + graceful:
 *  returns false (no acceleration) on any failure — not installed, ABI mismatch,
 *  or loadExtension disabled. Synchronous via createRequire (the adapter ctor is
 *  sync); sqlite-vec is a string require, so the bundler leaves it external. */
function tryLoadSqliteVec(db: Database.Database): boolean {
  try {
    const vec = nodeRequire('sqlite-vec') as {
      load?: (db: Database.Database) => void;
      getLoadablePath?: () => string;
    };
    if (typeof vec.load === 'function') {
      vec.load(db);
      return true;
    }
    if (typeof vec.getLoadablePath === 'function') {
      db.loadExtension(vec.getLoadablePath());
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface SqliteAdapterOptions {
  /** Path to the SQLite database file. Use ":memory:" for in-memory. */
  path: string;
  /** Existing better-sqlite3 instance to reuse (shares one connection). */
  db?: Database.Database;
  /** Embedding dimensions. Required to use the `.vector` facet; KV works without it. */
  dimensions?: number;
  /** Force the exact JS-cosine search path even when sqlite-vec is installed.
   *  Mainly for parity testing; production should leave this off. */
  forceJsCosine?: boolean;
}

/** Multi-capability sqlite source adapter. Open once; use `.kv` and/or `.vector`
 *  — both ride the same connection. */
export class SqliteAdapter {
  private readonly db: Database.Database;
  readonly kv!: SyncStore;
  readonly vector!: VectorStore;

  constructor(opts: SqliteAdapterOptions) {
    const ownsDb = opts.db === undefined;
    this.db = opts.db ?? new Database(opts.path);
    try {
      this.db.pragma('journal_mode = WAL');
      this.kv = new SqliteKvFacet(this.db);
      this.vector = new SqliteVectorFacet(this.db, opts.path, opts.dimensions, opts.forceJsCosine);
    } catch (err) {
      // A facet constructor can throw (e.g. dimension mismatch). Don't leak the
      // connection we opened — but never close a db handle the caller passed in.
      if (ownsDb) {
        try {
          this.db.close();
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  }

  /** Close the underlying connection (shared by both facets). */
  close(): void {
    this.db.close();
  }
}

// ─── KV facet (SyncStore) ────────────────────────────────────────────────────

class SqliteKvFacet implements SyncStore {
  readonly meta: StoreMeta = { backend: 'sqlite' };
  private readonly initializedTables = new Set<string>();

  constructor(private readonly db: Database.Database) {
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
  }

  private tableName(collection: string): string {
    if (collection.length === 0) throw new Error('Invalid collection name');
    const sanitized = collection.replace(/[^a-zA-Z0-9_]/g, '_');
    // Suffix a hash of the ORIGINAL name so two distinct collections that sanitize
    // to the same string (e.g. "foo-bar" vs "foo_bar") never alias to one table.
    return `c_${sanitized}_${hashName(collection)}`;
  }

  private ensureTable(collection: string): string {
    const table = this.tableName(collection);
    if (this.initializedTables.has(table)) return table;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        data JSON NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
    );
    this.initializedTables.add(table);
    return table;
  }

  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM _kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (!row) return null;
    return JSON.parse(row.value) as T;
  }

  set<T>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO _kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(key, JSON.stringify(value));
  }

  has(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM _kv WHERE key = ?').get(key) !== undefined;
  }

  delete(key: string): boolean {
    return this.db.prepare('DELETE FROM _kv WHERE key = ?').run(key).changes > 0;
  }

  keys(prefix?: string): string[] {
    if (prefix) {
      // Escape LIKE wildcards so the prefix matches LITERALLY (startsWith), not as
      // a pattern — matches the in-memory reference's `key.startsWith(prefix)`.
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rows = this.db
        .prepare(`SELECT key FROM _kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key`)
        .all(`${escaped}%`) as { key: string }[];
      return rows.map((r) => r.key);
    }
    const rows = this.db.prepare('SELECT key FROM _kv ORDER BY key').all() as { key: string }[];
    return rows.map((r) => r.key);
  }

  list<T>(collection: string, filter?: StoreFilter): T[] {
    const table = this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const orderBy = buildOrderBy(filter);
    const limitOffset = buildLimitOffset(filter);
    const sql = `SELECT data FROM ${table}${where.clause}${orderBy.clause}${limitOffset}`;
    const rows = this.db.prepare(sql).all(...where.params, ...orderBy.params) as {
      data: string;
    }[];
    return rows.map((r) => JSON.parse(r.data) as T);
  }

  getById<T>(collection: string, id: string): T | null {
    const table = this.ensureTable(collection);
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as
      | { data: string }
      | undefined;
    if (!row) return null;
    return JSON.parse(row.data) as T;
  }

  put<T extends { id: string }>(collection: string, item: T): T {
    const table = this.ensureTable(collection);
    this.db
      .prepare(
        `INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
      )
      .run(item.id, JSON.stringify(item));
    return item;
  }

  remove(collection: string, id: string): boolean {
    const table = this.ensureTable(collection);
    return this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
  }

  count(collection: string, filter?: StoreFilter): number {
    const table = this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) as cnt FROM ${table}${where.clause}`)
      .get(...where.params) as { cnt: number };
    return row.cnt;
  }
}

// ─── Vector facet (VectorStore) ──────────────────────────────────────────────

interface VectorRow {
  id: string;
  vec: Buffer;
  metadata: string | null;
}

class SqliteVectorFacet implements VectorStore {
  readonly meta: VectorStoreMeta;
  private readonly dimensions: number;
  /** True when sqlite-vec loaded and the vec0 acceleration path is live. */
  private readonly accelerated: boolean;
  private readonly vecTablesEnsured = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    path: string,
    dimensions?: number,
    forceJsCosine?: boolean,
  ) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS vectors (
         collection TEXT NOT NULL,
         id TEXT NOT NULL,
         vec BLOB NOT NULL,
         metadata TEXT,
         PRIMARY KEY (collection, id)
       );
       CREATE INDEX IF NOT EXISTS vectors_collection ON vectors(collection);
       CREATE TABLE IF NOT EXISTS _vec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
    );
    // Persist + enforce dimensionality so a store created at N dims can't be
    // reopened at M (which would let stale-length rows score a silent 0).
    const stored = this.db
      .prepare(`SELECT value FROM _vec_meta WHERE key = 'dimensions'`)
      .get() as { value: string } | undefined;
    if (stored) {
      this.dimensions = Number(stored.value);
      if (dimensions !== undefined && dimensions !== this.dimensions) {
        throw new Error(
          `Vector store at ${path} was created with ${this.dimensions} dimensions, opened with ${dimensions}.`,
        );
      }
    } else if (dimensions !== undefined) {
      this.dimensions = dimensions;
      this.db
        .prepare(`INSERT INTO _vec_meta (key, value) VALUES ('dimensions', ?)`)
        .run(String(dimensions));
    } else {
      // No dimensions configured and none persisted — the vector facet is unusable
      // until one is provided. KV-only adapters never touch these methods.
      this.dimensions = -1;
    }
    // Optional vec0 acceleration: load sqlite-vec unless forced off and dims are set.
    // Any failure leaves the exact JS-cosine path (results are identical — see search).
    this.accelerated = !forceJsCosine && this.dimensions >= 0 && tryLoadSqliteVec(this.db);
    this.meta = {
      backend: 'sqlite',
      dimensions: Math.max(this.dimensions, 0),
      accelerated: this.accelerated,
    };
  }

  private requireDims(v: Vector): void {
    if (this.dimensions < 0) {
      throw new Error('SqliteAdapter.vector requires `dimensions` — pass { dimensions } when opening.');
    }
    assertDimensions(v, this.dimensions);
  }

  // ── vec0 acceleration helpers ───────────────────────────────────────────
  private vecTableName(collection: string): string {
    return `vectors_vec_${collection.replace(/[^a-zA-Z0-9_]/g, '_')}_${hashName(collection)}`;
  }

  private ensureVecTable(collection: string): string {
    const table = this.vecTableName(collection);
    if (this.vecTablesEnsured.has(table)) return table;
    // cosine metric (NOT vec0's L2 default) so rankings match the exact JS cosine path.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(embedding float[${this.dimensions}] distance_metric=cosine)`,
    );
    this.vecTablesEnsured.add(table);
    // Backfill any vectors written while sqlite-vec was unavailable (a prior fallback
    // session, or before the peer was installed) so accelerated search is complete.
    const existing = this.db
      .prepare(`SELECT rowid, vec FROM vectors WHERE collection = ?`)
      .all(collection) as Array<{ rowid: number; vec: Buffer }>;
    if (existing.length > 0) {
      const del = this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`);
      const ins = this.db.prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`);
      const backfill = this.db.transaction(() => {
        for (const r of existing) {
          const rid = BigInt(r.rowid);
          del.run(rid);
          if (isUsableVector(bufferToVector(r.vec))) ins.run(rid, r.vec);
        }
      });
      backfill();
    }
    return table;
  }

  /** Keep a (collection,id)'s vec0 row in sync. vec0 is keyed by the vectors row's
   *  rowid (stable under ON CONFLICT DO UPDATE); the rowid binds as BigInt. */
  private syncVec(collection: string, id: string, vector: Vector): void {
    const table = this.ensureVecTable(collection);
    const row = this.db
      .prepare(`SELECT rowid FROM vectors WHERE collection = ? AND id = ?`)
      .get(collection, id) as { rowid: number } | undefined;
    if (!row) return;
    const rid = BigInt(row.rowid);
    this.db.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(rid);
    // Zero / non-finite vectors have no cosine direction — keep them OUT of vec0
    // (the JS path excludes them too) so the two paths stay in parity.
    if (isUsableVector(vector)) {
      this.db
        .prepare(`INSERT INTO ${table}(rowid, embedding) VALUES (?, ?)`)
        .run(rid, vectorToBuffer(vector));
    }
  }

  upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): void {
    this.requireDims(doc.vector);
    // Atomic: the base-table write and the vec0 sync must not desync on a crash.
    // (Nested inside upsertMany's transaction → savepoint, which is fine.)
    const write = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO vectors(collection, id, vec, metadata) VALUES (?, ?, ?, ?)
           ON CONFLICT(collection, id) DO UPDATE SET vec = excluded.vec, metadata = excluded.metadata`,
        )
        .run(
          collection,
          doc.id,
          vectorToBuffer(doc.vector),
          doc.metadata === undefined ? null : JSON.stringify(doc.metadata),
        );
      if (this.accelerated) this.syncVec(collection, doc.id, doc.vector);
    });
    write();
  }

  upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): void {
    const tx = this.db.transaction((items: ReadonlyArray<VectorDocument<M>>) => {
      for (const doc of items) this.upsert(collection, doc);
    });
    tx(docs);
  }

  get<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string,
  ): VectorDocument<M> | null {
    const row = this.db
      .prepare(`SELECT id, vec, metadata FROM vectors WHERE collection = ? AND id = ?`)
      .get(collection, id) as VectorRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      vector: bufferToVector(row.vec),
      metadata: row.metadata === null ? undefined : (JSON.parse(row.metadata) as M),
    };
  }

  has(collection: string, id: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM vectors WHERE collection = ? AND id = ?`)
        .get(collection, id) !== undefined
    );
  }

  remove(collection: string, id: string): boolean {
    if (this.accelerated) {
      const row = this.db
        .prepare(`SELECT rowid FROM vectors WHERE collection = ? AND id = ?`)
        .get(collection, id) as { rowid: number } | undefined;
      if (row) {
        this.db
          .prepare(`DELETE FROM ${this.ensureVecTable(collection)} WHERE rowid = ?`)
          .run(BigInt(row.rowid));
      }
    }
    return (
      this.db.prepare(`DELETE FROM vectors WHERE collection = ? AND id = ?`).run(collection, id)
        .changes > 0
    );
  }

  count(collection: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM vectors WHERE collection = ?`)
      .get(collection) as { n: number };
    return row.n;
  }

  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    opts?: VectorSearchOptions,
  ): VectorSearchResult<M>[] {
    this.requireDims(query);
    const topK = opts?.topK ?? 10;
    const minScore = opts?.minScore;
    const hasFilters = !!(opts?.where || opts?.whereNot);
    // When pre-KNN filters are present, use the JS path: metadata lives on the main
    // `vectors` table (not in vec0), so the accelerated path can't apply them before
    // scoring. The JS path fetches all rows and filters first — correct semantics,
    // identical results to the in-memory backend.
    // A zero / non-finite query has no cosine direction (vec0's behavior there is
    // backend-defined) — also use the deterministic JS path in that case.
    if (this.accelerated && isUsableVector(query) && !hasFilters) {
      try {
        return this.searchVec<M>(collection, query, topK, minScore);
      } catch {
        // Any vec runtime error → fall through to the exact JS path (same result).
      }
    }
    return this.searchJs<M>(collection, query, topK, minScore, opts?.where, opts?.whereNot);
  }

  private searchVec<M extends Record<string, unknown>>(
    collection: string,
    query: Vector,
    topK: number,
    minScore: number | undefined,
  ): VectorSearchResult<M>[] {
    const table = this.ensureVecTable(collection);
    const rows = this.db
      .prepare(
        `SELECT v.id AS id, v.metadata AS metadata, vv.distance AS distance
         FROM ${table} vv JOIN vectors v ON v.rowid = vv.rowid
         WHERE vv.embedding MATCH ? ORDER BY vv.distance LIMIT ?`,
      )
      .all(vectorToBuffer(query), topK) as Array<{
      id: string;
      metadata: string | null;
      distance: number;
    }>;
    const out: VectorSearchResult<M>[] = [];
    for (const r of rows) {
      if (r.distance === null) continue; // a directionless (zero) vector — excluded
      const score = 1 - r.distance; // cosine distance → similarity; matches the JS path
      if (!Number.isFinite(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      out.push({
        id: r.id,
        score,
        metadata: r.metadata === null ? undefined : (JSON.parse(r.metadata) as M),
      });
    }
    out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return out;
  }

  private searchJs<M extends Record<string, unknown>>(
    collection: string,
    query: Vector,
    topK: number,
    minScore: number | undefined,
    where?: Record<string, unknown>,
    whereNot?: Record<string, unknown>,
  ): VectorSearchResult<M>[] {
    const rows = this.db
      .prepare(`SELECT id, vec, metadata FROM vectors WHERE collection = ?`)
      .all(collection) as VectorRow[];
    const scored: VectorSearchResult<M>[] = [];
    for (const row of rows) {
      const meta = row.metadata === null ? undefined : (JSON.parse(row.metadata) as M);
      // Pre-KNN metadata filters — applied before scoring.
      if (where && !matchesWhere(meta, where)) continue;
      if (whereNot && matchesWhere(meta, whereNot)) continue;
      const vec = bufferToVector(row.vec);
      if (!isUsableVector(vec)) continue; // directionless — excluded (matches the vec0 path)
      const score = cosineSimilarity(query, vec);
      if (!Number.isFinite(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      scored.push({ id: row.id, score, metadata: meta });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, topK);
  }
}

// SQL building (jsonPath / buildWhereClause / buildOrderBy / buildLimitOffset /
// hashName) lives in ../sql.ts — shared verbatim with @mirk/store-libsql so the
// two SQLite-dialect adapters can't drift in filter semantics. See that module.
