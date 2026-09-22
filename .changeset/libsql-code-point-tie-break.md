---
"@mirk/store-libsql": patch
---

Vector search now breaks equal scores by Unicode code point order of the id instead of locale collation, matching the other Mirk vector backends.
