# @mirk/sqlite-vec-native

> **Native vector search for Mirk's SQLite adapters.** An optional companion to
> [`@mirk/store`](../store) that runs cosine search inside SQLite with
> [sqlite-vec](https://github.com/asg017/sqlite-vec), with the same results as Mirk's built-in
> search.

## Why

`@mirk/store`'s SQLite adapters compute vector similarity in JavaScript. That needs nothing
installed, but every candidate vector crosses from SQLite into JavaScript. With this package, the
scoring, filtering, ranking and limit run on the adapter's own SQLite connection, and only the
result ids, scores and metadata come back.

The results do not change. The package builds sqlite-vec 0.1.6 with one added function,
`vec_cosine_similarity_f64`, which reads the stored float32 vectors and sums in float64, in the same
order and with the same rules as Mirk's JavaScript search. The upstream float32 functions are
unchanged. Search stays exact; there is no approximate index.

## Install

```bash
npm install @mirk/store @mirk/sqlite-vec-native
```

Installing needs a C compiler. The install script compiles the bundled source once; `CC` chooses
the compiler. Nothing is downloaded during install, and nothing compiles during a query. If your
package manager skips install scripts, run the build yourself:

```bash
node node_modules/@mirk/sqlite-vec-native/install.js
```

A failed build is an install error. Builds have been tested on macOS arm64; the Linux and Windows
compiler steps exist but have not been tested yet.

## Use

Pass the engine from `@mirk/store/sqlite-vec` to either SQLite adapter:

```ts
import { NodeSqliteAdapter } from "@mirk/store/node-sqlite";
import { sqliteVecEngine } from "@mirk/store/sqlite-vec";

const db = new NodeSqliteAdapter({ path: "vectors.db", vectorEngine: sqliteVecEngine() });
db.vector.ensureSpace("text", { dimensions: 3 });
db.vector.upsert("docs", { id: "a", vectors: { text: new Float32Array([1, 0, 0]) } });
db.vector.search("docs", { space: "text", vector: new Float32Array([1, 0.1, 0]) });
```

The adapter's vector `meta` reports `engine: "sqlite-vec"` and `accelerated: true`. Files are the
same with or without this package, so you can add or remove it at any time.

- **Missing package or binary.** When the package is not installed, or its binary is missing or
  was built for another platform or architecture, the adapter uses its JavaScript search for that
  connection and reports `accelerated: false`.
- **Broken install.** A malformed binary or manifest, a version mismatch, or a failed native query
  throws `SqliteVecError` from `@mirk/store/sqlite-vec`. It does not fall back quietly.

The package itself opens no database. Its one function, `getLoadablePath()`, returns the path of the
compiled extension, or throws `NativeCompanionUnavailableError` (code `native-companion-unavailable`)
when there is none for this platform.

## What is in the tarball

The prepared sqlite-vec source with Mirk's patch, the SQLite 3.45.3 headers (public domain), a
`provenance.json` with the SHA-256 of every input, and sqlite-vec's MIT license. The build checks
those checksums before it compiles. The compiler flags turn off fast-math reordering, so the float64
sum is computed in the written order.

## License

MIT, the same as sqlite-vec. See `dist/native/LICENSE`.
