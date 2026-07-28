import type {
  AsyncVectorStore,
  Vector,
  VectorDocument,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStoreMeta,
} from "@mirk/store/vector";
import { assertDimensions, isUsableVector } from "@mirk/store/vector";

export interface SurrealConnection {
  query<T>(surql: string, bindings?: Record<string, unknown>): Promise<T>;
}

export interface SurrealVectorOptions {
  dimensions?: number;
  documentsTable?: string;
  dimensionsTable?: string;
}

interface DimensionRow {
  collection: string;
  dimensions: number;
}

interface VectorRow<M extends Record<string, unknown> = Record<string, unknown>> {
  doc_id: string;
  vector: number[];
  metadata?: M;
}

interface VectorSearchRow<M extends Record<string, unknown> = Record<string, unknown>> {
  doc_id: string;
  score: number;
  metadata?: M;
}

const DEFAULT_DOCUMENTS_TABLE = "mirk_vector_documents";
const DEFAULT_DIMENSIONS_TABLE = "mirk_vector_dimensions";

export class SurrealVectorAdapter implements AsyncVectorStore {
  readonly meta: VectorStoreMeta = { backend: "surreal", dimensions: 0, accelerated: true };

  private constructor(
    private readonly connection: SurrealConnection,
    private readonly documentsTable: string,
    private readonly dimensionsTable: string,
    dimensions: number,
  ) {
    this.meta.dimensions = dimensions;
  }

  static async open(connection: SurrealConnection, options: SurrealVectorOptions = {}): Promise<SurrealVectorAdapter> {
    const documentsTable = tableName(options.documentsTable ?? DEFAULT_DOCUMENTS_TABLE);
    const dimensionsTable = tableName(options.dimensionsTable ?? DEFAULT_DIMENSIONS_TABLE);
    const dimensions = options.dimensions ?? 0;
    if (dimensions < 0 || !Number.isInteger(dimensions)) {
      throw new Error(`Vector dimensions must be a non-negative integer; got ${dimensions}.`);
    }

    const adapter = new SurrealVectorAdapter(connection, documentsTable, dimensionsTable, dimensions);
    await adapter.init();
    return adapter;
  }

