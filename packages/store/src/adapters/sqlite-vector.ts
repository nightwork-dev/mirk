import type {
  VectorDocument,
  VectorQuery,
  VectorSearchOptions,
  VectorSearchResult,
  VectorSpace,
  VectorSpaceOptions,
  VectorStore,
  VectorStoreMeta,
} from "../vector/types.js";
import {
  assertDimensions,
  bufferToVector,
  cosineSimilarity,
  isUsableVector,
  vectorToBuffer,
  VectorInputError,
} from "../vector/cosine.js";
import { matchesWhere } from "../vector/filter.js";
import { validateSpace } from "../vector/memory.js";
import { compareCodePoints } from "../order.js";
import type { SqliteDb } from "./sqlite-driver.js";
import type { SqliteVectorEngine } from "./sqlite-vector-engine.js";

export class SqliteVectorFacet implements VectorStore {
  readonly meta: VectorStoreMeta;
  constructor(
    private readonly db: SqliteDb,
    private readonly namespace = "default",
    private readonly engine?: SqliteVectorEngine,
  ) {
    if (engine?.initialize(db) === false) this.engine = undefined;
    this.meta = {
      backend: "sqlite",
      engine: this.engine?.name ?? "javascript",
      accelerated: !!this.engine,
    };
  }
  ensureSpace(name: string, options: VectorSpaceOptions): void {
    validateSpace(name, options);
    this.db
      .transaction(() => {
        const found = this.space(name);
        if (found && found.dimensions !== options.dimensions)
          throw new VectorInputError(
            "space-definition-conflict",
            `Space ${name} already has ${found.dimensions} dimensions`,
          );
        this.db
          .prepare(
            "INSERT OR IGNORE INTO _mirk_vector_spaces(namespace,name,dimensions,metric,encoding) VALUES(?,?,?,'cosine','float32')",
          )
          .run(this.namespace, name, options.dimensions);
      })
      .immediate();
  }
  listSpaces(): VectorSpace[] {
    return (
      this.db
        .prepare(
          "SELECT name,dimensions,metric,encoding FROM _mirk_vector_spaces WHERE namespace=?",
        )
        .all(this.namespace) as VectorSpace[]
    ).sort((a, b) => compareCodePoints(a.name, b.name));
  }
  private space(name: string): VectorSpace | undefined {
    return this.db
      .prepare(
        "SELECT name,dimensions,metric,encoding FROM _mirk_vector_spaces WHERE namespace=? AND name=?",
      )
      .get(this.namespace, name) as VectorSpace | undefined;
  }
  private requireSpace(name: string): VectorSpace {
    const space = this.space(name);
    if (!space)
      throw new VectorInputError(
        "unknown-space",
        `Unknown vector space: ${name}`,
      );
    return space;
  }
  private validate(doc: VectorDocument): void {
    if (!Object.keys(doc.vectors).length)
      throw new VectorInputError(
        "empty-vectors",
        "A document needs at least one vector",
      );
    for (const [space, vector] of Object.entries(doc.vectors))
      assertDimensions(vector, this.requireSpace(space).dimensions);
  }
  upsert<M extends Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): void {
    this.upsertMany(collection, [doc]);
  }
  upsertMany<M extends Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): void {
    this.db
      .transaction(() => {
        const prepared = docs.map((doc) => {
          this.validate(doc);
          return {
            doc,
            metadata:
              doc.metadata === undefined ? null : JSON.stringify(doc.metadata),
            values: Object.entries(doc.vectors).map(([space, vector]) => ({
              space,
              bytes: vectorToBuffer(vector),
            })),
          };
        });
        for (const { doc, metadata, values } of prepared) {
          this.db
            .prepare(
              "INSERT INTO _mirk_vector_documents(namespace,collection,id,metadata) VALUES(?,?,?,?) ON CONFLICT(namespace,collection,id) DO UPDATE SET metadata=excluded.metadata",
            )
            .run(this.namespace, collection, doc.id, metadata);
          this.db
            .prepare(
              "DELETE FROM _mirk_vector_values WHERE namespace=? AND collection=? AND id=?",
            )
            .run(this.namespace, collection, doc.id);
          for (const { space, bytes } of values)
            this.db
              .prepare(
                "INSERT INTO _mirk_vector_values(namespace,collection,id,space,vec) VALUES(?,?,?,?,?)",
              )
              .run(this.namespace, collection, doc.id, space, bytes);
        }
      })
      .immediate();
  }
  get<M extends Record<string, unknown>>(
    collection: string,
    id: string,
  ): VectorDocument<M> | null {
    const row = this.db
      .prepare(
        "SELECT metadata FROM _mirk_vector_documents WHERE namespace=? AND collection=? AND id=?",
      )
      .get(this.namespace, collection, id) as
      | { metadata: string | null }
      | undefined;
    if (!row) return null;
    const vectors: Record<string, Float32Array> = {};
    for (const value of this.db
      .prepare(
        "SELECT space,vec FROM _mirk_vector_values WHERE namespace=? AND collection=? AND id=?",
      )
      .all(this.namespace, collection, id) as {
      space: string;
      vec: Uint8Array;
    }[])
      Object.defineProperty(vectors, value.space, {
        value: bufferToVector(value.vec),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return {
      id,
      vectors,
      ...(row.metadata === null
        ? {}
        : { metadata: JSON.parse(row.metadata) as M }),
    };
  }
  has(collection: string, id: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM _mirk_vector_documents WHERE namespace=? AND collection=? AND id=?",
      )
      .get(this.namespace, collection, id);
  }
  remove(collection: string, id: string): boolean {
    return this.db
      .transaction(() => {
        this.db
          .prepare(
            "DELETE FROM _mirk_vector_values WHERE namespace=? AND collection=? AND id=?",
          )
          .run(this.namespace, collection, id);
        return (
          this.db
            .prepare(
              "DELETE FROM _mirk_vector_documents WHERE namespace=? AND collection=? AND id=?",
            )
            .run(this.namespace, collection, id).changes > 0
        );
      })
      .immediate();
  }
  count(collection: string): number {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM _mirk_vector_documents WHERE namespace=? AND collection=?",
        )
        .get(this.namespace, collection) as { n: number }
    ).n;
  }
  search<M extends Record<string, unknown>>(
    collection: string,
    query: VectorQuery,
    options?: VectorSearchOptions,
  ): VectorSearchResult<M>[] {
    assertDimensions(query.vector, this.requireSpace(query.space).dimensions);
    if (this.engine)
      return this.engine.search(this.db, {
        namespace: this.namespace,
        collection,
        space: query.space,
        vector: query.vector,
        options,
      }) as VectorSearchResult<M>[];
    const rows = this.db
      .prepare(
        "SELECT v.id,v.vec,d.metadata FROM _mirk_vector_values v JOIN _mirk_vector_documents d USING(namespace,collection,id) WHERE v.namespace=? AND v.collection=? AND v.space=?",
      )
      .all(this.namespace, collection, query.space) as {
      id: string;
      vec: Uint8Array;
      metadata: string | null;
    }[];
    const scored: VectorSearchResult<M>[] = [];
    for (const row of rows) {
      const metadata =
        row.metadata === null ? undefined : (JSON.parse(row.metadata) as M);
      if (options?.where && !matchesWhere(metadata, options.where)) continue;
      if (options?.whereNot && matchesWhere(metadata, options.whereNot))
        continue;
      const vector = bufferToVector(row.vec);
      if (!isUsableVector(vector)) continue;
      const score = cosineSimilarity(query.vector, vector);
      if (
        !Number.isFinite(score) ||
        (options?.minScore !== undefined && score < options.minScore)
      )
        continue;
      scored.push({ id: row.id, score, metadata });
    }
    scored.sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id));
    return scored.slice(0, options?.topK ?? 10);
  }
}
