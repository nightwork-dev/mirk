---
"@mirk/surreal": minor
---

Caller-triggerable errors now carry a `code`, with unchanged messages and base classes: `SurrealVectorError` (`@mirk/surreal/vector`: `invalid-dimensions`, `dimensions-unknown`, `dimensions-changed`, `invalid-top-k`, `invalid-vector`, `invalid-identifier`), `SurrealGraphError` (`@mirk/surreal/graph`: `graph-not-configured`, `invalid-identifier`, `invalid-edge-record`), `SurrealIdentifierError` and `SurrealValueError` (`@mirk/surreal/store`), and `SurrealObjectStoreValidationError` (a `TypeError`: `invalid-object-key`, `invalid-byte-chunk`, `invalid-identifier`) and `SurrealObjectStoreOptionError` (a `RangeError`: `invalid-option`) from `@mirk/surreal/storage`. `SurrealObjectStoreGenerationError` now takes a code as its first constructor argument. Every Surreal error class defines `name` on its prototype, so `Object.keys(error)` no longer includes `name`.
