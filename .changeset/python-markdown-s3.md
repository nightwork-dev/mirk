---
"@mirk/store-markdown": patch
---

Reject empty keys, protect records from custom index filename collisions, and
restrict optional Git commits to each store mutation's files. Preserve unrelated
staged work and sort string fields by Unicode code point.
Reject equivalent filenames and verify record identity before reading or deleting case aliases.

Add Python Markdown and OpenDAL artifact adapters, generated Markdown conformance
cases, and an isolated real S3 integration job. The new Python distributions have
their own initial versions and do not bump other npm packages.
