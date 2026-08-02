# @mirk/statements

Production storage for `statements-storage/v1`: SQLite-backed statement
revisions, durable admission receipts, bitemporal indexes, and named legacy
dual-read parity harnesses.

The package deliberately does not depend on Gonk. Hosts map their
`statements/v1` contract into this storage schema and inject the admission
authority; Mirk owns persistence, serialization, indexes, replay, and crash
consistency.

```ts
import { createSqliteStatementStore } from "@mirk/statements/sqlite";

const statements = createSqliteStatementStore({
  path: "statements.sqlite",
  authority,
});

await statements.admit(envelope);
```

## Subpaths

- `@mirk/statements` — public factory, adapter class, testing helper, and
  storage-schema types.
- `@mirk/statements/sqlite` — SQLite production adapter.
- `@mirk/statements/testing` — named legacy dual-read parity harness.
- `@mirk/statements/types` — storage-schema/v1 TypeScript types only.

The SQLite adapter uses `@mirk/store/coordination` for fenced admission
serialization. Exact idempotent replays return the original result; same-key
different-envelope attempts return `idempotency-conflict` without mutating the
canonical revision log.
