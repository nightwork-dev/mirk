---
"@mirk/migrate": patch
---

Thrown errors are now `MigrationError` instances with a stable `code`. Messages and the base `Error` type are unchanged.
