---
"@mirk/store": minor
"@mirk/surreal": patch
---

Export a shared collection sort-and-pagination helper and use it in the memory and Surreal stores. Surreal collection sorting now follows code-point string order and clamps negative limits to zero, matching the existing store conformance scenarios.
