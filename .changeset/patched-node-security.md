---
"@mirk/artifact": minor
"@mirk/artifact-opendal": minor
"@mirk/fixtures": minor
"@mirk/migrate": minor
"@mirk/statements": minor
"@mirk/store": minor
"@mirk/store-indexeddb": minor
"@mirk/store-libsql": minor
"@mirk/store-markdown": minor
"@mirk/store-postgres": minor
"@mirk/surreal": minor
"@mirk/vector-qdrant": minor
---

Require patched supported Node release lines: 22.23.4, 24.22.1, or 26.12.1 and later. Update build and test tooling for published security fixes. Update the Qdrant host guidance to require Undici 7.30.1 or later.

Upgrade the SurrealDB SDK and plugins, and pin embedded engines to 3.3.4. Embedded users must install the separate node-native or wasm-native peer listed in the package README. Raise the OpenDAL Node binding floor to 0.49.13. Document the remaining upstream libSQL and native TLS security gaps.
