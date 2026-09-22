---
"@mirk/store": patch
---

Input-validation errors from canonical JSON, search, vector, filter, namespace, and SQLite adapter checks now throw named error classes with a stable `code`. Messages and base error types are unchanged.
