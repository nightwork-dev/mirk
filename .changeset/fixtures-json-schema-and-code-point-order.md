---
"@mirk/fixtures": minor
"@mirk/store": patch
---

Fixture types can declare their authored shape as a JSON Schema document, and every source now orders entries by code point.

`FixtureTypeDefinition` gains `jsonSchema`, a JSON Schema 2020-12 document, and `schema` relaxes from required to optional. The document is DATA, so the same declaration validates the same files in TypeScript and in the Python port, where a Standard Schema validator cannot go. The engine is injected through the new `jsonSchemaValidator` loader option, so the root entry stays browser-safe with no runtime schema dependency; a type that declares `jsonSchema` and gets no factory fails loudly with a `no-json-schema-validator` error rather than loading unvalidated data. When both are present `jsonSchema` runs first and the Standard Schema's output is still the fixture value, so existing callers behave exactly as before. The whole failure surface stays `FixtureValidationError` with code `schema-invalid`.

Two behavior changes come with it. A type declaring neither `jsonSchema` nor `schema` is rejected at `registry.register` with the new code `missing-schema`; `jsonSchema: true` is the explicit way to declare a type whose documents are unconstrained. This is unreachable for callers that already pass a schema.

**Ordering is observable and it changed.** The filesystem source, the store source and the CLI's graph output sorted with `localeCompare`, which is ICU collation: it puts `a` before `Z`, folds case and accents, and depends on the runtime's ICU build. The memory source has always ordered by code point, so the same set of paths listed in different orders depending on which source carried them. All of them now use `compareCodePoints` from `@mirk/store`, matching every other Mirk port and SQLite's BINARY collation. Registered type names and `list()` results sort the same way. Source-entry order is observable in one place — which of several competing errors a broken pack raises first — so a pack with more than one defect may now report a different error than before.

`@mirk/store` gains the `fixtures` conformance port and the corpus `invalidPaths` expect form, which compares a validation result by the set of failing instance paths rather than by an engine's message text. Both are tooling, absent from the package's exports.
