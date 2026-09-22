---
"@mirk/store-postgres": patch
---

Validation errors are now `PostgresAdapterError`, `PostgresValueError` (a `TypeError`) and `PostgresRangeError` (a `RangeError`) instances with a stable `code`. Messages and base error types are unchanged.
