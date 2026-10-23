// ─── Ordering primitives ────────────────────────────────────────────────────
// Tie-break order across every Mirk port is Unicode CODE POINT order of the id.
// JS gives three tempting near-misses, all wrong here:
//
//   `a < b`            UTF-16 code UNIT order — astral characters (U+1F600…)
//                      sort below U+E000…U+FFFF because their surrogates do.
//   `localeCompare`    ICU collation — case- and accent-aware, locale-dependent,
//                      and disagrees with SQLite's BINARY collation.
//   `Intl.Collator`    same problem, faster.
//
// SQLite's BINARY collation compares UTF-8 bytes, which IS code point order, so
// this comparator is what makes a JS-side sort agree with an `ORDER BY id`.

import type { StoreFilter } from "./types.js";

/** Compare two strings by Unicode code point. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const x = left[i]!.codePointAt(0)!;
    const y = right[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

/** Apply a collection filter's sort and pagination to already-filtered rows. */
export function sortAndPageStoreItems<T>(items: T[], filter?: StoreFilter): T[] {
  let result = items;

  if (filter?.sortBy) {
    const field = filter.sortBy;
    const dir = filter.sortDir === "desc" ? -1 : 1;
    result = [...result].sort((a, b) => {
      const aVal = (a as Record<string, unknown>)[field];
      const bVal = (b as Record<string, unknown>)[field];
      const aMissing = aVal === undefined || aVal === null;
      const bMissing = bVal === undefined || bVal === null;
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (aVal === bVal) return 0;
      if (typeof aVal === "string" && typeof bVal === "string") {
        return compareCodePoints(aVal, bVal) * dir;
      }
      return aVal < bVal ? -1 * dir : 1 * dir;
    });
  }

  if (filter?.offset !== undefined && filter.offset > 0) {
    result = result.slice(Math.floor(filter.offset));
  }
  if (filter?.limit !== undefined) {
    result = result.slice(0, Math.max(0, Math.floor(filter.limit)));
  }

  return result;
}
