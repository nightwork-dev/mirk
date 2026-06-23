// ─── @mirk/store/search ─────────────────────────────────────────────────────
// Full-text search interface (the port) + the in-memory reference impl + the
// shared tokenization helpers. ZERO native deps. Source adapters (e.g.
// @mirk/store/sqlite) implement SearchStore; they are NOT re-exported here.

export type { SearchStore, SearchDocument, SearchOptions, SearchResult } from "./search/types.js";
export { InMemorySearchStore } from "./search/memory.js";
export { tokenize, sanitizeFtsQuery } from "./search/tokenize.js";
// The canonical exact-match meta filter — the same definition /vector exports.
export { matchesWhere } from "./vector/filter.js";
