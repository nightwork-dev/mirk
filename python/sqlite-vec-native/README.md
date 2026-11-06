# mirk-sqlite-vec-native

Optional native companion for `mirk.store.sqlite_vec`. It builds pinned sqlite-vec 0.1.6 with an additional `vec_cosine_similarity_f64` function. The existing upstream float32 functions remain unchanged. The added function reads float32 BLOBs and accumulates products in float64, in component order. It returns similarity directly, excludes unusable stored vectors, and returns zero for a finite zero query.

Source installation requires a C compiler. The wheel build compiles bundled, checksum-verified source once. Queries never compile or download code. Binary wheels carry their platform tag; only the wheel built on this host has been exercised. A failed build remains an installation error. Mirk itself can run without the optional companion.

`loadable_path()` returns the extension path from the installed platform wheel. Use it through `sqlite_vec_engine()` in Mirk; the companion itself opens no database. Only macOS arm64 has been exercised. The Linux and Windows compiler recipes need platform testing before a supported-platform claim.

The canonical vendored inputs and patch live under `native/sqlite-vec` in the Mirk repository. Package preparation verifies input and patched-source SHA-256 checksums. Source distributions contain the prepared source, headers, patch, provenance and upstream MIT license. SQLite headers are from the public-domain SQLite 3.45.3 amalgamation. No upstream download occurs during installation.

The float64 loop uses the same component order, products, additions, square roots and final division as the memory reference. Every finite float32 product is exactly representable as float64, and float32 magnitude extremes remain within float64 range. Compiler flags disable fast-math reassociation and contraction. Returning similarity directly avoids an extra `1 - distance` cancellation. The shared vector corpus checks cutoff membership, zero queries, non-finite stored values, magnitude extremes and tie ordering.

When this optional companion or its compiled binary is absent, Mirk selects its existing ordinary exact search engine for that connection and reports `accelerated: false`. The companion path API identifies missing capability with `native-companion-unavailable`. A broken native query, malformed binary/manifest, checksum failure or version mismatch remains a visible error. No compilation runs during a search.
