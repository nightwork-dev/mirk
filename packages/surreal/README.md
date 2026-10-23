# @mirk/surreal

SurrealDB source adapters for Mirk. Open one `SurrealConnection`, then import only the adapter
subpaths you need.

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

### Security and version scope

The SurrealDB SDK and embedded engine versions above include the current SurrealDB security fixes.
The published `3.3.4` native engine source still resolves `rustls` `0.23.45`; this package does
not claim that a separate `rustls` `0.23.46` remediation is included. Remote TLS connections use
the caller's Node or Electron runtime and do not use the embedded native engine.

### Several processes

An embedded engine (`mem://`, `surrealkv://`) belongs to one process. For several processes or
hosts sharing data, connect each to a SurrealDB server endpoint.

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
Collection sorting follows Mirk's rules: strings use Unicode code-point order, null and missing
values stay last in both directions, and pagination applies after sorting. A negative limit returns
no rows.

Vector, graph, search, and object-storage subpaths are separate adapter entry points and are not
re-exported from the root. The store adapter does not implement `@mirk/store/atomic` mutation.

## Support matrix

| Subpath | Status | Contract |
|---|---|---|
| `@mirk/surreal/store` | supported | `AsyncStore` and `AsyncStoreInQuery` |
| `@mirk/surreal/graph` | supported | explicit relation mapping and native bounded traversal |
| `@mirk/surreal/vector` | supported | async cosine vector operations |
| `@mirk/surreal/storage` | supported | chunked `ObjectStore` with renewable upload leases |
| `@mirk/surreal/search` | unsupported by design | fails closed; Surreal's current single-field FTS cannot satisfy Mirk's weighted multi-field search contract |
| `@mirk/surreal/node` | supported | owned Node embedded connection; `surrealkv://` data persists across reopen |
| `@mirk/surreal/wasm` | supported | owned browser WASM connection for `mem://` and `indxdb://` |

`SurrealStoreAdapter` and `SurrealObjectStore` can share one connection as the backing for
`@mirk/artifact`'s `StoreArtifactRepository` and `ArtifactCoordinator`.
