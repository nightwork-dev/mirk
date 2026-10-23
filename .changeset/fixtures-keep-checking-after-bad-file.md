---
"@mirk/fixtures": patch
---

`validate()` keeps checking a source's other files after one fails to parse or read, as the README says. A reference into a file left out that way is the warning `unresolved-reference`, not `missing-reference`. Positioned parsers now put a line and column `range` on schema, `missing-reference` and `invalid-ref` diagnostics. The CLI help shows the config as required for `show` and `explain`.
