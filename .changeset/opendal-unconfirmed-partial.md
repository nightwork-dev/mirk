---
"@mirk/artifact-opendal": patch
---

A failed write whose partial object the adapter cannot delete and confirm gone now throws
`ObjectWriteIndeterminateError` instead of `ObjectWriteRejectedError`, so `ArtifactCoordinator`
keeps the object rather than reporting that nothing landed. The Python adapter behaves the same, and
also removes the partial object of an unconditional write that conflicts while closing.
