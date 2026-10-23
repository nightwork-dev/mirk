---
"@mirk/store-libsql": patch
"@mirk/store-postgres": patch
---

`mutateAtomically` now costs a fixed number of round trips, whatever the number of operations and
conditions. On libSQL, a request read its condition targets one at a time, wrote each operation
and its version token in its own round trip, and looked up a collection's table again for every
operation until the adapter had committed to it once; 100 puts took about 700 round trips. It now
reads the receipt and tables in one batch, every condition target in a second, and writes every
operation, its version token and the receipt in a third. PostgreSQL reads every condition target
in one query and applies every operation in one statement.
