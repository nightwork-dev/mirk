import type { AsyncVectorStore, VectorDocument, VectorQuery, VectorSearchOptions, VectorSearchResult, VectorSpace, VectorSpaceOptions, VectorStoreMeta } from "@mirk/store/vector";
import { assertDimensions, compareCodePoints, isUsableVector, VectorInputError } from "@mirk/store/vector";
import { firstStatement } from "./internal/query-result.js";

export interface SurrealConnection {
  query<T>(surql: string, bindings?: Record<string, unknown>): Promise<T>;
}

export interface SurrealVectorOptions {
  namespace?: string;
  documentsTable?: string;
  spacesTable?: string;
  dimensionsTable?: string;
}

interface VectorRow {
  doc_id: string;
  vectors: Record<string, number[]>;
  metadata?: Record<string, unknown>;
  has_metadata?: boolean;
}

export type SurrealVectorErrorCode = "invalid-top-k" | "invalid-vector" | "invalid-identifier" | "migration-conflict";
export class SurrealVectorError extends Error {
  constructor(readonly code: SurrealVectorErrorCode, message: string) { super(message); }
}
Object.defineProperty(SurrealVectorError.prototype, "name", { value: "SurrealVectorError", configurable: true });

export class SurrealVectorAdapter implements AsyncVectorStore {
  readonly meta: VectorStoreMeta = { backend: "surreal", accelerated: true };
  private constructor(
    private readonly connection: SurrealConnection,
    private readonly documentsTable: string,
    private readonly spacesTable: string,
    private readonly namespace: string,
  ) {}

  static async open(connection: SurrealConnection, options: SurrealVectorOptions = {}): Promise<SurrealVectorAdapter> {
    const adapter = new SurrealVectorAdapter(connection, tableName(options.documentsTable ?? "mirk_vector_documents"), tableName(options.spacesTable ?? "mirk_vector_spaces"), options.namespace ?? "default");
    await adapter.init(tableName(options.dimensionsTable ?? "mirk_vector_dimensions"));
    return adapter;
  }

  async listSpaces(): Promise<VectorSpace[]> {
    const rows = await this.rows<VectorSpace>(`SELECT name, dimensions, metric, encoding FROM ${this.spacesTable} WHERE namespace = $namespace`, { namespace: this.namespace });
    return rows.sort((a, b) => compareCodePoints(a.name, b.name));
  }

