<p align="center">
  <img src="docs/banner.png" alt="mirk — a glowing wordmark emerging from a dark abyssal depth, with a luminous data-structure receding into the murk on the right" />
</p>

# mirk

> **Ports you import. Adapters you choose.** The dark foundational layer of storage — key-value, collections, and vector search as code-split primitives with no domain baked in.

![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![status](https://img.shields.io/badge/status-pre--1.0-orange) ![stack](https://img.shields.io/badge/TypeScript-pnpm%20%C2%B7%20vitest-3178c6) ![module](https://img.shields.io/badge/ESM-only-2bd4ff)

## What is this?

Most apps reach for one of two things when they need to store something. A **full database** — and
inherit a server, a daemon, an async API, and a native dependency in the client bundle they never
asked for. Or a **pile of single-purpose libraries** — each with its own idioms, its own
connection, repeated once per capability.

**mirk** is the layer underneath both: small, typed, durable storage primitives with no domain
baked in — somewhere to put key-values, somewhere to put vectors, similarity search over them. You
assemble them from clean **interface ports** and swappable **source adapters**. Build against an
in-memory reference with nothing installed; swap in SQLite for persistence without changing a line
of your own code.

A blog, a game, or an agent host can all draw from the same foundation. Published under the
`@mirk/*` scope.

## One source, many capabilities

A *source adapter* opens **one** backend connection and serves several capability **facets** over
it. `SqliteAdapter` is a single `better-sqlite3` database exposing a `.kv` facet (a `SyncStore`)
**and** a `.vector` facet (a `VectorStore`) — not two libraries, two connections, and two
transaction scopes.

<p align="center">
  <img src="docs/diagrams/source-adapter.svg" alt="SqliteAdapter is one better-sqlite3 connection; a .kv facet (SyncStore: key-value + collections) and a .vector facet (VectorStore: cosine, vec0-accelerated) both ride that single connection. The same ports are implemented zero-native by the in-memory backends." width="820" />
</p>

The facets implement the same `SyncStore` / `VectorStore` ports that the zero-native in-memory
backends do — so you can build and test against memory, then drop in the SQLite adapter for the
real thing.

## Code-split — import only what you need

Each capability is its own subpath. The **ports** and their in-memory references are native-free;
native bindings appear in exactly one place — the SQLite adapter — as **optional peer
dependencies**. Import `@mirk/store/kv` or `/vector` and no binding enters your bundle.

<p align="center">
  <img src="docs/diagrams/code-split.svg" alt="Three subpaths: @mirk/store/kv and @mirk/store/vector are zero native deps; @mirk/store/sqlite is the source adapter and the only one pulling native optional peers (better-sqlite3, sqlite-vec). Import a port subpath and no native binding enters your bundle." width="900" />
</p>

| Import | What you get | Native deps |
|---|---|---|
| `@mirk/store` | the ports, their in-memory references, `toAsync`, cosine helpers | none |
| `@mirk/store/kv` | `SyncStore` port (key-value + collections) · `InMemoryKv` · `toAsync` | none |
| `@mirk/store/vector` | `VectorStore` port · `InMemoryVectorStore` · cosine helpers | none |
| `@mirk/store/sqlite` | the SQLite source adapter — one connection, `.kv` + `.vector` facets | `better-sqlite3` (peer) · `sqlite-vec` (optional peer) |

## Sync by design

Embedded backends are **synchronous** — `better-sqlite3` is, and an async-everywhere interface
taxes every local call with a Promise it doesn't need. A `SyncStore` lifts to an async API via
`toAsync(store)`; the reverse is impossible. Pick sync for embedded and local; reach for async only
where a remote backend genuinely requires it.

## Install

```bash
npm install @mirk/store
# Using @mirk/store/sqlite? Add its peer:
npm install better-sqlite3
# Optional: vec0 KNN acceleration (graceful exact-JS fallback without it)
npm install sqlite-vec
```

ESM-only. Node ≥ 20.

## A taste

```ts
// Zero native deps — build against the in-memory reference.
import { InMemoryKv, toAsync } from "@mirk/store/kv";

const kv = new InMemoryKv();
kv.set("user:1", { name: "Ada" });
kv.get<{ name: string }>("user:1");   // { name: "Ada" }

const remote = toAsync(kv);            // same surface, Promises (sync ⊂ async)
await remote.get("user:1");
```

```ts
// One SQLite connection, two capability facets over it.
import { SqliteAdapter } from "@mirk/store/sqlite";

const db = new SqliteAdapter({ path: "data.db", dimensions: 768 });

db.kv.set("user:1", { name: "Ada" });               // key-value + collections

const embedding = new Float32Array(768);            // your real embedding
db.vector.upsert("docs", { id: "a", vector: embedding });
db.vector.search("docs", query, { topK: 10 });      // ranked by cosine

db.close();
```

Vectors rank by **exact cosine**; install the optional `sqlite-vec` peer and the same search is
transparently vec0-accelerated, with identical rankings. Full API in
[`packages/store/README.md`](packages/store/README.md).

## Design

- **Ports vs source adapters.** Interfaces and in-memory references stay native-free; source
  adapters implement one or more ports over a single connection and are the only place native
  bindings appear.
- **No barrels.** `export *` is forbidden; every entry declares explicit named re-exports.
- **Optional-peer native deps**, referenced solely from the sqlite adapter.
- **Backend parity.** The in-memory reference and the sqlite adapter must behave identically —
  ordering, tie-breaks, null/zero handling. Cross-backend parity tests are the contract.

## Develop

```bash
pnpm install
pnpm build      # tsup, per package
pnpm test       # vitest — real backends, real persistence, real assertions
pnpm -r typecheck
```

## Status

Pre-1.0. The public API should be considered unstable until the first tagged release.

Roadmap: [`docs/roadmap.md`](docs/roadmap.md). The draft `@mirk/fixtures` authored-data primitive
spec lives at [`docs/fixtures-spec.md`](docs/fixtures-spec.md), with the package README draft at
[`packages/fixtures/README.md`](packages/fixtures/README.md).

## License

Apache-2.0 © David Robinson. See [LICENSE](LICENSE).
