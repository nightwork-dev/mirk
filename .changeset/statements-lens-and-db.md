---
"@mirk/statements": patch
---

A lens with `sourceIds` filters before `limit`, so it returns up to `limit` matching rows. A `validAt` lens matches instant bounds only; statements with `before` or `after` anchor bounds are no longer matched by accident. `path` is optional when `db` is passed with an explicit `coordinator`; `db` alone throws `missing-coordinator`.
