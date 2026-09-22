---
"@mirk/store": minor
---

Three additive changes in support of the Python port's deterministic conformance corpus. All are backward compatible; no existing export changed shape.

Canonical JSON and SHA-256 move to an internal `canonical.ts` and grow two exports beyond `canonicalJson`: `sha256Hex(text)` over the UTF-8 of a string, `sha256HexBytes(bytes)` over raw bytes, and `canonicalDigest(value)` for the digest of a value's canonical text. `atomic.ts` re-exports `canonicalJson`, so `@mirk/store` and `@mirk/store/atomic` are unchanged from a consumer's side. `compareCodePoints` is now exported from the package root under its real name; it was previously reachable only as the deprecated `compareCodePoint` alias on the atomic subpath, which stays where it is.

Version identity is injectable. `InMemoryKv` takes `versionIdentity`, and so does `SqliteAdapter`, where it is the value written into `_mirk_atomic_identity` when a file is first initialized. A file that already carries an identity keeps it, so reopening with a different value changes nothing. Defaults are unchanged: a per-process serial in memory, a fresh UUID in SQLite. Pinning the identity is what lets a version token be compared by exact value rather than by shape.

The conformance runner contract gains two port names. `atomic` binds the store target and adds `getVersioned` and `mutateAtomically` to it. `hash` binds a pure, backend-independent target exposing `canonicalJson`, `canonicalDigest`, `sha256Hex` and `sha256Bytes`, with wrapper expansion in its args for values JSON cannot express. Scenario ids may now nest beyond two segments; the first segment remains the corpus directory. This surface is tooling, absent from the package's exports.
