---
"@mirk/store": minor
---

Add `@mirk/store/log`, an append-only log of JSON records in named streams. `append(stream, record)` returns the record's sequence: sequences are per stream, start at 1, and have no gaps among committed appends. `get(stream, sequence)`, `list(stream, { after, limit })`, and `lastSequence(stream)` read it back for replay and tailing. `InMemoryLogStore` is the reference, `toAsyncLog` lifts a log to `AsyncLogStore`, and records follow the strict JSON rules of atomic writes (`LogInputError`).

The SQLite adapters gain `.log` and `.asyncLog` over a new `_mirk_log` table. An append is one statement, so its number and its record commit together or not at all. Inside `transaction()` or `asyncTransaction()` an append rolls back with the transaction, and its sequence goes to the next append. An append that cannot take the write lock throws `AtomicMutationBackendError` (`unavailable`, retryable); a transaction that reads and then appends should use `transaction(work, "immediate")`. The Python port (`mirk.store.log`, `mirk.store.sqlite_log`) reads and writes the same table, and new `log/*` conformance scenarios run in both languages.
