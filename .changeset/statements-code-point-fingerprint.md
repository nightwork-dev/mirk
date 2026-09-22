---
"@mirk/statements": patch
---

Request fingerprints now order object keys by Unicode code point instead of locale collation, so the same request fingerprints identically on every machine; receipts and idempotency conflicts stored by earlier versions are still recognized on replay.
