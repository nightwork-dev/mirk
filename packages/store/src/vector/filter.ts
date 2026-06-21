// ─── Pre-KNN metadata filter helper ─────────────────────────────────────────
// Shared by InMemoryVectorStore and SqliteVectorFacet (JS-cosine path).
// Zero dependencies. Pure function — no I/O, no side effects.

/** Returns true when `metadata` satisfies ALL exact-match conditions in `filter`.
 *  A missing metadata object never satisfies a non-empty filter (no field can match).
 *  Comparison is deep-equal via JSON round-trip — the same fidelity as metadata
 *  persisted and re-parsed from disk; avoids reference-equality surprises for
 *  objects/arrays in the filter. */
export function matchesWhere(
  metadata: Record<string, unknown> | undefined,
  filter: Record<string, unknown>,
): boolean {
  if (!metadata) return false;
  for (const [key, expected] of Object.entries(filter)) {
    const actual = metadata[key];
    // Fast path for primitives (covers the overwhelming majority of filter fields).
    if (actual === expected) continue;
    // Structural equality for objects/arrays — JSON round-trip matches how disk-backed
    // backends store and restore metadata, so filter semantics stay consistent across
    // in-memory and sqlite backends.
    if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
  }
  return true;
}
