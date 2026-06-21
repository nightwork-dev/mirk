import type {
  VectorStore,
  AsyncVectorStore,
  VectorStoreMeta,
  VectorDocument,
  VectorSearchResult,
  VectorSearchOptions,
  Vector,
} from './types.js';

// Adapter: present a synchronous VectorStore through the AsyncVectorStore interface
// by resolving every result. The one-way bridge — sync ⊂ async; the reverse is
// impossible (you cannot block on a network round-trip). Method shorthand keeps each
// method's generics intact, matching the pattern in src/to-async.ts.
class AsyncVectorStoreAdapter implements AsyncVectorStore {
  constructor(private readonly sync: VectorStore) {}

  get meta(): VectorStoreMeta {
    return this.sync.meta;
  }

  async upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): Promise<void> {
    this.sync.upsert<M>(collection, doc);
  }

  async upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): Promise<void> {
    this.sync.upsertMany<M>(collection, docs);
  }

  async get<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string,
  ): Promise<VectorDocument<M> | null> {
    return this.sync.get<M>(collection, id);
  }

  async has(collection: string, id: string): Promise<boolean> {
    return this.sync.has(collection, id);
  }

  async remove(collection: string, id: string): Promise<boolean> {
    return this.sync.remove(collection, id);
  }

  async count(collection: string): Promise<number> {
    return this.sync.count(collection);
  }

  async search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    opts?: VectorSearchOptions,
  ): Promise<VectorSearchResult<M>[]> {
    return this.sync.search<M>(collection, query, opts);
  }
}

/** Lift a synchronous VectorStore to the {@link AsyncVectorStore} interface. The
 *  bridge only goes this direction — sync ⊂ async. */
export function toAsyncVector(store: VectorStore): AsyncVectorStore {
  return new AsyncVectorStoreAdapter(store);
}
