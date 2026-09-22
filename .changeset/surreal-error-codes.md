---
"@mirk/surreal": patch
---

Queries on a closed connection throw `SurrealConnectionError` with `code: "connection-closed"`, and `SurrealSearchAdapter` methods throw `SurrealUnsupportedError` with `code: "unsupported-capability"`. Messages are unchanged, and both still extend `Error`.
