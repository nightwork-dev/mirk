---
"@mirk/store": minor
"@mirk/store-libsql": minor
---

Physical table names now come from a `_mirk_tables` registry instead of a hash. Two collection names that sanitize and hash alike (`"%$;**@"` and `"~,~$(*"`) no longer share one table: the hash-derived name is only the first candidate, and a name whose candidate is claimed gets `_2`, `_3`, and so on. Only the first candidate is ever adopted, so a stray table left by an interrupted run is skipped rather than claimed. Files gain `_mirk_meta` with `schema_version = "2"`, and a file stamped with a higher version refuses to open. Existing files are adopted in place with no rewrite.
