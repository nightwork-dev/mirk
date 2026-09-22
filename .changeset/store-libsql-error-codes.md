---
"@mirk/store-libsql": patch
---

Adapter errors are now `LibsqlAdapterError` instances with a stable `code`. Messages and the base `Error` type are unchanged.
