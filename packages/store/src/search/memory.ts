// ─── InMemorySearchStore ────────────────────────────────────────────────────
// Pure-JS bm25 reference. Non-persistent. For tests and small, transient
// datasets. Zero dependencies.
//
// bm25 reproducing SQLite FTS5's `bm25()` term for term (fts5_aux.c), with the
// FTS5 defaults k1 = 1.2, b = 0.75:
//
//   idf   = log((N - n + 0.5) / (n + 0.5)), and when that is <= 0 it becomes
//           1e-6 — FTS5's floor. It is NOT dropped: the floored term still
//           contributes, and its length normalization is what ranks a short
//           document above a long one when every document contains the term.
//   freq  = the WEIGHTED instance count, sum(weight[i] * tf[i]) over fields.
//   D     = the row's UNWEIGHTED total token count across all fields
//           (FTS5's xColumnSize(-1)), and avgdl the same total averaged over
//           rows (xColumnTotalSize(-1) / xRowCount).
//   term  = idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * D / avgdl))
//
// A document matches when FTS5's MATCH would match it: it holds the term in
// some field, whatever that field's weight. A weight of 0 therefore yields a
// matched row scoring exactly 0 for that term rather than a missing row.
//
// Query terms are NOT deduplicated, because FTS5 does not: `"x" OR "x"` is two
// phrases and bm25() sums both, doubling the score. Verified against FTS5.

import type { SearchStore, SearchDocument, SearchResult, SearchOptions } from "./types.js";
import { matchesWhere } from "../vector/filter.js";
import { compareCodePoints } from "../order.js";
import { tokenize } from "./tokenize.js";
import {
  assertSameSearchFields,
  assertValidFieldWeightValues,
  fieldWeightsFor,
  normalizeSearchDocument,
} from "./fields.js";

/** FTS5 default bm25 parameters. */
const K1 = 1.2;
const B = 0.75;

/** FTS5's floor for a non-positive IDF (`if( idf<=0.0 ) idf = 1e-6;`). */
const IDF_FLOOR = 1e-6;

interface IndexedDoc {
  id: string;
  meta: Record<string, unknown>;
  /** field → term → frequency within this document field. */
  tfByField: Map<string, Map<string, number>>;
  /** Total token count across all fields. */
  dl: number;
  /** Unique terms appearing in any field of this document. */
  terms: Set<string>;
}

interface Collection {
  fields: string[];
  docs: Map<string, IndexedDoc>;
  /** term → number of docs containing it in any field (document frequency). */
  df: Map<string, number>;
  /** Sum of all document lengths across all fields. */
  totalLen: number;
}

export class InMemorySearchStore implements SearchStore {
  private readonly collections = new Map<string, Collection>();

  index<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: SearchDocument<M>,
  ): void {
    const normalized = normalizeSearchDocument(doc);
    const coll = this.collectionFor(collection, normalized.names);
    assertSameSearchFields(coll.fields, normalized.names, collection);
    this.removeFromColl(coll, doc.id);

    const tfByField = new Map<string, Map<string, number>>();
    const terms = new Set<string>();
    let dl = 0;

    for (const field of coll.fields) {
      const tokens = tokenize(normalized.values[field] ?? "");
      dl += tokens.length;
      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
        terms.add(token);
      }
      tfByField.set(field, tf);
    }
    coll.totalLen += dl;

    const indexed: IndexedDoc = {
      id: doc.id,
      meta: (doc.meta ?? {}) as Record<string, unknown>,
      tfByField,
      dl,
      terms,
    };
    coll.docs.set(doc.id, indexed);
    for (const term of terms) coll.df.set(term, (coll.df.get(term) ?? 0) + 1);
  }

  indexMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<SearchDocument<M>>,
  ): void {
    for (const doc of docs) this.index(collection, doc);
  }

  remove(collection: string, id: string): boolean {
    const coll = this.collections.get(collection);
    if (!coll) return false;
    return this.removeFromColl(coll, id);
  }

  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: string,
    opts?: SearchOptions,
  ): SearchResult<M>[] {
    const coll = this.collections.get(collection);
    const qTokens = tokenize(query);
    assertValidFieldWeightValues(opts?.fieldWeights);
    if (!coll || qTokens.length === 0) return [];
    const limit = opts?.limit ?? 10;
    const where = opts?.filter?.where;
    const fieldWeights = fieldWeightsFor(coll.fields, opts?.fieldWeights);
    const n = coll.docs.size;
    const scored: SearchResult<M>[] = [];

    for (const doc of coll.docs.values()) {
      if (where && !matchesWhere(doc.meta, where)) continue;
      // A doc matches when it holds at least one query term in SOME field —
      // FTS5's MATCH is weight-blind, so a zero-weighted field still matches
      // and simply contributes nothing to the score.
      let matched = false;
      let score = 0;
      const avgdl = n > 0 ? coll.totalLen / n : 0;
      for (const qt of qTokens) {
        const df = coll.df.get(qt) ?? 0;
        if (df === 0) continue;
        let rawTf = 0;
        let weightedTf = 0;
        for (let i = 0; i < coll.fields.length; i++) {
          const field = coll.fields[i]!;
          const tf = doc.tfByField.get(field)?.get(qt) ?? 0;
          rawTf += tf;
          weightedTf += fieldWeights[i]! * tf;
        }
        if (rawTf === 0) continue;
        matched = true;
        const raw = Math.log((n - df + 0.5) / (df + 0.5));
        const idf = raw <= 0 ? IDF_FLOOR : raw;
        const denom = weightedTf + K1 * (1 - B + B * (avgdl > 0 ? doc.dl / avgdl : 0));
        score += (idf * (weightedTf * (K1 + 1))) / denom;
      }
      if (!matched) continue;
      scored.push({ id: doc.id, score, meta: doc.meta as M });
    }
    // score desc, tiebreak by id in Unicode code point order — the same ordering
    // the sqlite facet gets from `ORDER BY bm, d.id` under BINARY collation.
    scored.sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id));
    return scored.slice(0, limit);
  }

  private removeFromColl(coll: Collection, id: string): boolean {
    const doc = coll.docs.get(id);
    if (!doc) return false;
    coll.docs.delete(id);
    coll.totalLen -= doc.dl;
    for (const term of doc.terms) {
      const next = (coll.df.get(term) ?? 0) - 1;
      if (next <= 0) coll.df.delete(term);
      else coll.df.set(term, next);
    }
    return true;
  }

  private collectionFor(name: string, fields: readonly string[]): Collection {
    let coll = this.collections.get(name);
    if (!coll) {
      coll = {
        fields: [...fields],
        docs: new Map(),
        df: new Map(),
        totalLen: 0,
      };
      this.collections.set(name, coll);
    }
    return coll;
  }
}
