---
"@mirk/store": patch
---

Reject callbacks that return a Promise or thenable before committing a built-in SQLite transaction. Roll back the current transaction or savepoint, matching better-sqlite3 13.
