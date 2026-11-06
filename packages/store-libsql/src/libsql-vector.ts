import type { InStatement, ResultSet } from "@libsql/client";
import { assertDimensions, bufferToVector, compareCodePoints, cosineSimilarity, isUsableVector, matchesWhere, VectorInputError, vectorToBuffer } from "@mirk/store/vector";
import type { AsyncVectorStore, Vector, VectorDocument, VectorQuery, VectorSearchOptions, VectorSearchResult, VectorSpace, VectorSpaceOptions, VectorStoreMeta } from "@mirk/store/vector";

interface VectorDatabase {
  execute(statement: InStatement): Promise<ResultSet>;
  transactions: { transaction<T>(work: () => Promise<T>): Promise<T> };
}

export class LibsqlVectorFacet implements AsyncVectorStore {
  readonly meta: VectorStoreMeta;
  private readonly spacesTable: string;
  private readonly documentsTable: string;
  private readonly valuesTable: string;
  constructor(private readonly db: VectorDatabase, prefix: string, private readonly namespace: string, private readonly forceJsCosine = false) {
    this.spacesTable = `${prefix}_mirk_vector_spaces`;
    this.documentsTable = `${prefix}_mirk_vector_documents`;
    this.valuesTable = `${prefix}_mirk_vector_values`;
    this.meta = { backend: "libsql", accelerated: !forceJsCosine };
  }

  async listSpaces(): Promise<VectorSpace[]> {
    const result = await this.db.execute({ sql: `SELECT name, dimensions FROM ${this.spacesTable} WHERE namespace = ?`, args: [this.namespace] });
    return result.rows.map((row) => ({ name: String(row.name), dimensions: Number(row.dimensions), metric: "cosine" as const, encoding: "float32" as const })).sort((a, b) => compareCodePoints(a.name, b.name));
  }

