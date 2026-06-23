// ─── FTS tokenization + query sanitization (shared) ──────────────────────────
// Shared by InMemorySearchStore and SqliteSearchFacet so both backends tokenize
// identically. Zero dependencies. Pure functions — no I/O, no side effects.
//
// The tokenizer mirrors FTS5's default `unicode61` closely enough for ranking
// parity: lowercase, then split on anything that isn't a unicode letter or
// digit. (unicode61 treats `_` and punctuation as separators by default, so we
// do too — this keeps the in-memory and sqlite doc tokenizations in lockstep.)

/** Tokenize `text` into lowercase unicode word tokens. A reasonable FTS5
 *  `unicode61`-ish split: letters and digits are token characters, everything
 *  else is a separator. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Sanitize a raw query into an FTS5 MATCH expression: tokenize, double-quote
 *  each token (doubling embedded quotes), OR them. Mirrors the knowledge/session
 *  index sanitizers so user punctuation / operators never throw. Returns "" for
 *  an empty/whitespace query — callers treat that as "no results". */
export function sanitizeFtsQuery(q: string): string {
  const tokens = tokenize(q);
  if (tokens.length === 0) return "";
  return tokens.map((tok) => `"${tok.replace(/"/g, '""')}"`).join(" OR ");
}
