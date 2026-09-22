---
"@mirk/store": patch
---

`SqliteCoordinator` setup now retries on every `SQLITE_BUSY*` and `SQLITE_LOCKED*` error code, as the SQLite adapter already did, instead of only on exact `SQLITE_BUSY`.
