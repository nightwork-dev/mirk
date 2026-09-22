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
