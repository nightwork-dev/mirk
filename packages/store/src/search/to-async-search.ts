import type {
  AsyncSearchStore,
  SearchDocument,
  SearchOptions,
  SearchResult,
  SearchStore,
} from "./types.js";

class AsyncSearchStoreAdapter implements AsyncSearchStore {
  constructor(private readonly sync: SearchStore) {}

  async index<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: SearchDocument<M>,
  ): Promise<void> {
    this.sync.index<M>(collection, doc);
  }

  async indexMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<SearchDocument<M>>,
  ): Promise<void> {
    this.sync.indexMany<M>(collection, docs);
  }

  async remove(collection: string, id: string): Promise<boolean> {
    return this.sync.remove(collection, id);
  }

  async search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: string,
    opts?: SearchOptions,
  ): Promise<SearchResult<M>[]> {
    return this.sync.search<M>(collection, query, opts);
  }
}

/** Lift a synchronous SearchStore to the {@link AsyncSearchStore} interface. */
export function toAsyncSearch(store: SearchStore): AsyncSearchStore {
  return new AsyncSearchStoreAdapter(store);
}
