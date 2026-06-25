// ─── @mirk/store/search types ───────────────────────────────────────────────
// Synchronous full-text search store. One interface, swappable embedded backends.
//
// Sync by design: the embedded backends (in-memory, sqlite) are synchronous —
// better-sqlite3 is synchronous, and forcing async on a local call buys nothing.
//
// Hand-written per-method generics (mirroring VectorStore) rather than derived
// via a mapped type: per-method generics (`index<M>`, `search<M>`, …) collapse to
// `unknown` under inference — same reason as the KV AsyncStore twin in types.ts.

import type { StoreFilter } from "../types.js";

/** A document to be full-text indexed. `meta` is an exact-match-filterable
 *  payload persisted as JSON by disk-backed backends, so it must be JSON-
 *  serializable; values JSON can't represent (`undefined`, functions) are dropped
 *  on persistence — don't rely on them. */
export interface SearchTextDocument<M = Record<string, unknown>> {
  /** Unique id within the collection. */
  id: string;
  /** Single-field text to tokenize and index. Back-compat shorthand for
   *  `fields: { text }`. */
  text: string;
  /** Provide either `text` or `fields`, not both. */
  fields?: never;
  /** Typed context stored alongside the text. */
  meta?: M;
}

export interface SearchFieldDocument<M = Record<string, unknown>> {
  /** Unique id within the collection. */
  id: string;
  /** Named text fields to tokenize and index with optional query-time weights
   *  (for example `{ title, body }`). All documents in a collection must use the
   *  same field names. */
  fields: Record<string, string>;
  /** Provide either `text` or `fields`, not both. */
  text?: never;
  /** Typed context stored alongside the text. */
  meta?: M;
}

export type SearchDocument<M = Record<string, unknown>> = SearchTextDocument<M> | SearchFieldDocument<M>;

export interface SearchOptions {
  /** Maximum results to return. Default: 10. */
  limit?: number;
  /** Exact-match filter on document `meta` (uses `filter.where`, evaluated with
   *  the shared `matchesWhere`). Applied before limit, after the FTS MATCH. */
  filter?: StoreFilter;
  /** Per-field bm25 weights. Fields not listed default to 1. Higher means more
   *  important; e.g. `{ title: 4, body: 1 }` boosts title matches. */
  fieldWeights?: Record<string, number>;
}

/** A ranked search hit. `score` is the bm25 relevance — higher is more relevant. */
export interface SearchResult<M = Record<string, unknown>> {
  id: string;
  /** bm25 relevance. Higher = more relevant. (sqlite exposes `-bm25(fts)`; the
   *  in-memory reference computes the same quantity directly.) */
  score: number;
  /** The document's `meta`, or `{}` when none was indexed. */
  meta: M;
}

/** A synchronous full-text search store with per-collection documents.
 *
 *  Ranking is bm25 with the FTS5 default parameters (k1 = 1.2, b = 0.75), plus
 *  optional query-time per-field weights. The in-memory reference and the sqlite
 *  `.search` facet produce the same RANKING on clear relevance differences;
 *  exact float scores need not match across backends (the same parity caveat as
 *  /vector). */
export interface SearchStore {
  /** Insert or replace a document by (collection, id). */
  index<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: SearchDocument<M>,
  ): void;

  /** Insert or replace many documents in one collection. */
  indexMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<SearchDocument<M>>,
  ): void;

  /** Remove a document by id. Returns true if it existed. */
  remove(collection: string, id: string): boolean;

  /** bm25-ranked keyword search, highest score first. Supports an exact-match
   *  meta `filter`. An empty/whitespace query returns `[]`. */
  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: string,
    opts?: SearchOptions,
  ): SearchResult<M>[];
}