  async ensureSpace(name: string, options: VectorSpaceOptions): Promise<void> {
    if (!name) throw new VectorInputError("invalid-space", "Space name must be nonempty");
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) throw new VectorInputError("invalid-dimensions", "Dimensions must be a positive integer");
    await this.db.transactions.transaction(async () => {
      await this.db.execute({ sql: `INSERT INTO ${this.spacesTable}(namespace,name,dimensions,metric,encoding) VALUES (?,?,?,'cosine','float32') ON CONFLICT(namespace,name) DO NOTHING`, args: [this.namespace, name, options.dimensions] });
      const existing = (await this.listSpaces()).find((space) => space.name === name)!;
      if (existing.dimensions !== options.dimensions) throw new VectorInputError("space-definition-conflict", `Space ${name} already has ${existing.dimensions} dimensions`);
    });
  }

  async upsert<M extends Record<string, unknown>>(collection: string, doc: VectorDocument<M>): Promise<void> { await this.upsertMany(collection, [doc]); }
  async upsertMany<M extends Record<string, unknown>>(collection: string, docs: ReadonlyArray<VectorDocument<M>>): Promise<void> {
    await this.db.transactions.transaction(async () => {
      const spaces = new Map((await this.listSpaces()).map((space) => [space.name, space.dimensions]));
      const prepared = docs.map((doc) => {
        if (Object.keys(doc.vectors).length === 0) throw new VectorInputError("empty-vectors", "A document needs at least one vector");
        const vectors = Object.entries(doc.vectors).map(([name, vector]) => {
          const dimensions = spaces.get(name);
          if (dimensions === undefined) throw new VectorInputError("unknown-space", `Unknown vector space: ${name}`);
          assertDimensions(vector, dimensions);
          return [name, vectorToBuffer(vector)] as const;
        });
        return { id: doc.id, metadata: doc.metadata === undefined ? null : JSON.stringify(doc.metadata), vectors };
      });
      for (const doc of prepared) {
        await this.db.execute({ sql: `DELETE FROM ${this.valuesTable} WHERE namespace=? AND collection=? AND id=?`, args: [this.namespace, collection, doc.id] });
        await this.db.execute({ sql: `INSERT INTO ${this.documentsTable}(namespace,collection,id,metadata) VALUES (?,?,?,?) ON CONFLICT(namespace,collection,id) DO UPDATE SET metadata=excluded.metadata`, args: [this.namespace, collection, doc.id, doc.metadata] });
        for (const [space, vector] of doc.vectors) await this.db.execute({ sql: `INSERT INTO ${this.valuesTable}(namespace,collection,id,space,vec) VALUES (?,?,?,?,?)`, args: [this.namespace, collection, doc.id, space, vector] });
      }
    });
  }

  async get<M extends Record<string, unknown>>(collection: string, id: string): Promise<VectorDocument<M> | null> {
    const result = await this.db.execute({ sql: `SELECT d.metadata,v.space,v.vec FROM ${this.documentsTable} d JOIN ${this.valuesTable} v USING(namespace,collection,id) WHERE d.namespace=? AND d.collection=? AND d.id=?`, args: [this.namespace, collection, id] });
    if (result.rows.length === 0) return null;
    const metadata = result.rows[0]!.metadata;
    return { id, vectors: Object.fromEntries(result.rows.map((row) => [String(row.space), blobVector(row.vec)])), ...(metadata === null ? {} : { metadata: JSON.parse(String(metadata)) as M }) };
  }
  async has(collection: string, id: string): Promise<boolean> { return (await this.get(collection, id)) !== null; }
  async remove(collection: string, id: string): Promise<boolean> {
    return this.db.transactions.transaction(async () => {
      await this.db.execute({ sql: `DELETE FROM ${this.valuesTable} WHERE namespace=? AND collection=? AND id=?`, args: [this.namespace, collection, id] });
      const result = await this.db.execute({ sql: `DELETE FROM ${this.documentsTable} WHERE namespace=? AND collection=? AND id=?`, args: [this.namespace, collection, id] });
      return result.rowsAffected > 0;
    });
  }
  async count(collection: string): Promise<number> {
    const result = await this.db.execute({ sql: `SELECT count(*) n FROM ${this.documentsTable} WHERE namespace=? AND collection=?`, args: [this.namespace, collection] });
    return Number(result.rows[0]!.n);
  }

  async search<M extends Record<string, unknown>>(collection: string, query: VectorQuery, opts: VectorSearchOptions = {}): Promise<VectorSearchResult<M>[]> {
    const space = (await this.listSpaces()).find((space) => space.name === query.space);
    if (!space) throw new VectorInputError("unknown-space", `Unknown vector space: ${query.space}`);
    assertDimensions(query.vector, space.dimensions);
    const topK = opts.topK ?? 10;
    if (Number.isNaN(topK) || topK === 0 || opts.minScore === Infinity) return [];
    const limit = Number.isFinite(topK) && topK > 0 ? Math.trunc(topK) : -1;
    const floor = Number.isFinite(opts.minScore) ? opts.minScore! : -2;
    const scope = `FROM ${this.valuesTable} v JOIN ${this.documentsTable} d USING(namespace,collection,id) WHERE v.namespace=? AND v.collection=? AND v.space=?`;
    const args = [this.namespace, collection, query.space];
    if (!this.forceJsCosine && isUsableVector(query.vector) && !opts.where && !opts.whereNot) {
      const result = await this.db.execute({ sql: `SELECT id,metadata,score FROM (SELECT v.id,d.metadata,1-vector_distance_cos(v.vec,vector32(?)) score ${scope}) WHERE score IS NOT NULL AND score >= ? ORDER BY score DESC,id COLLATE BINARY ASC LIMIT ?`, args: [vectorToBuffer(query.vector), ...args, floor, limit] });
      return result.rows.filter((row) => Number.isFinite(Number(row.score))).map((row) => ({ id: String(row.id), score: Number(row.score), ...(row.metadata === null ? {} : { metadata: JSON.parse(String(row.metadata)) as M }) })).slice(0, topK);
    }
    const result = await this.db.execute({ sql: `SELECT v.id,v.vec,d.metadata ${scope}`, args });
    const scored: VectorSearchResult<M>[] = [];
    for (const row of result.rows) {
      const metadata = row.metadata === null ? undefined : JSON.parse(String(row.metadata)) as M;
      if (opts.where && !matchesWhere(metadata, opts.where)) continue;
      if (opts.whereNot && matchesWhere(metadata, opts.whereNot)) continue;
      const vector = blobVector(row.vec);
      if (!isUsableVector(vector)) continue;
      const score = cosineSimilarity(query.vector, vector);
      if (!Number.isFinite(score) || (opts.minScore !== undefined && score < opts.minScore)) continue;
      scored.push({ id: String(row.id), score, ...(metadata === undefined ? {} : { metadata }) });
    }
    return scored.sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id)).slice(0, topK);
  }
}

function blobVector(value: unknown): Vector {
  if (value instanceof ArrayBuffer) return bufferToVector(new Uint8Array(value));
  if (value instanceof Uint8Array) return bufferToVector(value);
  throw new Error("Unexpected vector BLOB encoding");
}
