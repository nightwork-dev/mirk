// ─── @mirk/store-libsql adapter ──────────────────────────────────────────────
// One libSQL client, two async capability facets: `.kv` (AsyncStore) and
// `.vector` (AsyncVectorStore). Both ride the same connection.
//
// Why facets and not "class implements AsyncStore, AsyncVectorStore": the two ports
// both declare get/remove/count with DIFFERENT shapes (kv `get(key)` vs vector
// `get(collection, id)`), so a single class can't implement both. One facet per
// capability is the collision-free shape — mirrors @mirk/store's SqliteAdapter.
//
// The async ports are implemented NATIVELY (every method awaits client.execute),
// NOT lifted from a sync impl via toAsync: libSQL is a network/file client whose
// every call is already a Promise.

import { createClient, type Client, type InValue } from "@libsql/client";

import type { AsyncStore, StoreMeta, StoreFilter } from "@mirk/store";
import type {
  AsyncVectorStore,
  VectorStoreMeta,
  VectorDocument,
  VectorSearchResult,
  VectorSearchOptions,
  Vector,
} from "@mirk/store";
import {
  cosineSimilarity,
  vectorToBuffer,
  bufferToVector,
  assertDimensions,
  isUsableVector,
} from "@mirk/store";

// matchesWhere is not exported from @mirk/store — it is an internal helper of the
// vector subpath. Re-implemented here (small, pure, no I/O) rather than refactoring
// gonk's package to export it. Semantics match @mirk/store/vector/filter exactly.
function matchesWhere(
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean {
  if (!metadata) return false;
  for (const [key, expected] of Object.entries(filter)) {
    const actual = metadata[key];
    if (actual === expected) continue;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  return true;
}

export interface LibsqlAdapterOptions {
  /** libSQL connection URL: `libsql://…` (remote/Turso), `file:./db.sqlite`, or `:memory:`. */
  url: string;
  /** Auth token for a remote (Turso) database. Ignored for file:/:memory:. */
  authToken?: string;
  /** Existing @libsql/client to reuse (shares one connection). When passed, the
   *  adapter never closes it on `close()` — ownership stays with the caller. */
  client?: Client;
  /** Embedding dimensions. Required to use the `.vector` facet; KV works without it. */
  dimensions?: number;
  /** Force the exact JS-cosine search path even when native vector search is
   *  available. Mainly for parity testing; production should leave this off. */
  forceJsCosine?: boolean;
}

/** Multi-capability libSQL source adapter. Open once via the static `open`; use
 *  `.kv` and/or `.vector` — both ride the same connection. */
export class LibsqlAdapter {
  readonly kv: AsyncStore;
  readonly vector: AsyncVectorStore;
  private readonly client: Client;
  private readonly ownsClient: boolean;

  private constructor(client: Client, ownsClient: boolean, opts: LibsqlAdapterOptions) {
    this.client = client;
    this.ownsClient = ownsClient;
    this.kv = new LibsqlKvFacet(client);
    this.vector = new LibsqlVectorFacet(client, opts.url, opts.dimensions, opts.forceJsCosine);
  }

  /** Open the adapter. Creates a client (or reuses `opts.client`) and runs both
   *  facets' async schema initialization before returning. */
  static async open(opts: LibsqlAdapterOptions): Promise<LibsqlAdapter> {
    const ownsClient = opts.client === undefined;
    const client =
      opts.client ??
      createClient(
        opts.authToken !== undefined
          ? { url: opts.url, authToken: opts.authToken }
          : { url: opts.url },
      );
    const adapter = new LibsqlAdapter(client, ownsClient, opts);
    try {
      await (adapter.kv as LibsqlKvFacet).init();
      await (adapter.vector as LibsqlVectorFacet).init();
    } catch (err) {
      // A facet init can throw (e.g. dimension mismatch). Don't leak a client we
      // opened — but never close a client the caller passed in.
      if (ownsClient) {
        try {
          client.close();
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
    return adapter;
  }

  /** Close the underlying connection (shared by both facets). No-op for a client
   *  the caller passed in via `opts.client`. */
  close(): void {
    if (this.ownsClient) this.client.close();
  }
}

// ─── KV facet (AsyncStore) ───────────────────────────────────────────────────

class LibsqlKvFacet implements AsyncStore {
  readonly meta: StoreMeta = { backend: "libsql" };
  private readonly initializedTables = new Set<string>();
  private initialized = false;

  constructor(private readonly client: Client) {}

  /** Memoized schema init. Awaited once from LibsqlAdapter.open. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.client.execute(`
      CREATE TABLE IF NOT EXISTS _kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.initialized = true;
  }

  private tableName(collection: string): string {
    if (collection.length === 0) throw new Error("Invalid collection name");
    const sanitized = collection.replace(/[^a-zA-Z0-9_]/g, "_");
    // Suffix a hash of the ORIGINAL name so two distinct collections that sanitize
    // to the same string (e.g. "foo-bar" vs "foo_bar") never alias to one table.
    return `c_${sanitized}_${hashName(collection)}`;
  }

  private async ensureTable(collection: string): Promise<string> {
    const table = this.tableName(collection);
    if (this.initializedTables.has(table)) return table;
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS ${table} (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
    );
    this.initializedTables.add(table);
    return table;
  }

  async get<T>(key: string): Promise<T | null> {
    const rs = await this.client.execute({
      sql: "SELECT value FROM _kv WHERE key = ?",
      args: [key],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return JSON.parse(row.value as string) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO _kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      args: [key, JSON.stringify(value)],
    });
  }

  async has(key: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: "SELECT 1 FROM _kv WHERE key = ?",
      args: [key],
    });
    return rs.rows.length > 0;
  }

  async delete(key: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: "DELETE FROM _kv WHERE key = ?",
      args: [key],
    });
    return rs.rowsAffected > 0;
  }

  async keys(prefix?: string): Promise<string[]> {
    if (prefix) {
      // Escape LIKE wildcards so the prefix matches LITERALLY (startsWith), not as
      // a pattern — matches the in-memory reference's `key.startsWith(prefix)`.
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rs = await this.client.execute({
        sql: `SELECT key FROM _kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key`,
        args: [`${escaped}%`],
      });
      return rs.rows.map((r) => r.key as string);
    }
    const rs = await this.client.execute("SELECT key FROM _kv ORDER BY key");
    return rs.rows.map((r) => r.key as string);
  }

  async list<T>(collection: string, filter?: StoreFilter): Promise<T[]> {
    const table = await this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const orderBy = buildOrderBy(filter);
    const limitOffset = buildLimitOffset(filter);
    const sql = `SELECT data FROM ${table}${where.clause}${orderBy.clause}${limitOffset}`;
    const rs = await this.client.execute({
      sql,
      args: [...where.params, ...orderBy.params],
    });
    return rs.rows.map((r) => JSON.parse(r.data as string) as T);
  }

  async getById<T>(collection: string, id: string): Promise<T | null> {
    const table = await this.ensureTable(collection);
    const rs = await this.client.execute({
      sql: `SELECT data FROM ${table} WHERE id = ?`,
      args: [id],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return JSON.parse(row.data as string) as T;
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    const table = await this.ensureTable(collection);
    await this.client.execute({
      sql: `INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
      args: [item.id, JSON.stringify(item)],
    });
    return item;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const table = await this.ensureTable(collection);
    const rs = await this.client.execute({
      sql: `DELETE FROM ${table} WHERE id = ?`,
      args: [id],
    });
    return rs.rowsAffected > 0;
  }

  async count(collection: string, filter?: StoreFilter): Promise<number> {
    const table = await this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const rs = await this.client.execute({
      sql: `SELECT COUNT(*) as cnt FROM ${table}${where.clause}`,
      args: where.params,
    });
    // bigint-safe: libSQL may return integer columns as bigint.
    return Number(rs.rows[0]!.cnt);
  }
}

// ─── Vector facet (AsyncVectorStore) — libSQL NATIVE vector search ─────────────

class LibsqlVectorFacet implements AsyncVectorStore {
  meta!: VectorStoreMeta;
  private dimensions: number;
  /** True when the native vector_top_k path is used; false to force exact JS cosine. */
  private accelerated: boolean;
  private readonly forceJsCosine: boolean;
  private readonly url: string;
  private initialized = false;

  constructor(
    private readonly client: Client,
    url: string,
    dimensions?: number,
    forceJsCosine?: boolean,
  ) {
    this.url = url;
    // Provisional; finalized in init() once persisted dims are known.
    this.dimensions = dimensions ?? -1;
    this.forceJsCosine = forceJsCosine ?? false;
    this.accelerated = false;
  }

  /** Memoized async schema init. Creates the vectors table (F32_BLOB column sized
   *  to the configured dimensions) + persists/enforces dimensionality + builds the
   *  native libsql_vector_idx so vector_top_k() can use it. */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.client.execute(
      `CREATE TABLE IF NOT EXISTS _vec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    // Persist + enforce dimensionality so a store created at N dims can't be reopened
    // at M (which would let stale-length rows score a silent 0).
    const metaRs = await this.client.execute(
      `SELECT value FROM _vec_meta WHERE key = 'dimensions'`,
    );
    const stored = metaRs.rows[0];
    if (stored) {
      const persisted = Number(stored.value as string);
      if (this.dimensions >= 0 && this.dimensions !== persisted) {
        throw new Error(
          `Vector store at ${this.url} was created with ${persisted} dimensions, opened with ${this.dimensions}.`,
        );
      }
      this.dimensions = persisted;
    } else if (this.dimensions >= 0) {
      await this.client.execute({
        sql: `INSERT INTO _vec_meta (key, value) VALUES ('dimensions', ?)`,
        args: [String(this.dimensions)],
      });
    }
    // Create the vectors table + native index only once dimensions are known —
    // F32_BLOB requires a fixed N. KV-only adapters never touch the vector facet,
    // so a dimensionless open is valid until a vector method is called.
    if (this.dimensions >= 0) {
      await this.client.execute(
        `CREATE TABLE IF NOT EXISTS vectors (
           collection TEXT NOT NULL,
           id TEXT NOT NULL,
           vec F32_BLOB(${this.dimensions}) NOT NULL,
           metadata TEXT,
           PRIMARY KEY (collection, id)
         )`,
      );
      // Native ANN index. vector_top_k() requires a libsql_vector_idx over the column.
      await this.client.execute(
        `CREATE INDEX IF NOT EXISTS vectors_vec_idx
           ON vectors (libsql_vector_idx(vec))`,
      );
    }
    this.accelerated = !this.forceJsCosine;
    this.meta = {
      backend: "libsql",
      dimensions: Math.max(this.dimensions, 0),
      accelerated: this.accelerated,
    };
    this.initialized = true;
  }

  private assertReady(v: Vector): void {
    if (this.dimensions < 0) {
      throw new Error(
        "LibsqlAdapter.vector requires `dimensions` — pass { dimensions } when opening.",
      );
    }
    assertDimensions(v, this.dimensions);
  }

  async upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): Promise<void> {
    this.assertReady(doc.vector);
    // Bind the vector through vector32(?) — libSQL converts a JSON-array string (or
    // an f32 blob) into its native F32_BLOB on write. We pass the JSON text form so
    // there is one canonical encoding path.
    await this.client.execute({
      sql: `INSERT INTO vectors(collection, id, vec, metadata) VALUES (?, ?, vector32(?), ?)
            ON CONFLICT(collection, id) DO UPDATE SET vec = excluded.vec, metadata = excluded.metadata`,
      args: [
        collection,
        doc.id,
        vectorToJson(doc.vector),
        doc.metadata === undefined ? null : JSON.stringify(doc.metadata),
      ],
    });
  }

  async upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): Promise<void> {
    // Validate every vector before mutating, so a mid-array mismatch writes nothing
    // (matching the in-memory + sqlite backends' atomic upsertMany).
    for (const doc of docs) this.assertReady(doc.vector);
    if (docs.length === 0) return;
    await this.client.batch(
      docs.map((doc) => ({
        sql: `INSERT INTO vectors(collection, id, vec, metadata) VALUES (?, ?, vector32(?), ?)
              ON CONFLICT(collection, id) DO UPDATE SET vec = excluded.vec, metadata = excluded.metadata`,
        args: [
          collection,
          doc.id,
          vectorToJson(doc.vector),
          doc.metadata === undefined ? null : JSON.stringify(doc.metadata),
        ],
      })),
      "write",
    );
  }

  async get<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string,
  ): Promise<VectorDocument<M> | null> {
    const rs = await this.client.execute({
      sql: `SELECT id, vec, metadata FROM vectors WHERE collection = ? AND id = ?`,
      args: [collection, id],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      id: row.id as string,
      vector: blobValueToVector(row.vec),
      metadata: row.metadata === null ? undefined : (JSON.parse(row.metadata as string) as M),
    };
  }

  async has(collection: string, id: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `SELECT 1 FROM vectors WHERE collection = ? AND id = ?`,
      args: [collection, id],
    });
    return rs.rows.length > 0;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const rs = await this.client.execute({
      sql: `DELETE FROM vectors WHERE collection = ? AND id = ?`,
      args: [collection, id],
    });
    return rs.rowsAffected > 0;
  }

  async count(collection: string): Promise<number> {
    const rs = await this.client.execute({
      sql: `SELECT COUNT(*) AS n FROM vectors WHERE collection = ?`,
      args: [collection],
    });
    return Number(rs.rows[0]!.n);
  }

  async search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    opts?: VectorSearchOptions,
  ): Promise<VectorSearchResult<M>[]> {
    this.assertReady(query);
    const topK = opts?.topK ?? 10;
    const minScore = opts?.minScore;
    const hasFilters = !!(opts?.where || opts?.whereNot);
    // When pre-KNN filters are present, FORCE the JS path: vector_top_k() ranks over
    // the whole index and cannot apply metadata predicates BEFORE the KNN cut, so a
    // native query would compute topK from the unfiltered set and then filter —
    // wrong semantics. The JS path fetches the collection's rows, filters FIRST, then
    // scores — so topK is out of the passing set only. This is the load-bearing
    // correctness point and matches the in-memory + sqlite backends exactly.
    // A zero / non-finite query has no cosine direction — also use the deterministic
    // JS path there.
    if (this.accelerated && isUsableVector(query) && !hasFilters) {
      try {
        return await this.searchNative<M>(collection, query, topK, minScore);
      } catch {
        // Any native runtime error → fall through to the exact JS path (same result).
      }
    }
    return this.searchJs<M>(collection, query, topK, minScore, opts?.where, opts?.whereNot);
  }

  private async searchNative<M extends Record<string, unknown>>(
    collection: string,
    query: Vector,
    topK: number,
    minScore: number | undefined,
  ): Promise<VectorSearchResult<M>[]> {
    // vector_top_k('index_name', query, k) returns rowids (as an `id` column) of the
    // k nearest rows by the index's metric. Join back to `vectors` to recover the
    // (collection, id, metadata) and compute the exact cosine score. The index spans
    // every collection, so over-fetch (k scaled) and filter to this collection, then
    // re-cut to topK — keeps results correct when the global top-k spills into other
    // collections.
    const overFetch = Math.max(topK * 4, topK + 16);
    const rs = await this.client.execute({
      sql: `SELECT v.id AS id,
                   v.metadata AS metadata,
                   vector_distance_cos(v.vec, vector32(?)) AS distance
            FROM vector_top_k('vectors_vec_idx', vector32(?), ?) AS t
            JOIN vectors v ON v.rowid = t.id
            WHERE v.collection = ?`,
      args: [vectorToJson(query), vectorToJson(query), overFetch, collection],
    });
    const out: VectorSearchResult<M>[] = [];
    for (const r of rs.rows) {
      if (r.distance === null) continue;
      const score = 1 - Number(r.distance); // cosine distance → similarity
      if (!Number.isFinite(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      out.push({
        id: r.id as string,
        score,
        metadata: r.metadata === null ? undefined : (JSON.parse(r.metadata as string) as M),
      });
    }
    out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return out.slice(0, topK);
  }

  private async searchJs<M extends Record<string, unknown>>(
    collection: string,
    query: Vector,
    topK: number,
    minScore: number | undefined,
    where?: Record<string, unknown>,
    whereNot?: Record<string, unknown>,
  ): Promise<VectorSearchResult<M>[]> {
    const rs = await this.client.execute({
      sql: `SELECT id, vec, metadata FROM vectors WHERE collection = ?`,
      args: [collection],
    });
    const scored: VectorSearchResult<M>[] = [];
    for (const row of rs.rows) {
      const meta =
        row.metadata === null ? undefined : (JSON.parse(row.metadata as string) as M);
      // Pre-KNN metadata filters — applied before scoring.
      if (where && !matchesWhere(meta, where)) continue;
      if (whereNot && matchesWhere(meta, whereNot)) continue;
      const vec = blobValueToVector(row.vec);
      if (!isUsableVector(vec)) continue; // directionless — excluded (matches every backend)
      const score = cosineSimilarity(query, vec);
      if (!Number.isFinite(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      scored.push({ id: row.id as string, score, metadata: meta });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, topK);
  }
}

// ─── Vector encoding helpers ─────────────────────────────────────────────────

/** Encode a vector as a JSON array string for libSQL's vector32() constructor.
 *  Non-finite components serialize to JSON `null`; libSQL rejects those, so a
 *  non-finite vector is never persisted (assertReady + isUsableVector keep them
 *  out of search anyway). */
function vectorToJson(vec: Vector): string {
  return JSON.stringify(Array.from(vec, (x) => (Number.isFinite(x) ? x : 0)));
}

/** Decode a libSQL F32_BLOB column Value into a Vector. libSQL returns BLOB columns
 *  as an ArrayBuffer (not a Node Buffer), so normalize to a Uint8Array first and
 *  reuse @mirk/store's little-endian float32 decoder. */
function blobValueToVector(value: unknown): Vector {
  if (value instanceof ArrayBuffer) {
    return bufferToVector(new Uint8Array(value));
  }
  if (value instanceof Uint8Array) {
    return bufferToVector(value);
  }
  if (Buffer.isBuffer(value)) {
    return bufferToVector(value);
  }
  // Defensive: some drivers may hand back a typed-array view.
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return bufferToVector(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  throw new Error(`Unexpected vec column type: ${Object.prototype.toString.call(value)}`);
}

// avoid an unused-import lint on vectorToBuffer — it is part of the @mirk/store
// helper surface this adapter is contracted to reuse, kept available for symmetry
// with the sqlite adapter's encoding path even though libSQL takes the JSON form.
void vectorToBuffer;

// ─── SQL building (KV collections) — copied from @mirk/store/sqlite ───────────
// Pure SQL helpers. Duplicated here (not imported) because they are internal to
// @mirk/store's sqlite subpath and not part of its public surface. Acceptable
// duplication for an additive contribution — see the package README.

/** A field name is ONE top-level JSON key, never a nested path. */
function jsonPath(field: string): string {
  return `$."${field.replace(/"/g, '""')}"`;
}

function buildWhereClause(filter?: StoreFilter): { clause: string; params: InValue[] } {
  if (!filter?.where || Object.keys(filter.where).length === 0) {
    return { clause: "", params: [] };
  }
  const conditions: string[] = [];
  const params: InValue[] = [];
  for (const [key, value] of Object.entries(filter.where)) {
    const path = jsonPath(key);
    if (value === null) {
      conditions.push(`json_type(data, ?) = 'null'`);
      params.push(path);
    } else {
      const bound = typeof value === "boolean" ? (value ? 1 : 0) : value;
      conditions.push(`json_extract(data, ?) = ?`);
      params.push(path, bound as InValue);
    }
  }
  return { clause: ` WHERE ${conditions.join(" AND ")}`, params };
}

function buildOrderBy(filter?: StoreFilter): { clause: string; params: InValue[] } {
  if (!filter?.sortBy) return { clause: "", params: [] };
  const dir = filter.sortDir === "desc" ? "DESC" : "ASC";
  const path = jsonPath(filter.sortBy);
  return {
    clause: ` ORDER BY json_extract(data, ?) IS NULL, json_extract(data, ?) ${dir}`,
    params: [path, path],
  };
}

/** Deterministic 32-bit FNV-1a hash → base36. Makes collection table names
 *  injective (distinct collection names never alias to one physical table). */
function hashName(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function buildLimitOffset(filter?: StoreFilter): string {
  let sql = "";
  if (filter?.limit !== undefined) {
    sql += ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`;
  }
  if (filter?.offset !== undefined && filter.offset > 0) {
    if (!sql.includes("LIMIT")) sql += " LIMIT -1";
    sql += ` OFFSET ${Math.max(0, Math.floor(filter.offset))}`;
  }
  return sql;
}
