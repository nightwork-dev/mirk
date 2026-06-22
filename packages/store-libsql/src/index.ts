// ─── @mirk/store-libsql ──────────────────────────────────────────────────────
// libSQL / Turso source adapter for @mirk/store's ASYNC ports. One libSQL client,
// multiple capability facets: `.kv` is an AsyncStore (KV + collections), `.vector`
// is an AsyncVectorStore. Works over remote (libsql://…), file: and :memory: URLs.
//
// Vector search uses libSQL's NATIVE vector support — F32_BLOB(N) columns,
// vector32(), vector_distance_cos(), and the vector_top_k() table-valued function
// over a libsql_vector_idx index. No native extension to load (sqlite-vec / vec0
// can't load over a remote libSQL connection); this works everywhere libSQL runs.

export { LibsqlAdapter, type LibsqlAdapterOptions } from "./libsql-adapter.js";
