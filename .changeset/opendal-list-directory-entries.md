---
"@mirk/artifact-opendal": patch
---

`OpenDalObjectStore.list(prefix)` no longer returns the prefix's own directory entry (for example `objects/` from `list("objects/")`); it lists object keys only, as the `ObjectStore` contract requires. A prefix is now a plain string prefix, as in the memory and filesystem stores: `list("objects/a")` also returns `objects/ab`. `OpenDalObjectStoreError` now defines `name` on its prototype, so `Object.keys(error)` no longer includes `name`; `error.name` is unchanged.
