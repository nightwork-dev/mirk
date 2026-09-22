---
"@mirk/store-markdown": patch
---

Filename, path, record-id, body, and frontmatter errors now throw `MarkdownStoreError` with a stable `code`. Messages are unchanged, and the error still extends `Error`.