  async upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): Promise<void> {
    await this.ensureDimensions(collection, doc.vector);
    await this.connection.query(
      `
      DELETE FROM ${this.documentsTable} WHERE collection = $collection AND doc_id = $id;
      CREATE ${this.documentsTable} SET
        collection = $collection,
        doc_id = $id,
        vector = $vector,
        metadata = $metadata;
      `,
      {
        collection,
        id: doc.id,
        vector: vectorToArray(doc.vector),
        metadata: doc.metadata ?? {},
      },
    );
  }

  async upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): Promise<void> {
    for (const doc of docs) {
      await this.ensureDimensions(collection, doc.vector);
    }
    for (const doc of docs) {
      await this.upsert(collection, doc);
    }
  }

  async get<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string,
  ): Promise<VectorDocument<M> | null> {
    const rows = await this.rows<VectorRow<M>>(
      `SELECT doc_id, vector, metadata FROM ${this.documentsTable} WHERE collection = $collection AND doc_id = $id LIMIT 1;`,
      { collection, id },
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.doc_id,
      vector: Float32Array.from(row.vector),
      metadata: (row.metadata ?? {}) as M,
    };
  }

  async has(collection: string, id: string): Promise<boolean> {
    const rows = await this.rows<{ doc_id: string }>(
      `SELECT doc_id FROM ${this.documentsTable} WHERE collection = $collection AND doc_id = $id LIMIT 1;`,
      { collection, id },
    );
    return rows.length > 0;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const existed = await this.has(collection, id);
    if (!existed) return false;
    await this.connection.query(`DELETE FROM ${this.documentsTable} WHERE collection = $collection AND doc_id = $id;`, {
      collection,
      id,
    });
    return true;
  }

  async count(collection: string): Promise<number> {
    const rows = await this.rows<{ count?: number }>(
      `SELECT count() FROM ${this.documentsTable} WHERE collection = $collection GROUP ALL;`,
      { collection },
    );
    return Number(rows[0]?.count ?? 0);
  }

  async search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    opts: VectorSearchOptions = {},
  ): Promise<VectorSearchResult<M>[]> {
    const dimensions = await this.dimensionsFor(collection);
    if (dimensions === 0) {
      throw new Error(`Vector collection "${collection}" has no configured dimensions.`);
    }
    assertDimensions(query, dimensions);
    if (!isUsableVector(query)) return [];

    const topK = opts.topK ?? 10;
    if (!Number.isInteger(topK) || topK < 0) throw new Error(`topK must be a non-negative integer; got ${topK}.`);
    if (topK === 0) return [];

    const { clause, bindings } = metadataFilter(opts);
    const rows = await this.rows<VectorSearchRow<M>>(
      `
      SELECT
        doc_id,
        metadata,
        vector::similarity::cosine(vector, $query) AS score
      FROM ${this.documentsTable}
      WHERE collection = $collection
        AND array::len(vector) = $dimensions
        ${clause}
      ORDER BY score DESC, doc_id ASC
      LIMIT $topK;
      `,
      {
        collection,
        dimensions,
        query: vectorToArray(query),
        topK,
        ...bindings,
      },
    );

    const minScore = opts.minScore;
    return rows
      .filter((row) => Number.isFinite(row.score) && (minScore === undefined || row.score >= minScore))
      .map((row) => ({ id: row.doc_id, score: row.score, metadata: (row.metadata ?? {}) as M }));
  }

  private async init(): Promise<void> {
    await this.connection.query(`
      DEFINE TABLE IF NOT EXISTS ${this.dimensionsTable} SCHEMALESS;
      DEFINE TABLE IF NOT EXISTS ${this.documentsTable} SCHEMALESS;
      DEFINE INDEX IF NOT EXISTS ${this.dimensionsTable}_collection ON ${this.dimensionsTable} FIELDS collection UNIQUE;
      DEFINE INDEX IF NOT EXISTS ${this.documentsTable}_identity ON ${this.documentsTable} FIELDS collection, doc_id UNIQUE;
      DEFINE INDEX IF NOT EXISTS ${this.documentsTable}_collection ON ${this.documentsTable} FIELDS collection;
    `);
  }

  private async ensureDimensions(collection: string, vector: Vector): Promise<void> {
    if (!isUsableVector(vector)) {
      throw new Error("Vector must contain only finite numbers and have non-zero magnitude.");
    }
    const existing = await this.dimensionsFor(collection);
    if (existing === 0) {
      const dimensions = this.meta.dimensions || vector.length;
      assertDimensions(vector, dimensions);
      await this.connection.query(
        `
        DELETE FROM ${this.dimensionsTable} WHERE collection = $collection;
        CREATE ${this.dimensionsTable} SET collection = $collection, dimensions = $dimensions;
        `,
        { collection, dimensions },
      );
      this.meta.dimensions = dimensions;
      return;
    }
    assertDimensions(vector, existing);
    if (this.meta.dimensions === 0) this.meta.dimensions = existing;
  }

  private async dimensionsFor(collection: string): Promise<number> {
    const rows = await this.rows<DimensionRow>(
      `SELECT collection, dimensions FROM ${this.dimensionsTable} WHERE collection = $collection LIMIT 1;`,
      { collection },
    );
    const persisted = rows[0]?.dimensions ?? 0;
    if (this.meta.dimensions !== 0 && persisted !== 0 && this.meta.dimensions !== persisted) {
      throw new Error(
        `Vector collection "${collection}" was created with ${persisted} dimensions, opened with ${this.meta.dimensions}.`,
      );
    }
    return persisted || this.meta.dimensions;
  }

  private async rows<T>(surql: string, bindings?: Record<string, unknown>): Promise<T[]> {
    return rowsFromResult<T>(await this.connection.query<unknown>(surql, bindings));
  }
}

function metadataFilter(opts: VectorSearchOptions): { clause: string; bindings: Record<string, unknown> } {
  const parts: string[] = [];
  const bindings: Record<string, unknown> = {};
  let index = 0;

  for (const [key, value] of Object.entries(opts.where ?? {})) {
    const name = `where_${index++}`;
    parts.push(`AND metadata[$${name}_key] = $${name}_value`);
    bindings[`${name}_key`] = key;
    bindings[`${name}_value`] = value;
  }
  for (const [key, value] of Object.entries(opts.whereNot ?? {})) {
    const name = `where_not_${index++}`;
    parts.push(`AND metadata[$${name}_key] != $${name}_value`);
    bindings[`${name}_key`] = key;
    bindings[`${name}_value`] = value;
  }

  return { clause: parts.join("\n        "), bindings };
}

function vectorToArray(vector: Vector): number[] {
  return Array.from(vector, (value) => value);
}

function rowsFromResult<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    if (result.length === 1 && Array.isArray(result[0])) {
      return rowsFromResult<T>(result[0]);
    }
    if (result.length > 0 && isQueryEnvelope(result[0])) {
      return rowsFromResult<T>(result[0].result);
    }
    return result as T[];
  }
  if (isQueryEnvelope(result)) return rowsFromResult<T>(result.result);
  return [];
}

function isQueryEnvelope(value: unknown): value is { result: unknown } {
  return typeof value === "object" && value !== null && "result" in value;
}

function tableName(value: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SurrealDB table identifier "${value}".`);
  }
  return value;
}
