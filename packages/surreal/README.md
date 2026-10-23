# @mirk/surreal

Use SurrealDB as the place your Mirk data lives: records, graph links, embeddings, and stored
files, over one shared connection.

## Why

Mirk starts with a single SQLite file, which is the right choice for one app on one machine. Some
apps outgrow that in a specific way:

- Several processes or several machines need to read and write the same data.
- The app runs in a browser and needs data that survives a reload.
- The team already runs a SurrealDB server, and the app's data should live there.
- Links between records should be walked by the database itself, to a bounded depth.

`@mirk/surreal` answers those cases. It implements Mirk's async interfaces (`AsyncStore` and the
graph, vector, and object-store interfaces). Code that already uses the async form of a Mirk store,
for example through `toAsync`, keeps working when you change the line that opens the store.

You open one `SurrealConnection`. Each adapter then lives on its own subpath, so you import only
what you use:

| Subpath | Status | What it gives you |
|---|---|---|
| `@mirk/surreal` | supported | `SurrealConnection`, the one connection every adapter shares |
| `@mirk/surreal/store` | supported | `AsyncStore` and `AsyncStoreInQuery`: key-values and queryable collections |
| `@mirk/surreal/graph` | supported | explicit relation mapping and native bounded traversal |
| `@mirk/surreal/vector` | supported | async cosine vector operations |
| `@mirk/surreal/storage` | supported | chunked `ObjectStore` with renewable upload leases |
| `@mirk/surreal/search` | unsupported by design | fails closed; Surreal's current single-field FTS cannot satisfy Mirk's weighted multi-field search contract |
| `@mirk/surreal/node` | supported | owned Node embedded connection; `surrealkv://` data persists across reopen |
| `@mirk/surreal/wasm` | supported | owned browser WASM connection for `mem://` and `indxdb://` |

If you need full-text search, use the SQLite adapters.

## A first look

