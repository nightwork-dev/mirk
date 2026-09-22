---
"@mirk/artifact-opendal": patch
---

`OpenDalObjectStore.list()` now orders keys by Unicode code point instead of locale collation, matching `@mirk/artifact`'s filesystem store.
