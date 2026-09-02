# 2026-09-02 — phase 2 plan review, codex gpt-5.6-luna (xhigh), fresh context

Findings folded into docs/python-port/plan-phase2.md the same day (rulings 2, 5, 6, 7; wave 0 restructured around the atomic API; OpenDAL and package-resource sources deferred).

## 1. Most dangerous ruling

**Ruling 2’s “lone surrogates are out of contract” is wrong.** The artifact digest records real TypeScript behavior: `JSON.stringify` emits a lone surrogate as `\ud800`, and the proposed corpus explicitly includes it (`digests/artifact.md` §2.3, §2.5, §12 cases 17–18). Rejecting it changes the existing contract and discards the best UTF-8 portability probe. Python should escape it before UTF-8 encoding.

The number rule is also incomplete:

- Test `-0` inside arrays and nested objects, not only as a scalar. The corpus needs a wrapper that preserves negative zero (`digests/artifact.md` §13.1).
- Explicitly reject `NaN` and both infinities with `non-finite numbers are not JSON-safe` (`digests/artifact.md` §2.4–2.5). H0 does not name this case.
- “Shortest round-trip digits” does not fully specify decimal packaging. Pin `5e-324`, `1e100`, and both `1e21`/`1e-7` boundaries, plus float64 clamping of `2^53+1` (`digests/artifact.md` §2.4, §13.3).

The JSON Schema criterion is currently **false confidence unless normalized**. Ajv and Python `jsonschema` differ in short-circuiting, nested `oneOf`/`anyOf` contexts, and aggregate `if`/`oneOf` errors (`digests/fixtures.md` §12.3). Define “path” as flattened leaf instance paths, configure Ajv’s error behavior explicitly, flatten Python `context`, and specify whether aggregate keyword paths count. Otherwise equal path sets do not prove equivalent validation.

## 2. Wave ordering

No. H0 is the thinnest **hash probe**, not the thinnest real cross-language transaction.

The first real transaction should be:

1. Build current TypeScript `dist`.
2. TypeScript uses `ArtifactCoordinator`, `StoreArtifactRepository` over SQLite, and `FileObjectStore` to finalize one artifact with injected id/clock.
3. A fresh Python process opens the same SQLite file and object directory, verifies the artifact, reads its bytes, and reads lineage.

That exercises the actual artifact boundary described in `plan-phase2.md` A2 and `digests/artifact.md` §4.2, §5.6, rather than only a pure hash function. Run the reverse direction immediately afterward. Atomic interop must precede this.

## 3. Atomic API scope

Yes. Make it a separate Wave-0 prerequisite, owned by `@mirk/store`, with `conformance/store/atomic/`. A2 currently hides a substantial store-port inside “depends on `mirk.store`” (`plan-phase2.md` A2).

Its corpus and SQLite exchange must pin:

- `_mirk_atomic_identity`, `_mirk_atomic_sequence`, and `_mirk_atomic_versions`: exact columns, initialization, key encoding, and row semantics (`python-port-spec.md` Python package).
- `getVersioned` missing/present behavior and the exact version-token type and serialization.
- Sequence allocation, increment timing, and whether failed mutations consume sequence values.
- `mutateAtomically` expected-version/`"missing"` behavior, operation order, conflict result, rollback, and durability.
- Receipt key/value shape, canonical request fields, omission rules, UTF-8 bytes, lowercase SHA-256 digest, and record identity. Artifact’s store layout specifically depends on receipts containing `{requestDigest, recordId}` (`digests/artifact.md` §5.5–5.6).
- Both directions: TypeScript-created SQLite opened and mutated by Python, then Python-created state observed by TypeScript. No raw-table setup as the proof.

Artifact scenarios should consume this contract, not duplicate it.

## 4. Unnecessary scope

Delete or defer:

- **OpenDAL** and the `artifact-opendal` workspace member from this phase. It is an optional adapter with an external binding, not required for core artifact interoperability (`plan-phase2.md` O1; `digests/artifact.md` §8.4).
- **Package-resource fixtures** now. It is only a thin `file:` filesystem wrapper; package resolution occurs in the caller (`digests/fixtures.md` §3.4).
- **The shared `fixtures-tree` corpus.** It adds environment-bound files without strengthening the JSON loader contract. Keep filesystem containment and symlink tests as language-local tests only if a real consumer needs the filesystem source (`digests/fixtures.md` §3.3, §13 assertions 44–49).

## 5. First-hour traps

- F1 says Ajv is a package dependency and F2 says `jsonschema` is a package dependency, but the spec requires both validators to be **injected**, preserving browser safety and zero runtime dependencies (`plan-phase2.md` F1–F2; `python-port-spec.md` §12.2).
- The corpus path conflicts: H0 says `artifact/hash/`, while the artifact corpus proposal says `artifact/hashing/{bytes,canonical-json,...}` (`plan-phase2.md` H0; `digests/artifact.md` §13).
- “No skips” conflicts with TypeScript-only error cases marked for Python skipping (`digests/artifact.md` §13.4; `conformance/README.md` Ports and capabilities are hard gates). Put those in language-local tests or define a non-skipping corpus mechanism.
- The existing scenario format has no validation expectation for `ok + paths + code + fixture + source + path`; F1 must extend the schema and both runners (`conformance/README.md` Scenario format; `digests/fixtures.md` §12.3).
- H0’s `ports: ["hash"]` requires an explicit extension to the current five-port runner contract, not an ad hoc target in `backends.ts` (`conformance/README.md` Ports and capabilities).
