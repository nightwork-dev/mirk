---
"@mirk/artifact": patch
---

Validation and operation errors now throw `ArtifactValidationError`, `ArtifactLimitError`, or `ArtifactOperationError`, each with a stable `code`. Messages are unchanged, and each still extends the built-in it threw before (`TypeError`, `RangeError`, or `Error`).
