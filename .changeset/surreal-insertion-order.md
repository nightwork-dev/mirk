---
"@mirk/surreal": patch
---

The Surreal store now returns collection rows in insertion order, as the memory and SQLite stores do. An unsorted `list()` and `listWhereIn()` return rows in the order they were first put, and rows with equal sort values keep that order in both directions. Records written by earlier versions still load; they come first, in id order. The store also accepts the empty id and the empty KV key, keeps strings that contain lone surrogates, rejects non-scalar `where` and IN values with `StoreFilterError`, uses the same empty collection name message as the other stores, and no longer fails when several puts define a new collection at the same time. `SurrealVectorAdapter.upsertMany` now reads the collection dimensions once per batch and checks every vector before it writes any. The store conformance test replays the whole store corpus except the atomic scenarios.