This opens an embedded SurrealDB that keeps its data in a folder, then stores and queries records.
It needs the optional Node engine (see [Embedded in Node](#embedded-in-node)).

```ts
import { createNodeSurrealConnection } from "@mirk/surreal/node";
import { SurrealStoreAdapter } from "@mirk/surreal/store";

const connection = await createNodeSurrealConnection({
  endpoint: "surrealkv://data/app",
  namespace: "app",
  database: "prod",
});
const store = await SurrealStoreAdapter.open(connection);

await store.set("settings/theme", "dark");
await store.put("projects", { id: "p1", name: "Beta", priority: 1 });
await store.put("projects", { id: "p2", name: "Alpha", priority: 1 });
await store.put("projects", { id: "p3", name: "Gamma", priority: 2 });

await store.get("settings/theme"); // "dark"
await store.list("projects", { where: { priority: 1 }, sortBy: "name" });
// [{ id: "p2", name: "Alpha", priority: 1 }, { id: "p1", name: "Beta", priority: 1 }]

await connection.close();
```

Run it again and the data is still there, because `surrealkv://` persists.

To use a SurrealDB server instead, open the connection with the server's address. The rest of the
code is unchanged:

```ts
import { SurrealConnection } from "@mirk/surreal";
import { SurrealStoreAdapter } from "@mirk/surreal/store";

const connection = await SurrealConnection.open({
  endpoint: "wss://example.surreal.cloud",
  namespace: "app",
  database: "prod",
  authentication: {
    username: process.env.SURREAL_USER,
    password: process.env.SURREAL_PASS,
  },
});

const store = await SurrealStoreAdapter.open(connection);
```

## Connection

`SurrealConnection` is the shared connection owner for the package. The root import depends only on
the standard `surrealdb` SDK and supports remote `ws`, `wss`, `http`, and `https` endpoints.

Pass `client` when your application owns a preconfigured SDK instance. This is the path for embedded
engines today:

```ts
import { Surreal, createRemoteEngines } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import { SurrealConnection } from "@mirk/surreal";

const client = new Surreal({
  engines: {
    ...createRemoteEngines(),
    ...createNodeEngines(),
  },
});

const connection = await SurrealConnection.open({
  client,
  endpoint: "mem://",
  namespace: "app",
  database: "test",
});
```

Closing a `SurrealConnection` closes only clients it created itself. Injected clients stay owned by
the caller. Adapters never close the shared connection and never open hidden clients.

### Embedded in Node

For an owned Node embedded connection, install the optional `@surrealdb/node` plugin with the
native engine pinned to `3.3.4`, then use the dedicated subpath:

```sh
npm install surrealdb@^2.1.1 @surrealdb/node@^3.1.0 @surrealdb/node-native@3.3.4
```

```ts
import { createNodeSurrealConnection } from "@mirk/surreal/node";

const connection = await createNodeSurrealConnection({
  endpoint: "surrealkv://data/app",
  namespace: "app",
  database: "prod",
});
```

This package pins the native engine peer to `3.3.4`. The plugin and engine versions are independent;
`@surrealdb/node` exposes `engineVersion()` when an application needs to verify the loaded embedded
engine.

### Embedded in the browser

For an owned browser-embedded connection, install the optional `@surrealdb/wasm` plugin with the
native engine pinned to `3.3.4`, then use the dedicated subpath:

```sh
npm install surrealdb@^2.1.1 @surrealdb/wasm@^3.1.0 @surrealdb/wasm-native@3.3.4
```

```ts
import { createWasmSurrealConnection } from "@mirk/surreal/wasm";

const connection = await createWasmSurrealConnection({
  namespace: "app",
  database: "local",
});
```

The helper defaults to `mem://`, owns the WASM client it creates, and accepts
`engineOptions` for SurrealDB WASM engine configuration. Vite applications must exclude both
`@surrealdb/wasm` and `@surrealdb/wasm-native` from dependency optimization so the native loader's
`.wasm` binary retains a valid URL.

The pinned `@surrealdb/wasm-native` engine is `3.3.4`. It includes the IndexedDB transaction fix
that was missing from the `3.0.0`–`3.0.3` engine builds (upstream
[surrealdb.js#571](https://github.com/surrealdb/surrealdb.js/issues/571)), so `indxdb://` is
supported by the current browser helper as well as `mem://`.

### Several processes

An embedded engine (`mem://`, `surrealkv://`) belongs to one process. For several processes or
hosts sharing data, connect each to a SurrealDB server endpoint.

### Security and version scope

The SurrealDB SDK and embedded engine versions above include the current SurrealDB security fixes.
The published `3.3.4` native engine source still resolves `rustls` `0.23.45`; this package does
not claim that a separate `rustls` `0.23.46` remediation is included. Remote TLS connections use
the caller's Node runtime and do not use the embedded native engine.

## Store

`@mirk/surreal/store` exports `SurrealStoreAdapter`, an async implementation of `AsyncStore` plus
`AsyncStoreInQuery`.

```ts
import { SurrealStoreAdapter } from "@mirk/surreal/store";

const store = await SurrealStoreAdapter.open(connection);

await store.set("settings/theme", "dark");
await store.put("projects", { id: "p1", name: "Alpha", priority: 1 });

const projects = await store.list("projects", {
  where: { priority: 1 },
  sortBy: "name",
});
```

Collection names are encoded into deterministic safe Surreal table names, so names such as
`foo-bar` and `foo_bar` do not alias. Filter and sort field names are treated as literal top-level
object keys; dotted names are not interpreted as paths. The adapter stores user records under a data
field and returns only that data, so Surreal record ids do not leak into Mirk values.

A range `where` value (`{ seenAt: { gte: since } }`) has the reference semantics. The query selects
the records that have the field, and the adapter applies the bounds to them, so a range is one
statement but not served by an index. `ensureIndex` is accepted and does nothing.

### Ordering

Collection sorting follows Mirk's rules: strings use Unicode code-point order, null and missing
values stay last in both directions, and pagination applies after sorting. A negative limit returns
no rows. An unsorted `list()` returns insertion order, and rows with equal sort values keep it, as in
the other Mirk stores. Putting an existing id again updates it in place; removing it and putting it
again moves it to the end.

Each record carries a `mirk_ordinal` from a SurrealDB sequence (`DEFINE SEQUENCE
mirk_collection_order`), so a remote server must support sequences; the embedded `3.3.4` engines
do. Records written by `@mirk/surreal` 0.2.0 and earlier have no ordinal. They still load, filter,
count, and sort, and an unsorted `list()` returns them first, in Unicode code point order of their
id, followed by the ordered records. Putting one of them again keeps that place. A record whose
`mirk_ordinal` is not a finite number is treated the same way. Concurrent puts each get an ordinal;
their relative order is the order the server allocated them.

### Strings and ids

SurrealDB strings are UTF-8. A string value that holds a lone UTF-16 surrogate is stored as its
UTF-16 code units and read back unchanged. The record's `mirk_codec` field lists the path of each
string stored this way, and reads decode only those paths, so other byte values in the same record
stay bytes. Object keys, record ids, and KV keys are stored as
SurrealDB strings, so a lone surrogate in one of them becomes U+FFFD. SurrealDB rejects an empty
record id, so the empty id and the empty KV key are stored under the array id `[""]`.

### Limits

Vector, graph, search, and object-storage subpaths are separate adapter entry points and are not
re-exported from the root. The store adapter does not implement `@mirk/store/atomic` mutation.

## Sharing one connection

Adapters open on the same `SurrealConnection`. `SurrealStoreAdapter` and `SurrealObjectStore` can
share one connection as the backing for `@mirk/artifact`'s `StoreArtifactRepository` and
`ArtifactCoordinator`: the record lives in the store, the bytes in the object store.
