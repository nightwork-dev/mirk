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

For an owned Node embedded connection, install the optional `@surrealdb/node` peer and use the
dedicated subpath:

```ts
import { createNodeSurrealConnection } from "@mirk/surreal/node";

const connection = await createNodeSurrealConnection({
  endpoint: "surrealkv://data/app",
  namespace: "app",
  database: "prod",
});
```

For an owned browser-embedded connection, install the optional `@surrealdb/wasm` peer and use the
dedicated subpath:

```ts
import { createWasmSurrealConnection } from "@mirk/surreal/wasm";

const connection = await createWasmSurrealConnection({
  namespace: "app",
  database: "local",
});
```

The helper defaults to `mem://`, owns the WASM client it creates, and accepts
`engineOptions` for SurrealDB WASM engine configuration. Vite applications must exclude
`@surrealdb/wasm` from dependency optimization so its sibling `.wasm` binary retains a valid URL.

### IndexedDB is not supported

Published `@surrealdb/wasm` versions up to 3.0.3 fail on `indxdb://` connections as soon as a
namespace and database are selected (upstream
[surrealdb.js#571](https://github.com/surrealdb/surrealdb.js/issues/571)). Use `mem://` in the
browser, or a remote SurrealDB server.

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
| `@mirk/surreal/wasm` | supported for `mem://` | owned browser WASM connection; `indxdb://` is not supported (see above) |

`SurrealStoreAdapter` and `SurrealObjectStore` can share one connection as the backing for
`@mirk/artifact`'s `StoreArtifactRepository` and `ArtifactCoordinator`.

To run the store, vector, graph, and object-storage smoke against a real server after build:

```bash
MIRK_SURREAL_REMOTE_URL=ws://127.0.0.1:8000/rpc pnpm --filter @mirk/surreal test:remote
```
