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
Mirk's browser test enforces that bundler configuration in real headless Chromium.

### IndexedDB status

Published `@surrealdb/wasm` versions 3.0.0–3.0.3 run the in-memory engine but contain a confirmed
upstream IndexedDB transaction bug. After `db.connect("indxdb://...")`, selecting a namespace and
database through `db.use()`, connection options, or `USE NS ... DB ...` fails with an `idb error`.
This is tracked as [surrealdb.js#571](https://github.com/surrealdb/surrealdb.js/issues/571) and
[indxdb#9](https://github.com/surrealdb/indxdb/issues/9), and is not caused by Mirk's adapters or
browser test harness.

SurrealDB merged [surrealdb.js#600](https://github.com/surrealdb/surrealdb.js/pull/600), which moves
the WASM package from IndxDB 0.11 to 0.12 and prepares `@surrealdb/wasm@3.0.4`. That fixed package
has not yet been published. Until it is available and Mirk's real-browser write/reopen/read test
passes, use `mem://` or a remote SurrealDB connection; do not advertise or rely on `indxdb://`.

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

The store adapter is tested against the real SurrealDB Node embedded engine. Vector, graph, search,
and object-storage subpaths are separate adapter entry points and are not re-exported from the root.

## Support matrix

| Subpath | Status | Contract |
|---|---|---|
| `/store` | supported | `AsyncStore` and `AsyncStoreInQuery` |
| `/graph` | supported | explicit relation mapping and native bounded traversal |
| `/vector` | supported | async cosine vector operations |
| `/storage` | supported | chunked `ObjectStore` with renewable upload leases |
| `/search` | unsupported by design | fails closed; Surreal's current single-field FTS cannot satisfy Mirk's weighted multi-field search contract |
| `/node` | supported | owned Node embedded connection; compiled SurrealKV persistence is tested across process reopen |
| `/wasm` | supported for `mem://` | owned browser WASM connection, exercised through the Mirk store adapter in real Chromium; `indxdb://` is blocked by [surrealdb.js#571](https://github.com/surrealdb/surrealdb.js/issues/571) until the merged fix is published and passes Mirk's reopen test |

`SurrealStoreAdapter` and `SurrealObjectStore` are integration-tested together through one
connection with `StoreArtifactRepository` and `ArtifactCoordinator`. Persistent connection reopen
is separately proven by the packaged `/node` build smoke test across two processes.

Store, vector, graph relation CRUD, native recursive traversal, object storage, and artifact
composition are exercised against the current real Node embedded engine. Query-recorder tests
remain as additional assertions about bounded query count and capability dispatch, not as a
substitute for engine execution.

The same store, vector, graph, and object-storage smoke can run against a real server after build:

```bash
MIRK_SURREAL_REMOTE_URL=ws://127.0.0.1:8000/rpc pnpm --filter @mirk/surreal test:remote
```
