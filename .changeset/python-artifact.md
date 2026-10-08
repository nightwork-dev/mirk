---
"@mirk/artifact": patch
---

Bind artifact commits to matching object leases and protect direct deletion from
concurrent writers. Preserve conflicts for retired idempotency keys, reject
invalid producer records, and prevent static filesystem symlink escapes.

Add the native Python artifact distribution with generated lifecycle conformance
cases and shared SQLite/filesystem exchange tests. Preserve process interrupts
while cleaning up incomplete writes and rolling back metadata changes.