  async ensureSpace(name: string, options: VectorSpaceOptions): Promise<void> {
    if (!name) throw new VectorInputError("invalid-space", "Space name must be nonempty");
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) throw new VectorInputError("invalid-dimensions", "Dimensions must be a positive integer");
    const check = async (): Promise<boolean> => {
      const existing = (await this.listSpaces()).find((space) => space.name === name);
      if (existing === undefined) return false;
      if (existing.dimensions !== options.dimensions) throw new VectorInputError("space-definition-conflict", `Space ${name} already has ${existing.dimensions} dimensions`);
      return true;
    };
    if (await check()) return;
    try {
      await this.connection.query(`CREATE ${this.spacesTable} CONTENT $space`, { space: { namespace: this.namespace, name, dimensions: options.dimensions, metric: "cosine", encoding: "float32" } });
    } catch (error) {
      if (!(await check())) throw error;
    }
  }

  async upsert<M extends Record<string, unknown>>(collection: string, doc: VectorDocument<M>): Promise<void> {
    await this.upsertMany(collection, [doc]);
  }

  async upsertMany<M extends Record<string, unknown>>(collection: string, docs: ReadonlyArray<VectorDocument<M>>): Promise<void> {
    const spaces = new Map((await this.listSpaces()).map((space) => [space.name, space.dimensions]));
    const documents = docs.map((doc) => {
      if (Object.keys(doc.vectors).length === 0) throw new VectorInputError("empty-vectors", "A document needs at least one vector");
      for (const [name, vector] of Object.entries(doc.vectors)) {
        const dimensions = spaces.get(name);
        if (dimensions === undefined) throw new VectorInputError("unknown-space", `Unknown vector space: ${name}`);
        assertDimensions(vector, dimensions);
        if (!isUsableVector(vector)) throw new SurrealVectorError("invalid-vector", "Vector must contain finite numbers and have non-zero magnitude");
      }
      return { namespace: this.namespace, collection, doc_id: doc.id, vectors: Object.fromEntries(Object.entries(doc.vectors).map(([name, vector]) => [name, Array.from(vector)])), has_metadata: doc.metadata !== undefined, ...(doc.metadata === undefined ? {} : { metadata: doc.metadata }) };
    });
    if (documents.length === 0) return;
    await this.connection.query(`BEGIN TRANSACTION;
      FOR $document IN $documents {
        DELETE FROM ${this.documentsTable} WHERE namespace = $namespace AND collection = $collection AND doc_id = $document.doc_id;
        CREATE ${this.documentsTable} CONTENT $document;
      };
      COMMIT TRANSACTION;`, { namespace: this.namespace, collection, documents });
  }

  async get<M extends Record<string, unknown>>(collection: string, id: string): Promise<VectorDocument<M> | null> {
    const rows = await this.rows<VectorRow>(`SELECT doc_id, vectors, metadata, has_metadata FROM ${this.documentsTable} WHERE namespace = $namespace AND collection = $collection AND doc_id = $id LIMIT 1`, { namespace: this.namespace, collection, id });
    const row = rows[0];
    if (!row) return null;
    return { id: row.doc_id, vectors: Object.fromEntries(Object.entries(row.vectors).map(([name, vector]) => [name, Float32Array.from(vector)])), ...(row.has_metadata ? { metadata: row.metadata as M } : {}) };
  }

  async has(collection: string, id: string): Promise<boolean> { return (await this.get(collection, id)) !== null; }
  async remove(collection: string, id: string): Promise<boolean> {
    const rows = await this.rows<unknown>(`DELETE FROM ${this.documentsTable} WHERE namespace = $namespace AND collection = $collection AND doc_id = $id RETURN BEFORE`, { namespace: this.namespace, collection, id });
    return rows.length > 0;
  }
  async count(collection: string): Promise<number> {
    const rows = await this.rows<{ count: number }>(`SELECT count() FROM ${this.documentsTable} WHERE namespace = $namespace AND collection = $collection GROUP ALL`, { namespace: this.namespace, collection });
    return rows[0]?.count ?? 0;
  }

  async search<M extends Record<string, unknown>>(collection: string, query: VectorQuery, opts: VectorSearchOptions = {}): Promise<VectorSearchResult<M>[]> {
    const space = (await this.listSpaces()).find((space) => space.name === query.space);
    if (!space) throw new VectorInputError("unknown-space", `Unknown vector space: ${query.space}`);
    assertDimensions(query.vector, space.dimensions);
    if (!isUsableVector(query.vector)) return [];
    const topK = opts.topK ?? 10;
    if (!Number.isInteger(topK) || topK < 0) throw new SurrealVectorError("invalid-top-k", "topK must be a non-negative integer");
    if (topK === 0) return [];
    const { clause, bindings } = metadataFilter(opts);
    const rows = await this.rows<{ doc_id: string; score: number; metadata?: M; has_metadata: boolean }>(`
      SELECT doc_id, metadata, has_metadata, vector::similarity::cosine(vectors[$space], $query) AS score
      FROM ${this.documentsTable}
      WHERE namespace = $namespace AND collection = $collection AND array::len(vectors[$space] ?? []) = $dimensions ${clause}
      ORDER BY score DESC, doc_id ASC LIMIT $topK`, { namespace: this.namespace, collection, space: query.space, dimensions: space.dimensions, query: Array.from(query.vector), topK, ...bindings });
    return rows.filter((row) => Number.isFinite(row.score) && (opts.minScore === undefined || row.score >= opts.minScore)).map((row) => ({ id: row.doc_id, score: row.score, ...(row.has_metadata ? { metadata: row.metadata as M } : {}) }));
  }

  private async init(legacyDimensions: string): Promise<void> {
    await this.connection.query(`DEFINE TABLE IF NOT EXISTS ${legacyDimensions} SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS ${this.spacesTable} SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS ${this.documentsTable} SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS ${this.spacesTable}_identity ON ${this.spacesTable} FIELDS namespace, name UNIQUE;
      REMOVE INDEX IF EXISTS ${this.documentsTable}_identity ON ${this.documentsTable};
      DEFINE INDEX IF NOT EXISTS ${this.documentsTable}_namespace_identity ON ${this.documentsTable} FIELDS namespace, collection, doc_id UNIQUE;`);
    const legacy = await this.rows<{ dimensions: number }>(`SELECT dimensions FROM ${legacyDimensions}`);
    const dimensions = [...new Set(legacy.map((row) => row.dimensions))];
    if (dimensions.length > 1) throw new SurrealVectorError("migration-conflict", "Legacy collections have incompatible dimensions for shared default space; data unchanged");
    if (dimensions.length === 1) {
      const defaultAdapter = new SurrealVectorAdapter(this.connection, this.documentsTable, this.spacesTable, "default");
      await defaultAdapter.ensureSpace("default", { dimensions: dimensions[0]! });
      await this.connection.query(`BEGIN TRANSACTION;
        UPDATE ${this.documentsTable} SET namespace = 'default', vectors = { default: vector }, has_metadata = metadata != NONE WHERE namespace = NONE;
        UPDATE ${this.documentsTable} UNSET vector WHERE namespace = 'default' AND vectors != NONE;
        DELETE FROM ${legacyDimensions};
        COMMIT TRANSACTION;`);
    }
  }

  private async rows<T>(query: string, bindings?: Record<string, unknown>): Promise<T[]> {
    return firstStatement<T[]>(await this.connection.query<unknown>(query, bindings));
  }
}

function metadataFilter(opts: VectorSearchOptions): { clause: string; bindings: Record<string, unknown> } {
  const bindings: Record<string, unknown> = {};
  const conditions = (values: Record<string, unknown>, prefix: string): string => {
    const parts = ["has_metadata = true"];
    Object.entries(values).forEach(([key, value], index) => {
      const name = `${prefix}_${index}`;
      parts.push(`metadata[$${name}_key] = $${name}_value`);
      bindings[`${name}_key`] = key; bindings[`${name}_value`] = value;
    });
    return parts.join(" AND ");
  };
  const clauses = [];
  if (opts.where !== undefined) clauses.push(`AND (${conditions(opts.where, "where")})`);
  if (opts.whereNot !== undefined) clauses.push(`AND NOT (${conditions(opts.whereNot, "where_not")})`);
  return { clause: clauses.join(" "), bindings };
}
function tableName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw new SurrealVectorError("invalid-identifier", `Invalid SurrealDB table identifier ${value}`);
  return value;
}
