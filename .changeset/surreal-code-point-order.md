---
"@mirk/surreal": patch
---

`SurrealStoreAdapter.keys()` now orders by Unicode code point instead of locale collation, so results no longer depend on case, accents, or the runtime's ICU locale.
