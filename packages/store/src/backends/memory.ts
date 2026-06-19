// ─── InMemoryStore ────────────────────────────────────────────────────────
// Reference implementation. Map-based. Synchronous. Zero dependencies.
// For tests and lightweight local use.

import type { SyncStore, StoreMeta, StoreFilter } from '../types.js';

export class InMemoryStore implements SyncStore {
  readonly meta: StoreMeta = {
    backend: 'memory',
  };

  /** Key-value storage. */
  private kv = new Map<string, unknown>();

  /** Collection storage: collection name -> Map of id -> item. */
  private collections = new Map<string, Map<string, unknown>>();

  // ── Key-Value ──────────────────────────────────────────────────────

  get<T>(key: string): T | null {
    const value = this.kv.get(key);
    return value !== undefined ? (value as T) : null;
  }

  set<T>(key: string, value: T): void {
    this.kv.set(key, value);
  }

  has(key: string): boolean {
    return this.kv.has(key);
  }

  delete(key: string): boolean {
    return this.kv.delete(key);
  }

  keys(prefix?: string): string[] {
    const allKeys = [...this.kv.keys()];
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }

  // ── Collections ────────────────────────────────────────────────────

  private ensureCollection(name: string): Map<string, unknown> {
    let col = this.collections.get(name);
    if (!col) {
      col = new Map<string, unknown>();
      this.collections.set(name, col);
    }
    return col;
  }

  list<T>(collection: string, filter?: StoreFilter): T[] {
    const col = this.ensureCollection(collection);
    let items = [...col.values()] as T[];
    items = applyFilter(items, filter);
    return items;
  }

  getById<T>(collection: string, id: string): T | null {
    const col = this.ensureCollection(collection);
    const item = col.get(id);
    return item !== undefined ? (item as T) : null;
  }

  put<T extends { id: string }>(collection: string, item: T): T {
    const col = this.ensureCollection(collection);
    col.set(item.id, item);
    return item;
  }

  remove(collection: string, id: string): boolean {
    const col = this.ensureCollection(collection);
    return col.delete(id);
  }

  count(collection: string, filter?: StoreFilter): number {
    const col = this.ensureCollection(collection);
    if (!filter?.where) return col.size;
    const items = [...col.values()];
    return applyFilter(items, filter).length;
  }
}

// ── Filter Logic ───────────────────────────────────────────────────────────

function matchesWhere(item: unknown, where: Record<string, unknown>): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const record = item as Record<string, unknown>;
  for (const [key, value] of Object.entries(where)) {
    if (record[key] !== value) return false;
  }
  return true;
}

function applyFilter<T>(items: T[], filter?: StoreFilter): T[] {
  if (!filter) return items;

  let result = items;

  // Where clause — exact match
  if (filter.where) {
    const where = filter.where;
    result = result.filter((item) => matchesWhere(item, where));
  }

  // Sort
  if (filter.sortBy) {
    const field = filter.sortBy;
    const dir = filter.sortDir === 'desc' ? -1 : 1;
    result = [...result].sort((a, b) => {
      const aVal = (a as Record<string, unknown>)[field];
      const bVal = (b as Record<string, unknown>)[field];
      if (aVal === bVal) return 0;
      if (aVal === undefined || aVal === null) return 1;
      if (bVal === undefined || bVal === null) return -1;
      return aVal < bVal ? -1 * dir : 1 * dir;
    });
  }

  // Offset
  if (filter.offset !== undefined && filter.offset > 0) {
    result = result.slice(filter.offset);
  }

  // Limit
  if (filter.limit !== undefined && filter.limit >= 0) {
    result = result.slice(0, filter.limit);
  }

  return result;
}
