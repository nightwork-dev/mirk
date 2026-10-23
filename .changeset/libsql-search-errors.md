---
"@mirk/store-libsql": patch
---

Bind the native neighbor count as an SQL integer so native vector search runs correctly. Propagate native vector search errors instead of silently scanning the full collection. Filtered queries and explicit JavaScript scoring retain their existing paths.
