---
"@mirk/artifact": patch
"@mirk/fixtures": patch
"@mirk/migrate": patch
"@mirk/statements": patch
"@mirk/store-libsql": patch
"@mirk/store-markdown": patch
"@mirk/store-postgres": patch
"@mirk/store": patch
---

Error `name` now lives on the prototype like built-in errors, so it no longer appears in `Object.keys` or `JSON.stringify`.
