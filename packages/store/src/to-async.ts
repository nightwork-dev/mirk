import type {
  SyncStore,
  SyncStoreInQuery,
  AsyncStore,
  AsyncStoreInQuery,
  StoreMeta,
  StoreFilter,
} from './types.js';

function hasListWhereIn(store: SyncStore): store is SyncStore & SyncStoreInQuery {
  return typeof (store as Partial<SyncStoreInQuery>).listWhereIn === 'function';
}

// Adapter: present a synchronous store through the AsyncStore interface by
// resolving every result. This is the one-way bridge — a sync store can serve an
// async consumer, but an async store can never be made sync (you cannot block on
// a network round-trip). Method shorthand keeps each method's generics intact.
class AsyncStoreAdapter implements AsyncStore, Partial<AsyncStoreInQuery> {
  readonly listWhereIn?: AsyncStoreInQuery['listWhereIn'];

  constructor(private readonly sync: SyncStore) {
    if (hasListWhereIn(sync)) {
      this.listWhereIn = async <T>(
        collection: string,
        field: string,
        values: readonly unknown[],
        filter?: StoreFilter,
      ): Promise<T[]> => sync.listWhereIn<T>(collection, field, values, filter);
    }
  }

  get meta(): StoreMeta {
    return this.sync.meta;
  }

  async get<T>(key: string): Promise<T | null> {
    return this.sync.get<T>(key);
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.sync.set<T>(key, value);
  }
  async has(key: string): Promise<boolean> {
    return this.sync.has(key);
  }
  async delete(key: string): Promise<boolean> {
    return this.sync.delete(key);
  }
  async keys(prefix?: string): Promise<string[]> {
    return this.sync.keys(prefix);
  }

  async list<T>(collection: string, filter?: StoreFilter): Promise<T[]> {
    return this.sync.list<T>(collection, filter);
  }
  async getById<T>(collection: string, id: string): Promise<T | null> {
    return this.sync.getById<T>(collection, id);
  }
  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    return this.sync.put<T>(collection, item);
  }
  async remove(collection: string, id: string): Promise<boolean> {
    return this.sync.remove(collection, id);
  }
  async count(collection: string, filter?: StoreFilter): Promise<number> {
    return this.sync.count(collection, filter);
  }
}

/** Lift a synchronous store to the {@link AsyncStore} interface. The bridge only
 *  goes this direction — sync ⊂ async. Optional sync capabilities are lifted too. */
export function toAsync(store: SyncStore & SyncStoreInQuery): AsyncStore & AsyncStoreInQuery;
export function toAsync(store: SyncStore): AsyncStore;
export function toAsync(store: SyncStore): AsyncStore {
  return new AsyncStoreAdapter(store);
}
