---
"@mirk/artifact-opendal": patch
---

Capability and backend-key errors now throw `OpenDalObjectStoreError` with a stable `code`. Messages are unchanged, and the error still extends `Error`.
