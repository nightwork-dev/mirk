import type { StoreFilter, SyncStore } from './types.js';

const SEPARATOR = '\u001f';

function assertNamespace(namespace: string): void {
  if (namespace.length === 0 || namespace.includes(SEPARATOR)) {
    throw new Error('namespace must be non-empty and must not contain the unit separator');
  }
}

function prefix(namespace: string, value: string): string {
  return `${namespace}${SEPARATOR}${value}`;
}

export function namespaceStore(store: SyncStore, namespace: string): SyncStore {
  assertNamespace(namespace);
  const keyPrefix = prefix(namespace, '');
  const collection = (name: string): string => prefix(namespace, name);

  return {
    meta: store.meta,
    get<T>(key: string): T | null {
      return store.get<T>(prefix(namespace, key));
    },
    set<T>(key: string, value: T): void {
      store.set(prefix(namespace, key), value);
    },
    has(key: string): boolean {
      return store.has(prefix(namespace, key));
    },
    delete(key: string): boolean {
      return store.delete(prefix(namespace, key));
    },
    keys(key?: string): string[] {
      return store.keys(prefix(namespace, key ?? '')).map((stored) => stored.slice(keyPrefix.length));
    },
    list<T>(name: string, filter?: StoreFilter): T[] {
      return store.list<T>(collection(name), filter);
    },
    getById<T>(name: string, id: string): T | null {
      return store.getById<T>(collection(name), id);
    },
    put<T extends { id: string }>(name: string, item: T): T {
      return store.put(collection(name), item);
    },
    remove(name: string, id: string): boolean {
      return store.remove(collection(name), id);
    },
    count(name: string, filter?: StoreFilter): number {
      return store.count(collection(name), filter);
    },
  };
}
