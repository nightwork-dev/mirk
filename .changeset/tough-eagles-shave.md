---
"@mirk/store": minor
---

Remove the sqlite-vec acceleration path from the SQLite vector facet; it never executed. `forceJsCosine` is gone, `meta.accelerated` is false, `sqlite-vec` is no longer a peer dependency. Existing files keep working, and legacy vec0 shadow tables are left in place; they are inert.
