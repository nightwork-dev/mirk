# @mirk/store-postgres

PostgreSQL source adapter for `@mirk/store`'s asynchronous key-value and collection ports.

```ts
import { PostgresAdapter } from "@mirk/store-postgres";

const postgres = await PostgresAdapter.open({
  connectionString: process.env.DATABASE_URL,
});

await postgres.kv.set("settings", { theme: "dark" });
await postgres.kv.put("projects", { id: "mirk", status: "active" });

await postgres.close();
```

Pass an existing `pg.Pool` to share one pool with application queries or future capability adapters. A caller-provided pool remains caller-owned and is not ended by `close()`.

```ts
import { Pool } from "pg";
import { PostgresAdapter } from "@mirk/store-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const postgres = await PostgresAdapter.open({ pool, schema: "mirk" });
```

The adapter creates `<schema>.kv` and `<schema>.records`. The database role therefore needs permission to create the configured schema and tables, unless they have already been provisioned. Collection names are stored as values and never interpolated as SQL identifiers.

The package implements `AsyncStore` and the optional `AsyncStoreInQuery` capability through `postgres.kv`. It does not currently expose PostgreSQL full-text or vector facets; those require their own explicit parity contracts and imports.
