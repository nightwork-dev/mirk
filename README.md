<p align="center">
  <img src="docs/banner.png" alt="mirk — a glowing wordmark emerging from a dark abyssal depth, with a luminous data-structure receding into the murk on the right" />
</p>

# mirk

> **Everything your app keeps, behind one storage layer.** Records, vectors, full-text search, and
> the links between things, in one SQLite file today and on a bigger backend later, behind the
> same interfaces.

![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![status](https://img.shields.io/badge/status-pre--1.0-orange) ![stack](https://img.shields.io/badge/TypeScript-pnpm%20%C2%B7%20vitest-3178c6) ![module](https://img.shields.io/badge/ESM-only-2bd4ff) ![black october](https://img.shields.io/badge/updated%20for-Black%20October-0b0b0b)

## Why

Most storage libraries answer one question: _where do I put this value?_ You get `get` and `set`,
and the backend underneath can change. That is enough until the app needs more than lookups. It
needs the open tasks, sorted by due date. It needs the documents closest to an embedding, the notes
that mention "invoice", and everyone a character knows. Each of those usually brings its own
library, its own connection, and its own rules about ordering and missing values.

**mirk** answers a bigger question: _where does my app's data live, and will it behave the same
when I move it?_ One SQLite file holds key-values, queryable collections, vectors, a full-text
index, and links between records. They share one connection, so one transaction can cover all of
them. Build and test against the in-memory version with nothing installed, then point the same
code at a SQLite file.

"Behaves the same" is tested, not assumed. About 200 shared scenarios fix the details that usually
drift between backends. A task with no due date sorts last in both directions. Equal values keep
the order they were written in. Paging happens after sorting. The in-memory store and both SQLite
adapters must pass every scenario. The Python port runs them too, against the same SQLite files
TypeScript writes.

## A first look

```ts
import { NodeSqliteAdapter } from "@mirk/store/node-sqlite"; // Node 24+, nothing to install

const db = new NodeSqliteAdapter({ path: "app.db" });

// Key-values and queryable collections
db.kv.set("settings", { theme: "dark" });
db.kv.put("tasks", { id: "t1", title: "Send invoice", status: "open", due: "2026-11-01" });
db.kv.list("tasks", { where: { status: "open" }, sortBy: "due" });

// Full-text search
db.search.index("notes", { id: "n1", fields: { title: "Invoice", body: "Send the October invoice" } });
db.search.search("notes", "invoice");

// Vector search, ranked by exact cosine
const embedding = new Float32Array(768); // your model's output
db.vector.upsert("docs", { id: "a", vector: embedding });
db.vector.search("docs", embedding, { topK: 10 });

// One transaction across all of it
db.transaction(() => {
  db.kv.put("tasks", { id: "t2", title: "Pay deposit", status: "open", due: "2026-10-30" });
  db.search.index("notes", { id: "n2", fields: { title: "Deposit", body: "Pay the venue deposit" } });
});

db.close();
```

Code that takes the interface instead of the adapter runs on any store that provides it:

```ts
import { InMemoryKv, toAsync, type SyncStore } from "@mirk/store/kv";

function openTasks(store: SyncStore) {
  return store.list("tasks", { where: { status: "open" }, sortBy: "due" });
}

openTasks(new InMemoryKv()); // in tests
openTasks(db.kv);            // in the app
toAsync(db.kv);              // the same store, with the async interface remote backends use
```

## One file, many capabilities

A **source adapter** opens one connection and hangs each capability off it: `.kv`, `.vector`,
`.search`. You do not run three libraries with three connections and three transaction scopes.

<p align="center">
  <img src="docs/diagrams/source-adapter.svg" alt="SqliteAdapter is one SQLite connection; a .kv facet (key-value and collections) and a .vector facet (exact cosine) both ride that single connection. The in-memory backends implement the same interfaces with no native code." width="820" />
</p>

Each capability is its own import, so you load only what you use. Importing `@mirk/store/kv` loads
no database at all.

Local stores are **synchronous**, because a local SQLite call finishes in microseconds and a
Promise around it only adds cost. Remote backends are async, and `toAsync` gives any local store
the same async shape.

## Choosing a store

| You want                                   | Use                                        | Covers                                  |
| ------------------------------------------ | ------------------------------------------ | --------------------------------------- |
| To build and test with nothing installed   | the in-memory stores in `@mirk/store`      | everything                              |
| A local database file on Node 24+          | `@mirk/store/node-sqlite`                  | everything                              |
| A local database file on Node 22           | `@mirk/store/sqlite` with `better-sqlite3` | everything                              |
| Records that people edit as Markdown files | `@mirk/store-markdown`                     | key-values and collections              |
| Storage in the browser                     | `@mirk/store-indexeddb`                    | key-values and collections              |
| A hosted SQLite database (Turso, `sqld`)   | `@mirk/store-libsql`                       | key-values, collections, and vectors    |
| Many processes writing at once             | `@mirk/store-postgres`                     | key-values and collections              |
| SurrealDB, embedded or remote              | `@mirk/surreal`                            | key-values, collections, vectors, links |
| A dedicated vector database                | `@mirk/vector-qdrant`                      | vectors                                 |

The in-memory and SQLite stores are the reference. The IndexedDB and Qdrant adapters also run the
shared scenarios for what they cover. Each package README lists any place where it differs from the
reference.

## Also in the box

- **Authored data** — [`@mirk/fixtures`](packages/fixtures) loads typed data packs such as
  defaults, templates, and content. It validates them, layers overrides, and records which source
  each value came from.
- **Files and blobs** — [`@mirk/artifact`](packages/artifact) stores bytes with a checksum, metadata,
  and a record of what each file was made from. [`@mirk/artifact-opendal`](packages/artifact-opendal)
  puts those bytes on S3 or another OpenDAL backend.
- **Moving between backends** — [`@mirk/migrate`](packages/migrate) copies data from one store to
  another and resumes where it stopped.
- **Revision history** — [`@mirk/statements`](packages/statements) is specialized storage for hosts
  that track what was true and when it was recorded.

## Python

The Python packages implement the same interfaces and run the same scenarios. They open SQLite files
written by TypeScript, and TypeScript opens theirs.

| Package                 | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `mirk-store`            | key-values, collections, vectors, search, and links on stdlib SQLite |
| `mirk-fixtures`         | authored data packs                                                  |
| `mirk-artifact`         | files and blobs, readable from TypeScript                            |
| `mirk-store-markdown`   | Markdown file storage                                                |
| `mirk-artifact-opendal` | file bytes on S3-compatible storage                                  |
| `mirk-vector-qdrant`    | vectors on Qdrant                                                    |

## Install

```bash
npm install @mirk/store
npm install better-sqlite3   # only for @mirk/store/sqlite
```

ESM only. Use a patched Node release: 22.23.4+, 24.22.1+, or 26.12.1+. The built-in
`node:sqlite` adapter needs Node 24 or later.

## Status

Pre-1.0: minor versions may change APIs. Each package README is that package's contract. Release
history is in [`CHANGELOG.md`](CHANGELOG.md), planned work is in
[`docs/roadmap.md`](docs/roadmap.md), and development and release steps are in
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
