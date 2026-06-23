// ─── InMemorySearchStore ────────────────────────────────────────────────────
// Pure-JS bm25 reference. Non-persistent. For tests and small, transient
// datasets. Zero dependencies.
//
// bm25 with the FTS5 default parameters (k1 = 1.2, b = 0.75). The IDF uses the
// FTS5 form `log((N - n + 0.5) / (n + 0.5))`, clamped at 0 — which matches the
// observed behaviour of SQLite's `bm25()` (a term appearing in half or more of
// the documents contributes nothing). Verified to produce scores identical to
// SQLite FTS5 on rare-term fixtures, so the parity test asserts RANKING (and, on
// clean fixtures, the same top hit).

import type { SearchStore, SearchDocument, SearchResult, SearchOptions } from "./types.js";
import { matchesWhere } from "../vector/filter.js";
import { tokenize } from "./tokenize.js";

/** FTS5 default bm25 parameters. */
const K1 = 1.2;
const B = 0.75;

interface IndexedDoc {
  id: string;
  meta: Record<string, unknown>;
  tokens: string[];
  /** term → frequency within this document. */
  tf: Map<string, number>;
  /** document length = total token count. */
  dl: number;
}

interface Collection {
  docs: Map<string, IndexedDoc>;
  /** term → number of docs containing it (document frequency). */
  df: Map<string, number>;
  /** sum of all document lengths (for avgdl). */
  totalLen: number;
}

export class InMemorySearchStore implements SearchStore {
  private readonly collections = new Map<string, Collection>();

  index<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: SearchDocument<M>,
  ): void {
    const coll = this.collectionFor(collection);
    this.removeFromColl(coll, doc.id);
    const tokens = tokenize(doc.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const indexed: IndexedDoc = {
      id: doc.id,
      meta: (doc.meta ?? {}) as Record<string, unknown>,
      tokens,
      tf,
      dl: tokens.length,
    };
    coll.docs.set(doc.id, indexed);
    coll.totalLen += indexed.dl;
    for (const term of tf.keys()) coll.df.set(term, (coll.df.get(term) ?? 0) + 1);
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
    if (!coll || qTokens.length === 0) return [];
    const limit = opts?.limit ?? 10;
    const where = opts?.filter?.where;
    const n = coll.docs.size;
    const avgdl = n > 0 ? coll.totalLen / n : 0;
    const scored: SearchResult<M>[] = [];
    for (const doc of coll.docs.values()) {
      if (where && !matchesWhere(doc.meta, where)) continue;
      // A doc must contain at least one query term to match (FTS5 MATCH only
      // returns docs that match at least one phrase).
      let matched = false;
      let score = 0;
      for (const qt of qTokens) {
        const tf = doc.tf.get(qt) ?? 0;
        if (tf === 0) continue;
        matched = true;
        const df = coll.df.get(qt) ?? 0;
        const idf = Math.log((n - df + 0.5) / (df + 0.5));
        if (idf <= 0) continue; // FTS5 clamps: terms in ≥half the docs add nothing
        const denom = tf + K1 * (1 - B + B * (avgdl > 0 ? doc.dl / avgdl : 0));
        score += (idf * (tf * (K1 + 1))) / denom;
      }
      if (!matched) continue;
      scored.push({ id: doc.id, score, meta: doc.meta as M });
    }
    // score desc, tiebreak by id asc — the same ordering the sqlite facet applies
    // (ORDER BY bm, id).
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, limit);
  }

  private removeFromColl(coll: Collection, id: string): boolean {
    const doc = coll.docs.get(id);
    if (!doc) return false;
    coll.docs.delete(id);
    coll.totalLen -= doc.dl;
    for (const term of doc.tf.keys()) {
      const next = (coll.df.get(term) ?? 0) - 1;
      if (next <= 0) coll.df.delete(term);
      else coll.df.set(term, next);
    }
    return true;
  }

  private collectionFor(name: string): Collection {
    let coll = this.collections.get(name);
    if (!coll) {
      coll = { docs: new Map(), df: new Map(), totalLen: 0 };
      this.collections.set(name, coll);
    }
    return coll;
  }
}
