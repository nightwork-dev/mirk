// ─── Core Types ────────────────────────────────────────────────────────────
// SyncStore, AsyncStore, StoreFilter, StoreMeta.
// Zero dependencies. Types are cheap, abstractions are expensive.

/**
 * Metadata about a store instance.
 */
export interface StoreMeta {
  /** Backend identifier (e.g., "memory", "sqlite", "surrealdb"). */
  backend: string;
}

/**
 * Structured filter for collection queries.
 */
export interface StoreFilter {
  /** Exact match on fields within the stored item. */
  where?: Record<string, unknown>;
  /** Field to sort by. */
  sortBy?: string;
  /** Sort direction. Default: 'asc'. */
  sortDir?: 'asc' | 'desc';
  /** Maximum number of results. */
  limit?: number;
  /** Number of results to skip. */
  offset?: number;
}

/**
 * A typed key-value + collection store. **Synchronous.**
 *
 * Embedded backends (in-memory, sqlite) implement this directly — better-sqlite3
 * is synchronous, so wrapping it in Promises buys nothing and forecloses sync
 * consumers. A SyncStore can always be lifted to {@link AsyncStore} via
 * {@link toAsync}; the reverse is impossible (you can't block on a network call),
 * which is exactly why sync is the base interface and async is derived from it.
 */
export interface SyncStore {
  readonly meta: StoreMeta;

  // ── Key-Value ──────────────────────────────────────────────────────
  /** Get a value by key. Returns null if not found. */
  get<T>(key: string): T | null;
  /** Set a value by key. Overwrites if exists. */
  set<T>(key: string, value: T): void;
  /** Check if a key exists. */
  has(key: string): boolean;
  /** Delete a key. Returns true if the key existed. */
  delete(key: string): boolean;
  /** List all keys, optionally filtered by prefix. */
  keys(prefix?: string): string[];

  // ── Collections ────────────────────────────────────────────────────
  /** Get all items in a collection, with optional filter. */
  list<T>(collection: string, filter?: StoreFilter): T[];
  /** Get a single item by ID within a collection. */
  getById<T>(collection: string, id: string): T | null;
  /** Create or update an item in a collection. */
  put<T extends { id: string }>(collection: string, item: T): T;
  /** Remove an item from a collection by ID. Returns true if it existed. */
  remove(collection: string, id: string): boolean;
  /** Count items in a collection, with optional filter. */
  count(collection: string, filter?: StoreFilter): number;
}

/**
 * The async face of the same store. **Remote** backends (a future SurrealDB / HTTP
 * store) implement this natively; embedded sync backends reach it via
 * {@link toAsync}.
 *
 * Hand-written rather than derived from SyncStore via a mapped type, because a
 * mapped type cannot preserve the per-method generics (`get<T>`, `list<T>`, …) —
 * `infer` collapses them to `unknown`. The duplication is the price of keeping
 * the async side fully typed.
 */
export interface AsyncStore {
  readonly meta: StoreMeta;

  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;

  list<T>(collection: string, filter?: StoreFilter): Promise<T[]>;
  getById<T>(collection: string, id: string): Promise<T | null>;
  put<T extends { id: string }>(collection: string, item: T): Promise<T>;
  remove(collection: string, id: string): Promise<boolean>;
  count(collection: string, filter?: StoreFilter): Promise<number>;
}
