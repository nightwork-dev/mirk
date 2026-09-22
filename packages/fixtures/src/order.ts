// ─── Ordering primitive ─────────────────────────────────────────────────────
// Tie-break order across every Mirk port is Unicode CODE POINT order, and the
// fixtures package holds to it: source entries, registered type names, `list()`
// results and the CLI's graph all sort this way, so the memory source, the
// filesystem source and the store source agree on the same set of paths, and so
// the Python port — where string comparison IS code point order — agrees with
// this one.
//
// JS offers three tempting near-misses, all wrong here:
//
//   `a < b`            UTF-16 code UNIT order — astral characters (U+1F600…)
//                      sort below U+E000…U+FFFF because their surrogates do.
//   `localeCompare`    ICU collation — case- and accent-aware, locale-dependent,
//                      and disagrees with SQLite's BINARY collation.
//   `Intl.Collator`    same problem, faster.
//
// `@mirk/store` exports the identical function from its root, and this file
// deliberately does not import it. `@mirk/store` depends on `@mirk/fixtures` for
// conformance tooling, so a runtime import here would close a workspace cycle
// that makes `pnpm build` order nondeterministic: the fixtures type build would
// need a `@mirk/store` declaration file that may not exist yet. Twelve lines of
// pure logic is the cheaper half of that trade. The two must stay identical;
// the conformance corpus is what proves they are.

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
