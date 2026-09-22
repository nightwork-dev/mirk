---
"@mirk/store-markdown": patch
---

`keys()` and unsorted `list()` now order by Unicode code point instead of locale collation, so results no longer depend on case, accents, or the runtime's ICU locale.
