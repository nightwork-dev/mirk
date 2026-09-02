# `@mirk/artifact` + `@mirk/artifact-opendal` — behavioral semantics digest

Sources: `packages/artifact/src/{util,types,coordinator,memory,store,fs,maintenance,maintenance-types,index}.ts`,
`packages/artifact-opendal/src/index.ts`, `packages/artifact/README.md`, `docs/artifact-spec.md`,
and the tests `artifact.test.ts`, `hardening.test.ts`, `store.test.ts`, `fs.test.ts`,
`object-store.test.ts`, `object-store-conformance.ts`, `artifact-opendal/test/opendal.test.ts`.
Canonicalization rules come from `packages/store/src/atomic.ts` and `packages/store/src/order.ts`,
which `@mirk/artifact` imports.

Everything marked **PROBED** was verified by executing the real code (a temporary vitest file in
`packages/artifact`, plus a CPython 3 session for the divergence table). The probe file has been
removed; the repository is unmodified by this digest apart from this file.

Companion digest for the layer below: `docs/python-port/digests/store-kv-collection.md`.

---

## 0. Shape of the package

Four entry points, declared explicitly in `packages/artifact/package.json:16-33`:

| Entry | Contents | Native/Node deps |
| --- | --- | --- |
| `@mirk/artifact` | types, `ArtifactCoordinator`, in-memory references, hashing/validation helpers, maintenance | none |
| `@mirk/artifact/store` | `StoreArtifactRepository` over `@mirk/store/kv` | `@mirk/store` |
| `@mirk/artifact/fs` | `FileObjectStore` | `node:fs`, `node:path`, `node:crypto` |
| `@mirk/artifact/maintenance` | `ArtifactMaintenance`, audit/repair types | none |
| `@mirk/artifact-opendal` | `OpenDalObjectStore` | `opendal` (peer) |

Two ports and one coordinator:

- **`ObjectStore`** (`types.ts:70-79`) — physical bytes: `put`, `get`, `head`, `delete`.
  Optional `ListableObjectStore.list(prefix?)` (`types.ts:82-84`).
- **`ArtifactRepository`** (`types.ts:105-121`) — durable metadata: records, digest lookup,
  idempotency lookup, paged list, annotation patch, delete, and lineage edges. Optional
  `removeLineage`. Two optional capability extensions: `AtomicArtifactRepository.createIdempotent`
  (`types.ts:140-147`) and `ArtifactLeaseRepository` (`types.ts:182-216`).
- **`ArtifactCoordinator`** (`coordinator.ts:47`) — binds the two, owns the write/import/verify/
  read/delete protocol, hashing, cleanup, and idempotency.

Implementations shipped: `InMemoryObjectStore` + `InMemoryArtifactRepository` (`memory.ts`),
`FileObjectStore` (`fs.ts`), `StoreArtifactRepository` (`store.ts`), `OpenDalObjectStore`
(`artifact-opendal/src/index.ts`).

---

## 1. Artifact identity — what is hashed, exactly

There are **three** distinct hashes in this package. All three are SHA-256, all three are rendered
as **lowercase hex, 64 characters, no prefix, no base64 anywhere**.

### 1.1 Content digest (`ArtifactDigest`)

`util.ts:45-58` (`digestStream`) and `util.ts:26-43` (`hashingStream`).

- Algorithm: SHA-256 from `@noble/hashes/sha2.js` (`util.ts:1`). This is a real, audited SHA-256,
  **not** the hand-rolled implementation in `packages/store/src/atomic.ts:496`. The store's
  hand-rolled digest is used only for atomic **request** digests inside `@mirk/store`, never for
  artifact bytes. Both produce standard SHA-256, so a Python port uses `hashlib.sha256`
  everywhere and interoperates with both.
- Input: **the raw object bytes exactly as streamed**, with no framing, length prefix, or
  normalization. `sizeBytes` is the sum of `chunk.byteLength` across the stream.
- Output shape: `{ algorithm: "sha256", value: <lowercase hex> }` (`types.ts:10-13`), produced by
  `bytesToHex` (`util.ts:39`).
- `hashingStream` is a pass-through generator: it yields every chunk unchanged while hashing, then
  invokes the completion callback **after the last chunk is consumed**. The coordinator relies on
  this ordering — if the object store never drains the stream, `digest` stays `undefined` and the
  write fails (see 4.2).
- `chunks(source)` (`util.ts:14-24`) accepts either a single `Uint8Array` or an
  `AsyncIterable<Uint8Array>`, and throws `TypeError("artifact byte sources must yield Uint8Array chunks")`
  if any yielded chunk is not a `Uint8Array`. **Chunk boundaries do not affect the digest**, only
  the concatenated byte sequence does.

**PROBED** byte digests (`sha256(bytes)`):

| Input | Digest |
| --- | --- |
| empty (0 bytes) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `hello` (UTF-8) | `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824` |
| single byte `0x00` | `6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d` |
| U+1F600 in UTF-8 (4 bytes) | `f0443a342c5ef54783a111b51ba56c938e474c32324d90c3a60c9c8e3a37e2d9` |

### 1.2 Metadata fingerprint (`metadataFingerprint`)

`util.ts:116-119`:

```
metadataFingerprint(value) = hex(sha256(utf8(canonicalJson(value))))
```

Used for the coordinator's idempotency fingerprint (`coordinator.ts:549-554`), for maintenance
record fingerprints (`maintenance.ts:547-549`), for lineage edge fingerprints
(`maintenance.ts:217, 476`), and for repair action ids (`maintenance.ts:229-234`).

The coordinator fingerprint input is (`coordinator.ts:550-553` with `portableFields`,
`coordinator.ts:557-569`):

```
{ mediaType, kind?, filename?, producer?, annotations?, sources? }
```

`objectKey`, `id`, `createdAt`, `sizeBytes`, `digest`, and `idempotencyKey` are **excluded** —
the fingerprint is about the caller's declared metadata only. Note the falsy guards: `kind` and
`filename` are included only when truthy, so **an empty-string `kind` or `filename` is silently
dropped** and fingerprints identically to omitting it.

### 1.3 Finalization digest (`artifactFinalizationDigest`)

`util.ts:126-142`. This is the request-identity digest that atomic repositories store in their
idempotency receipt.

```
request = {
  schema: "mirk-artifact-finalization/v1",
  mediaType, sizeBytes, digest,
  kind?, filename?, producer?, annotations?      // each present only when !== undefined
}
digest = hex(sha256(utf8(canonicalJson(request))))
```

Deliberately excluded (documented at `util.ts:121-125`): `id`, `objectKey`, `createdAt`, and every
idempotency bookkeeping field. That exclusion is what lets a retry be compared against the original
caller declaration rather than against generated identity.

Note the guard difference from `portableFields`: here the test is `=== undefined`, so an
**empty-string `kind`/`filename` IS included** in the finalization digest, while it is **dropped**
from the metadata fingerprint. In practice records never carry empty strings because
`portableFields` builds the record, but a Python port that constructs records directly must
reproduce both rules exactly.

Key insertion order in the literal is irrelevant: `canonicalJson` sorts keys.

Exported publicly as both `artifactFinalizationDigest` and the alias `finalizationDigest`
(`util.ts:145`, `index.ts:42-43`).

**PROBED** worked example. Record:

```json
{"id":"artifact-1","objectKey":"artifacts/artifact-1","mediaType":"text/plain","sizeBytes":5,
 "digest":{"algorithm":"sha256","value":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},
 "createdAt":42,"filename":"hello.txt"}
```

Canonical request text:

```
{"digest":{"algorithm":"sha256","value":"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"},"filename":"hello.txt","mediaType":"text/plain","schema":"mirk-artifact-finalization/v1","sizeBytes":5}
```

Finalization digest: `a5666b0df1c2ae50a2fd988e4e82d66412721abe5de63fc8842265268475b54a`

**PROBED** `metadataFingerprint({mediaType:"text/plain", filename:"hello.txt"})`
= `4a9d9af2e1f893f6705ac4e4fb157e41206e815e5090451e23f566a2f3be8297`, over canonical text
`{"filename":"hello.txt","mediaType":"text/plain"}`.

---

## 2. Canonical JSON — the exact rules

`canonicalJson` lives at `packages/store/src/atomic.ts:254-256`, implemented by `canonicalValue`
(`atomic.ts:206-249`). `@mirk/artifact` imports it from the `@mirk/store` root (`util.ts:12`).
This is the single most portability-critical function in the package.

### 2.1 Structure

- No whitespace anywhere. Separators are exactly `,` and `:` (`atomic.ts:243-248, 235-237`).
- Object: `{` + sorted `"key":value` pairs joined by `,` + `}`.
- Array: `[` + values joined by `,` + `]`.
- `null` → `null`; booleans → `true` / `false`.

### 2.2 Key ordering — Unicode CODE POINT, not UTF-16 code unit

`Object.keys(value).sort(compareCodePoints)` (`atomic.ts:242`), with `compareCodePoints` from
`packages/store/src/order.ts:15-26`. That function does `Array.from(s)` (which iterates code
points, joining surrogate pairs) and compares `codePointAt(0)` per element, then breaks ties on
code-point length.

The header comment at `order.ts:1-12` names the three wrong alternatives explicitly: JavaScript's
default `<` (UTF-16 code units — astral characters sort **below** U+E000–U+FFFF because their
surrogates do), `localeCompare` (ICU collation), and `Intl.Collator`. Only code-point order agrees
with SQLite's BINARY collation over UTF-8.

**PROBED**: `{"\u{1F600}":1, "�":2, "a":3, "A":4, "ä":5}` canonicalizes to
`{"A":4,"a":3,"ä":5,"�":2,"😀":1}` — that is U+0041, U+0061, U+00E4, U+FFFD, U+1F600. A UTF-16
code-unit sort would put U+1F600 (leading surrogate U+D83D) **before** U+FFFD and produce a
different digest. This is the single best discriminating test case for a port.

Python's `sorted()` on `str` is code-point order already, so `sort_keys=True` matches — but only
because CPython compares code points. Do not sort encoded bytes.

Numeric-looking keys get no special treatment: **PROBED** `{b:1, a:2, "10":3, "2":4}` →
`{"10":3,"2":4,"a":2,"b":1}`. `"10"` precedes `"2"` because `'1' < '2'`. (JavaScript's own
`Object.keys` would list integer-like keys first in numeric order; the explicit sort overrides
that, so a port must not replicate JS property enumeration order.)

### 2.3 String escaping

Strings are emitted with `JSON.stringify(key)` / `JSON.stringify(value)` (`atomic.ts:208, 244`),
so the escape set is exactly ECMAScript `QuoteJSONString`:

- Always escaped: `"` → `\"`, `\` → `\\`.
- Short forms: U+0008 `\b`, U+0009 `\t`, U+000A `\n`, U+000C `\f`, U+000D `\r`.
- Other C0 controls (U+0000–U+001F): `\u00XX` with **lowercase** hex digits.
- Everything else is emitted literally, as UTF-8 when the string is encoded. In particular
  **U+007F (DEL), U+2028, and U+2029 are NOT escaped**, and no non-ASCII character is escaped.
- Lone surrogates (well-formed JSON.stringify, ES2019) are escaped as `\udXXX` lowercase.

**PROBED** canonical texts and their SHA-256:

| Input | Canonical text | sha256 of canonical text |
| --- | --- | --- |
| `"a\"b\\c\nd\te"` | `"a\"b\\c\nd\te"` | `e0127043d1716c8ca6a938b7e89d96244bbca272dba3306802222a2daf1fecb7` |
| U+0000 U+0001 U+001F | `" "` | `842096a6d3fcd0968fe35809ea5810d33f7072b93743fc0f7b4ff484ae727d20` |
| lone surrogate U+D800 | `"\ud800"` | `8c0c59dd0d275aadcd462a5fe12eb352cbdfeaf961eae4f85a4660521df7d2f5` |
| U+1F600 | `"😀"` (raw UTF-8) | `7a0c50b92434b015545fe93ab723db2d4b2cdd14a441405624a9ce8be29f1d5a` |
| `café ünï 中文` | raw UTF-8, unescaped | `45e7e822afdd27e7e40f6b80bb165c0fb7396ec8e72f3bec1b5872c2d9c66aa5` |
| U+2028 U+2029 | raw UTF-8, unescaped | `e3a0e2262ac7790f4df36b522a8fbdd4ee3370d568eb15dc25c5f1775f14ed6c` |
| U+007F | raw, unescaped | `6fe76740e12a93d5598fe685cb6ad3d3c94e44609065a56866b69647772026ec` |

Python parity: `json.dumps(s, ensure_ascii=False)` reproduces every row above **PROBED**, including
` ` lowercase and the unescaped DEL / U+2028 / U+2029. `ensure_ascii=True`
(Python's default) does **not** — it would escape `ä`, `中`, and the emoji, changing every digest.
The lone-surrogate row is the trap: `json.dumps("\ud800", ensure_ascii=False)` produces a Python
string containing a raw lone surrogate that **raises `UnicodeEncodeError` on `.encode("utf-8")`**
**PROBED**. A port must either escape lone surrogates before encoding (matching JS) or declare
non-well-formed strings out of contract.

### 2.4 Number formatting — ECMAScript `Number::toString`, not Python `repr`

Numbers go through `JSON.stringify(value)` (`atomic.ts:213`), i.e. the ECMAScript number-to-string
algorithm. Non-finite values throw first (`atomic.ts:211-212`).

**PROBED** divergence table, JS canonical output versus CPython `json.dumps`:

| Value | JS canonical | Python `json.dumps` | Verdict |
| --- | --- | --- | --- |
| `-0` | `0` | `-0.0` | **DIVERGES.** JS erases the sign; a port must too. |
| `0.0` | `0` | `0.0` | **DIVERGES.** No `.0` suffix in JS. |
| `100.0` | `100` | `100.0` | **DIVERGES.** Integral doubles print without a fraction. |
| `1e21` | `1e+21` | `1e+21` | agrees |
| `1e100` | `1e+100` | `1e+100` | agrees |
| `1e-7` | `1e-7` | `1e-07` | **DIVERGES.** JS never zero-pads the exponent. |
| `5e-324` | `5e-324` | `5e-324` | agrees |
| `1.5` | `1.5` | `1.5` | agrees |
| `9007199254740993` | `9007199254740992` | `9007199254740993` | **DIVERGES.** JS has only float64; Python ints are exact. |

Rules a Python implementation must reproduce:

1. Every number is a **float64**. Round-trip integers above 2^53 through `float` before formatting,
   or reject them. This is the same rule as the store digest (`store-kv-collection.md` §1.1).
2. Use the **shortest round-tripping decimal** representation. CPython's `repr(float)` and JS both
   use shortest-round-trip, so the significant digits already agree; only the packaging differs.
3. Choose fixed vs exponential the way ECMAScript does: exponential when the decimal exponent is
   `>= 21` or `<= -7`, fixed otherwise.
4. Exponent form is `e+NN` / `e-NN` with **no leading zeros** and an explicit sign.
5. Integral values in fixed range print with no decimal point and no trailing `.0`.
6. Negative zero prints as `0`.

**PROBED** canonical text digests for the number cases:
`0` → `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9`;
`1e+21` → `241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c`;
`1e-7` → `5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22`;
`9007199254740992` → `c681da39d7273a6a24c15c9cac3a75526ff2ecf8ba4ee60346a0c70c8163bdb2`;
`1e+100` → `33d5997bb6b66e3ae3b8e79fff5fe0954bc7b2a38a9d95d83f437d0e57b68f82`;
`5e-324` → `c46e7ca1be4c8734f373a56530787288fa2058d73d07855e9247e949f811a42a`;
`1.5` → `9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725`;
`100` → `ad57366865126e55649ecb23ae1d48887544976efea46a48eb5d85a6eeb4d306`.

### 2.5 Rejections (all `TypeError`, exact messages)

From `canonicalValue`, in evaluation order:

| Condition | Message | Source |
| --- | --- | --- |
| `NaN` / `±Infinity` | `non-finite numbers are not JSON-safe` | `atomic.ts:212` |
| `undefined`, function, symbol | `value is not JSON-safe` | `atomic.ts:215` |
| cyclic reference | `cyclic values are not JSON-safe` | `atomic.ts:216` |
| any symbol-keyed property | `symbol keys are not JSON-safe` | `atomic.ts:217-218` |
| sparse array (a hole) | `sparse arrays are not JSON-safe` | `atomic.ts:225-227` |
| array with a non-index enumerable property, including alias keys like `"01"` | `array properties are not JSON-safe` | `atomic.ts:228-236` |
| non-plain object (class instance, `Date`, `Map`, …) | `only plain objects are JSON-safe` | `atomic.ts:240-241` |

All **PROBED** except cyclic and symbol. `isPlainObject` (`atomic.ts:201-205`) accepts only
`Object.prototype`-prototyped objects and null-prototype objects — a `Date` is rejected outright,
unlike `JSON.stringify` which would emit an ISO string.

Python equivalents: no `undefined`; forbid `NaN`/`inf` with `allow_nan=False`; the sparse-array and
array-property cases have no Python analogue (lists cannot have holes or extra attributes in the
JSON sense) so they are TypeScript-only corpus entries; `only plain objects` maps to "reject
anything that is not `dict`/`list`/`str`/`int`/`float`/`bool`/`None`".

### 2.6 Empty and nested containers

**PROBED**: `{}` → `{}` (`44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`);
`[]` → `[]` (`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`);
`{a:[null,{b:null}],c:null}` → `{"a":[null,{"b":null}],"c":null}`
(`2a7f1a3c029c0e48f68eaeb0215f2f862a39cafd9d9ed84fc7b6a7d1d3a384ce`);
`[true,false,null]` → `[true,false,null]`
(`4d0f18de2133118249c26acc481838d4f6bb6bc1de882d99abbd19ae9397e8df`);
`{a:{b:{c:[1,2,{d:"e"}]}}}` → `{"a":{"b":{"c":[1,2,{"d":"e"}]}}}`
(`f16ac108f5aa7e1af9d308eb47a1b02f21f2dfa65cc8f9a2af6b54b85d617502`).

---

## 3. Bounded-JSON validation

`assertBoundedJson(value, label)` (`util.ts:83-90`) is a separate, weaker check applied to
`annotations` and lineage `parameters`. It does **not** use `canonicalJson`:

1. `JSON.stringify(value)`; if the result is `undefined`, throw `TypeError("<label> must be JSON-safe")`.
2. UTF-8 byte length of that string must be `<= 64 * 1024`, else `RangeError("<label> exceeds 64 KiB")`.
   Note: measured on the **non-canonical** `JSON.stringify` output, not the canonical text.
3. `visitJson` walks the value: depth `> 20` throws `RangeError("<label> exceeds maximum depth 20")`;
   a non-finite number throws `TypeError("<label> contains a non-finite number")`.
   The root value is depth 0, so the deepest permitted scalar sits at depth 20.

`assertPortableMetadata` (`util.ts:71-81`):

- `mediaType` must be non-empty after `trim()` **and** contain `/`, else
  `TypeError("mediaType must be a non-empty MIME type")`. No further MIME grammar is enforced.
- `producer.system`, when a producer is supplied, must be non-empty after `trim()`, else
  `TypeError("producer.system must be non-empty")`.
- `annotations`, when supplied, goes through `assertBoundedJson(…, "annotations")`.

Object keys are validated by `assertObjectKey` (`util.ts:60-69`), which rejects: the empty string,
any key containing U+0000, any key starting with `/`, and any key whose `/`-split parts include
`.` or `..`. Message: `invalid object key: <JSON.stringify(key)>`. Asserted by the shared
conformance suite (`object-store-conformance.ts:88-91`).

---

## 4. Coordinator write/import protocol

### 4.1 Identity and key derivation

- Artifact id: `options.idFactory()` (`coordinator.ts:60`), defaulting to `makeId()`
  (`util.ts:147-167`) — `crypto.randomUUID()` when available, otherwise a manually assembled
  RFC 4122 v4 UUID from `getRandomValues`, or `Error("artifact IDs require Web Crypto or an injected idFactory")`.
- Object key for `write`: `` `${namespace}/${id}` `` (`coordinator.ts:95`). Namespace defaults to
  `"artifacts"` (`coordinator.ts:59`). Keys are **not** content-addressed; the spec explicitly
  permits but does not require content-addressed keys (`artifact-spec.md:709`).
- Object key for `import`: supplied by the caller verbatim (`coordinator.ts:201`).
- Repository idempotency key: `` `${encodeURIComponent(namespace)}:${encodeURIComponent(key)}` ``
  (`coordinator.ts:543-547`), `undefined` when the caller supplied none. This is what scopes
  idempotency to a namespace (test at `hardening.test.ts:130-154`).
  **PROBED** `encodeURIComponent("attempt:output")` = `attempt%3Aoutput`;
  `encodeURIComponent("a/b c~*'()!")` = `a%2Fb%20c~*'()!`. Python equivalent is
  `urllib.parse.quote(s, safe="!*'()")` **PROBED** — the default `safe='/'` and Python's escaping
  of `!*'()` both diverge.
- Default `ownerId`: `` `artifact-coordinator-${Math.random().toString(36).slice(2)}` ``
  (`coordinator.ts:62-64`). Nondeterministic; inject it in a corpus.

### 4.2 `write` step order (`coordinator.ts:76-169`)

1. `assertPortableMetadata(input)`.
2. Compute the metadata fingerprint (1.2).
3. If an idempotency key was supplied, look up a prior record by that key (`#prior`,
   `coordinator.ts:492-503`). A prior record whose stored fingerprint differs throws
   `ArtifactConflictError("idempotency key reused with incompatible metadata: <key>")`.
4. On a prior hit: fully digest the incoming bytes, run `#assertFinalizationReplay`, and return
   the prior descriptor. The replay check recomputes the finalization digest from the prior record
   overlaid with the incoming portable fields plus the freshly computed digest/size, and compares it
   against `prior.idempotencyFinalizationDigest` (falling back to recomputing from the prior record).
   Mismatch throws `ArtifactConflictError("idempotency key reused with incompatible bytes: <key>")`.
   The stored `idempotencyFinalizationDigest` is what makes replay survive later mutable annotation
   edits (`hardening.test.ts:52-79`).
5. Mint the id, derive the object key, acquire a shared-writer lease if the repository is a lease
   repository (`#acquireLease`, `coordinator.ts:453-482`).
6. `head(objectKey)` first, to know whether a later failure is ours to clean up.
7. `put(objectKey, hashingStream(bytes, …), { mediaType, ifAbsent: true })`. **`ifAbsent` is always
   true for `write`.**
8. If `put` threw: cleanup is `"not-needed"` when the object pre-existed or the error was
   `ObjectAlreadyExistsError`; otherwise attempt `#deleteOwnedObject` and report `"succeeded"` /
   `"failed"`. Throw `ArtifactWriteError("artifact object write failed", cleanup, { cause })`.
9. If the digest callback never fired, the store did not drain the stream:
   `ArtifactWriteError("object store did not consume the complete byte source", …)`, after cleanup.
10. If `info.sizeBytes !== sizeBytes`:
    `ArtifactWriteError("object store reported N bytes after M were streamed", …)`, after cleanup.
11. Build the record: `{ id, objectKey, createdAt: now(), digest, sizeBytes, idempotencyFingerprint,
    ...portableFields(input, repositoryIdempotencyKey) }`. When idempotent, also set
    `idempotencyFinalizationDigest`.
12. `#commit` (see 4.4).
13. `finally`: release the lease. If the write completed but the release failed, throw
    `ArtifactWriteError("artifact object lease release failed", "failed")`.

`ArtifactWriteError` carries a `cleanup` field of `"not-needed" | "succeeded" | "failed"`
(`coordinator.ts:27-36`) — that field is the contract, not the message.

### 4.3 `import` (`coordinator.ts:171-229`)

Same shape, three differences: the object key is the caller's; the bytes are read back from the
store and digested (never trusted from the caller); and cleanup is disabled (`cleanupObject=false`)
because the bytes are not the coordinator's to delete. Missing object throws a plain
`Error("object not found: <key>")`.

### 4.4 `#commit` (`coordinator.ts:300-435`)

- Renews the lease first when the repository supports leases; a lost lease throws
  `Error("artifact object lease was lost before repository commit")`.
- With an idempotency key **and** an atomic repository, calls `createIdempotentWithLease` when a
  lease is held (and the repository lacks it, throwing
  `Error("artifact repository cannot commit while holding an object lease")`), otherwise
  `createIdempotent`. A `"conflict"` result becomes
  `ArtifactConflictError("idempotency key reused with incompatible metadata: <key>")`.
  A `"replayed"` result whose record points at a different object key triggers cleanup of the
  freshly written object, and a failed cleanup throws
  `ArtifactWriteError("artifact replay cleanup failed", "failed")`.
- Otherwise `createWithLease` (lease held) or plain `create`.
- Lineage edges are written **only when not replayed**, one `addLineage` per declared source, each
  edge taking `createdAt` from the **committed record**, not from a fresh `now()`
  (`coordinator.ts:405`), and a fresh `idFactory()` id.
- On any failure it deletes the record it created (best effort), computes a cleanup status, and
  rethrows: an `ArtifactConflictError` under an idempotency key with non-failed cleanup passes
  through unchanged; an `ArtifactWriteError` with `cleanup === "failed"` passes through; everything
  else is wrapped as `ArtifactWriteError("artifact metadata commit failed", cleanup, { cause })`.

### 4.5 `verify`, `read`, `delete`

`verify` (`coordinator.ts:239-272`) — unknown id throws `Error("artifact not found: <id>")`.
Otherwise returns `ArtifactVerification` with a **strict reason precedence**: `object-missing`
(no stream), then `size-mismatch`, then `digest-mismatch`, then `ok: true`. Size is checked
**before** digest, so a truncated object reports `size-mismatch` and never `digest-mismatch`.
`actualDigest`/`actualSizeBytes` are present on every branch except `object-missing`. The returned
`artifact` is always the stripped descriptor.

`read` (`coordinator.ts:231-237`) — returns `undefined` for an unknown id, but throws
`Error("artifact object missing: <id>")` when the record exists and the object does not. Those are
deliberately different failure modes.

`delete` (`coordinator.ts:274-284`) — returns `false` for an unknown id or a repository delete that
returns false. After the metadata delete, it pages the whole repository looking for any other
record with the same `objectKey` (`#hasObjectReference`, `coordinator.ts:286-298`, 500 per page);
if one exists the bytes survive. Otherwise `objects.delete` must return true, else
`Error("artifact metadata deleted but object deletion failed: <id>")`. Pinned by
`artifact.test.ts:166-190` for two artifacts importing one shared object.

`descriptor(record)` (`util.ts:105-114`) strips exactly four fields: `objectKey`,
`idempotencyKey`, `idempotencyFingerprint`, `idempotencyFinalizationDigest`.

---

## 5. Repository semantics (shared by both implementations)

`memory.ts:458-507` defines the ordering, cursor, and filter functions; `store.ts` imports the same
functions, so the two implementations cannot drift on these.

### 5.1 Ordering and pagination

- `compareRecords` (`memory.ts:458-463`): `b.createdAt - a.createdAt || b.id.localeCompare(a.id)`.
  Newest first, ties broken by **descending** id. **`localeCompare` is ICU collation, not code
  point** — this contradicts the code-point rule the rest of Mirk uses (`order.ts`) and is a real
  portability hazard. A Python port must pick one; code-point descending is the consistent choice,
  and the existing tests do not distinguish them.
- `encodeCursor` (`memory.ts:464-466`): `` `${createdAt}:${id}` ``. Not opaque, not signed.
- `cursorOffset` (`memory.ts:467-475`): finds the cursor **inside the already filtered and sorted
  result list** and returns `index + 1`. A cursor not present throws
  `Error("invalid artifact cursor")` (test `store.test.ts:38-42`). A cursor is therefore only valid
  for the identical query; it is a positional bookmark, not a keyset cursor.
- `limit` is clamped: `Math.min(Math.max(limit ?? 50, 1), 500)`. Default 50, minimum 1, maximum 500.
  `limit: 0` becomes 1.
- `nextCursor` is emitted only when `after + limit < ordered.length && items.length` — the last page
  carries no cursor.

### 5.2 Query filter (`matches`, `memory.ts:476-507`)

Every string filter is a **truthiness-guarded** exact match, so an empty-string filter value is a
no-op: `mediaType`, `kind`, `producerSystem`, `producerJobId`, `producerAttemptId`,
`producerOutputSlot`. `mediaTypePrefix` is `startsWith`. The two time filters use `!== undefined`
and are **strictly exclusive**: `createdAfter` excludes `createdAt <= createdAfter`,
`createdBefore` excludes `createdAt >= createdBefore`. Producer sub-fields read through `?.`, so a
record with no producer never matches a producer filter.

### 5.3 `updateAnnotations`

Both implementations (`memory.ts:182-202`, `store.ts:126-145`): shallow merge over the existing
annotations, `undefined` in the patch **deletes** the key, then `assertBoundedJson`. If the result
is empty the field is set to `undefined` rather than `{}`. Unknown id throws
`Error("artifact not found: <id>")`. Crucially, this **does not touch**
`idempotencyFinalizationDigest`, which is why replay still works afterwards.

### 5.4 Lineage

`addLineage` validation order differs between the two implementations, which changes which error a
caller sees:

- **memory** (`memory.ts:427-445`): duplicate edge id → cycle check → endpoints exist → bounded
  parameters.
- **store** (`store.ts:153-171`): duplicate edge id → endpoints exist → cycle check → bounded
  parameters.

Errors: `ArtifactConflictError("lineage edge already exists: <id>")`,
`ArtifactConflictError("lineage cycle forbidden")`, `Error("lineage endpoints must exist")`.
Self-edges (`source === result`) are cycles. The reachability walk is a depth-first search over
`getDerivatives` with a visited set (`memory.ts:508-521`, `store.ts:675-686`).

Deleting a record cascades: every edge touching it as source or result is removed
(`memory.ts:203-209`, `store.ts:146-152`).

### 5.5 Idempotent create (`createIdempotent`)

Both implementations follow the same decision procedure (`memory.ts:210-274`, `store.ts:186-294`):

1. Compute `requestDigest = artifactFinalizationDigest(record)`.
2. Receipt lookup by idempotency key. Receipt found and digest differs →
   `{status:"conflict", expectedRequestDigest, receivedRequestDigest}`. Receipt found but the
   record it names is gone → also `conflict` (memory) / `lease-lost` in the with-lease variant.
   Receipt found and digest matches → `{status:"replayed", requestDigest, record}`.
3. Legacy path: a record already carrying that `idempotencyKey` but with no receipt. Recompute its
   digest; mismatch → `conflict`; match → **backfill the receipt** and return `replayed`.
4. Same-id record already present → `conflict` carrying the existing record's digest.
5. Otherwise create the record (with `idempotencyKey` stamped in) and the receipt.

The store-backed version performs steps 4-5 as one `mutateAtomically` call with two `expected:
"missing"` conditions (the receipt key and the record) and two operations (put record, set receipt)
(`store.ts:228-255`), then re-reads on conflict to distinguish a race-that-is-really-a-replay from a
genuine conflict. A conflict with no receipt and no record throws
`Error("artifact idempotent mutation conflicted without a receipt")`; a non-applied, non-conflict
status throws `Error("artifact idempotent mutation was not applied")`.

### 5.6 Store-backed layout (`store.ts:62-74`)

With namespace prefix `p` (default `"mirk-artifacts"`), over one `AsyncStore`:

| Logical thing | Physical location |
| --- | --- |
| artifact records | collection `p:records`, item id = artifact id |
| lineage edges | collection `p:lineage`, item id = edge id |
| idempotency receipts | KV key `p:idempotency:<encodeURIComponent(key)>`, value `{requestDigest, recordId}` |
| lease state per object | KV key `p:lease-state:<encodeURIComponent(objectKey)>`, value `{generation, mode, leases[]}` |
| individual leases | collection `p:leases`, item id = leaseId |

`atomicAvailable` is `supportsAsyncAtomicMutation(store)` (`store.ts:73`). Without it,
`#atomic()` throws
`Error("artifact repository atomic mutation is unavailable; use single-writer mode")`, and the
coordinator's constructor rejects `{mode:"repository-atomic"}` with
`TypeError("repository-atomic concurrency requires AtomicArtifactRepository")`.

A Python port reuses `mirk.store` here directly: the KV/collection port, `getVersioned`, and
`mutateAtomically` are the only store surfaces touched. Nothing artifact-specific reaches into the
SQL layer.

---

## 6. Object leases

`ArtifactObjectLease` (`types.ts:151-159`): `{leaseId, ownerId, objectKey, mode, generation,
heartbeatAt, expiresAt}`. Two modes: `shared-writer` (finalizers) and `exclusive-delete`
(maintenance). TTL defaults to 30000 ms, clamped to a minimum of 1
(`coordinator.ts:66`, `memory.ts:284`, `store.ts:305`).

Acquisition rules (identical in both implementations, `memory.ts:276-318` / `store.ts:296-378`):

- `shared-writer` blocked by a live `exclusive-delete` → `{status:"conflict", reason:"exclusive-held"}`.
- `exclusive-delete` blocked by a live exclusive → `conflict/exclusive-held`; by a live shared →
  `{status:"unavailable", reason:"shared-held"}`; by any record referencing the object key →
  `{status:"conflict", reason:"reference-created"}`.
- Multiple `shared-writer` leases coexist.
- Expiry is `expiresAt > now` (strictly greater). Reclaiming expired leases **bumps the generation**
  (`memory.ts:401-413`; store version computes `state.generation + (expired.length ? 1 : 0)`), which
  fences a stale holder: renew and commit both compare `generation`.
- `renewObjectLease` requires leaseId, ownerId, objectKey, mode, generation to all match and the
  lease to be unexpired; otherwise `{status:"unavailable", reason:"expired"}`.
- `releaseObjectLease` returns `false` unless leaseId, ownerId, generation, and objectKey all match.
- The store version retries acquisition up to 8 times on version conflict, then returns
  `{status:"unavailable", reason:"expired"}` (`store.ts:307, 377`).

**Nondeterminism note:** `store.ts:333-335` mints lease ids with `Date.now()` and `Math.random()`
directly, ignoring the injected `now`. The in-memory repository takes an injectable
`leaseIdFactory` (`memory.ts:127-129`). A corpus must inject both.

---

## 7. Maintenance: audit, plan, repair

`ArtifactMaintenance` (`maintenance.ts:38`) is read-then-conditionally-write. It keeps audit
snapshots **in process memory** keyed by `auditId` (`maintenance.ts:42`), so a plan is only
applicable by the same instance that produced the audit. `applyRepair` with an unknown auditId
returns `{status:"not-found"}` for every action.

### 7.1 `audit` (`maintenance.ts:56-147`)

Pages all records (500 at a time), groups them by `objectKey`, collects every lineage edge reachable
from any record, then per object key:

- `head` missing, or the byte stream unreadable → one `record-without-object` finding per owning
  record, detail `"artifact record has no readable object"`.
- Otherwise compare digested size and digest value against each owning record, emitting
  `size-mismatch` (detail `"stored size differs for artifact <id>"`) and/or `digest-mismatch`
  (detail `"stored digest differs for artifact <id>"`). Both can fire for the same record.

If the object store implements `list`, every listed key with no owning record becomes an
`object-without-record` finding carrying an **opaque `maintenanceRef`** of the form
`ref-<auditId>-<n>` (`maintenance.ts:550-560`), detail
`"object is not referenced by an artifact record"`. Physical keys never leave the maintenance
boundary. `scannedObjects` is set and `coverage` is `"complete"`; without `list`, both are omitted
and `coverage` is `"partial"` (test `hardening.test.ts:116-128`).

Lineage findings (`maintenance.ts:569-596`): `lineage-missing-source`, `lineage-missing-result`,
and `lineage-cycle`, each with `detail` set to the **edge id** (the plan looks the edge up by that
detail string).

Findings are sorted by `[code, artifactId, maintenanceRef, detail].join(" ")` compared with a
**local** `compareCodePoints` (`maintenance.ts:634-642`) that duplicates `order.ts` rather than
importing it. Behaviorally equivalent; worth collapsing in a port.

### 7.2 `planRepair` (`maintenance.ts:149-250`)

Maps findings to four operations, each with a precondition that pins the observed state:

| Finding | Operation | Precondition |
| --- | --- | --- |
| `object-without-record` | `delete-unreferenced-object` | `object-unreferenced` (maintenanceRef, observed size/digest/etag) |
| `record-without-object` | `delete-record-without-object` | `record-missing-object` (artifactId, `metadataFingerprint(record)`) |
| `size-mismatch`, `digest-mismatch` | `reverify-imported-object` | `artifact-descriptor-current` (artifactId, fingerprint) |
| `lineage-*` | `remove-invalid-lineage-edge` | `lineage-edge-invalid` (edgeId, `metadataFingerprint(edge)`, expectedReason) |

Action id is `metadataFingerprint({schema:"mirk-artifact-repair/v1", auditId, operation, precondition})`
(`maintenance.ts:229-234`); duplicates are dropped; actions are sorted by id. Plan shape is
`{schema:"mirk-artifact-repair/v1", auditId, createdAt, actions}`.

**Nondeterminism:** `auditId` is `makeId()` (a random UUID) and there is no option to inject it, so
action ids are not reproducible across runs. A corpus must either inject an id factory into
maintenance (it currently cannot) or assert on the sorted `(operation, precondition)` tuples rather
than on ids. Flag this as a portability change worth making in both languages.

### 7.3 `applyRepair` (`maintenance.ts:252-504`)

Actions run in `Promise.all`, i.e. concurrently, and the plan is **not** a transaction.

`delete-unreferenced-object` (`maintenance.ts:274-405`) is the careful one:
check no record references the key → require a lease repository (else
`conflict/lease-unavailable`) → acquire `exclusive-delete` (a `reference-created` reason maps
through, anything else is `lease-unavailable`) → re-check references → renew → `head` + re-digest →
compare size, digest, and etag against the precondition (`conflict/object-changed` on any mismatch)
→ renew again → re-check references → `head` + re-digest again → delete. The lease is always
released in a `finally`. Object-store failures are **not** swallowed into conflicts; a throwing
`delete` propagates (test `hardening.test.ts:259-276`).

`delete-record-without-object`: record gone → `not-found`; fingerprint changed or the object now
exists → `conflict/state-changed`; else delete.

`reverify-imported-object`: record gone → `not-found`; fingerprint changed →
`conflict/state-changed`; digest/size still disagree → `conflict/object-changed`; agreement →
`applied`. It **never rewrites** the record, it only certifies.

`remove-invalid-lineage-edge`: edge gone → `not-found`; fingerprint changed, repository lacks
`removeLineage`, or the edge is no longer invalid → `conflict/state-changed`; else remove.

---

## 8. Object stores

### 8.1 The shared conformance contract (`object-store-conformance.ts:29-101`)

Six universal assertions plus one conditional: round-trip bytes/size/mediaType/metadata;
async-iterable source with correct total size; overwrite when `ifAbsent` is unset; `undefined`/
`undefined`/`false` for a missing key on get/head/delete; delete reports prior existence and is
idempotent-false afterwards; invalid keys throw `/invalid object key/`; and, when supported,
`ifAbsent` refuses to replace existing bytes. Three capability flags let an adapter opt out:
`supportsIfAbsent`, `supportsMetadata`, `supportsMediaType`.

### 8.2 `InMemoryObjectStore` (`memory.ts:45-107`)

Copies every chunk on write (`part.slice()`) and returns a snapshot copy on `get`, so a returned
stream is isolated from later mutation. `put` returns `cloneJson(info)`. `ifAbsent` throws
`ObjectAlreadyExistsError("object already exists: <key>")`. `list(prefix)` filters by
`String.startsWith` and sorts by `localeCompare` (`memory.ts:106`) — again ICU, not code point.

### 8.3 `FileObjectStore` (`fs.ts`)

Two files per object: `<key>.bin` and `<key>.sidecar.json`. The `.bin` suffix is what stops key `a`
and key prefix `a/` from colliding (`fs.test.ts:50-55`). `ifAbsent` maps to `open(path, "wx")` and
translates `EEXIST` to `ObjectAlreadyExistsError`. A mid-stream failure under `ifAbsent` removes the
partial file so the key is not poisoned (`fs.ts:82-93`, test `fs.test.ts:72-82`); under overwrite it
leaves the file. Sidecar writes are temp-file-plus-rename (`fs.ts:185-204`), using
`node:crypto.randomUUID` for the temp name. `head` falls back to `stat` when the sidecar is missing
or corrupt, returning `{key, sizeBytes}` only (`fs.ts:125-134`, tests `fs.test.ts:57-70`).
`#path` refuses any resolved path outside the root: `TypeError("object key escapes store root: <key>")`.
`get` streams lazily from disk and is explicitly **not** a snapshot (documented `fs.ts:32-36`).
`list` walks recursively and sorts by `localeCompare`.

Python equivalents: `pathlib`, `os.replace` for the atomic rename, `uuid.uuid4()`, and
`open(path, "xb")` for the exclusive create.

### 8.4 `OpenDalObjectStore` (`artifact-opendal/src/index.ts`)

A deliberately thin translation layer. Capability gating happens twice:

- Constructor requires `read`, `write`, `stat`, `delete`, else
  `Error("OpenDAL operator must support read, write, stat, and delete")`.
- `put` requires `writeWithIfNotExists` for `ifAbsent`
  (`Error("OpenDAL backend does not support atomic ifAbsent writes")`), `writeWithContentType` for
  `mediaType`, and `writeWithUserMetadata` for metadata or the digest sidecar key. It **fails closed**
  rather than emulating (test `opendal.test.ts:39-46`).
- `list` requires `list` and `listWithRecursive`, else
  `Error("OpenDAL backend does not support recursive object listing")`.

Semantics worth porting exactly:

- `get`/`head`/`delete` all call `operator.exists(key)` first, so `delete` can return a boolean and
  `get`/`head` can return `undefined` instead of throwing.
- Failure cleanup is asymmetric on purpose (`index.ts:107-123`): a mid-write failure deletes the
  key only when the write was unconditional or bytes were already written; a `close()` failure
  deletes only when the write was unconditional. Under `ifAbsent` the pre-existing object is never
  destroyed. Test `opendal.test.ts:61-72`.
- The opt-in `digestMetadataKey` option buffers the whole source in memory to compute SHA-256 before
  writing, because OpenDAL fixes metadata at writer creation. The default path stays streaming.
- `list(prefix)` appends a trailing `/` to the prefix for the recursive call, then separately
  `stat`s the bare prefix and prepends it when it exists as an object — so `list("objects/a")`
  returns `["objects/a"]` (test `opendal.test.ts:48-59`). Returned keys are stripped of leading `/`,
  re-validated with `assertObjectKey` (violation →
  `Error("OpenDAL backend returned an invalid object key")`), filtered by `startsWith(prefix)`, and
  sorted by `localeCompare`.
- `metadataToInfo` (`index.ts:197-223`): `sizeBytes` is `Number(contentLength ?? 0n)` — OpenDAL
  returns a BigInt; `lastModifiedAt` is `Date.parse(metadata.lastModified)` and is dropped when not
  finite; `digest` is synthesized from user metadata only when `digestMetadataKey` is configured.

**Python mapping.** OpenDAL ships first-class Python bindings (`opendal.Operator`), so the adapter
ports rather than being replaced. The surface used here maps as: `operator.capability()` →
`operator.capability()`; `operator.writer(key, opts)` → `operator.open(key, "wb")` or the async
`AsyncOperator` writer, with `if_not_exists` / `content_type` / `user_metadata` as snake_case
keyword arguments; `operator.reader(key).createReadStream()` → `operator.open(key, "rb")` (a
file-like object supporting iteration); `operator.stat` → `operator.stat`; `operator.exists` →
`operator.exists`; `operator.list(path, recursive=True)` → same. The Node-specific parts that do
**not** port are `node:buffer` `Buffer.from(chunk.buffer, byteOffset, byteLength)` zero-copy views
(Python uses `bytes`/`memoryview`), the async-generator `get()` shape, and the BigInt coercion.

---

## 9. Streams, buffers, and their Python equivalents

| TypeScript | Meaning | Python |
| --- | --- | --- |
| `ByteSource = Uint8Array \| AsyncIterable<Uint8Array>` | write input | `bytes \| Iterable[bytes]` (sync port) or `AsyncIterable[bytes]` |
| `ByteStream = AsyncIterable<Uint8Array>` | read output | `Iterator[bytes]` / a file-like object |
| `hashingStream` pass-through generator | hash while streaming | a generator wrapping `hashlib.sha256().update` |
| Node `Readable` (fs, OpenDAL) | adapter-internal only | `io.BufferedReader` |
| `Blob` | **not used anywhere** | n/a |

There is no `Blob`, no `ReadableStream`, and no `Buffer` in `@mirk/artifact` itself. `Buffer`
appears only in the OpenDAL adapter, for zero-copy views into the writer. Mirk's stated design rule
is that local calls are synchronous where the backend is (`CLAUDE.md`, "Sync by design"), and the
Python port spec makes the Python ports synchronous with an asyncio wrapper — so a Python
`ObjectStore` should be a sync protocol over iterables of `bytes`, mirroring
`store-kv-collection.md` §7.

---

## 10. Time, randomness, and other injection points

| Source | Default | Injectable? | Where |
| --- | --- | --- | --- |
| `createdAt` | `Date.now` | yes, `options.now` | `coordinator.ts:61` |
| artifact id | `crypto.randomUUID()` | yes, `options.idFactory` | `coordinator.ts:60`, `util.ts:147` |
| lineage edge id | same `idFactory` | yes | `coordinator.ts:401` |
| coordinator `ownerId` | `artifact-coordinator-<Math.random base36>` | yes, `options.ownerId` | `coordinator.ts:62` |
| maintenance `ownerId` | `artifact-maintenance-<Math.random base36>` | yes | `maintenance.ts:50` |
| `auditId` | `makeId()` | **no** | `maintenance.ts:57` |
| maintenance `now` | `Date.now` | yes | `maintenance.ts:49` |
| repair plan `createdAt` | `now()` | yes, `options.createdAt` | `maintenance.ts:247` |
| in-memory lease id | `lease-<Math.random base36>` | yes, `leaseIdFactory` | `memory.ts:127` |
| in-memory repo `now` | `Date.now` | yes | `memory.ts:130` |
| store-backed lease id | `lease-<Date.now b36>-<Math.random b36>` | **no** | `store.ts:333` |
| store repo `now` | `Date.now` | yes | `store.ts:72` |
| fs sidecar temp name | `randomUUID()` | **no** | `fs.ts:188` |
| lease `expiresAt` | `now + ttlMs` | via `now`/`ttlMs` | throughout |

The three non-injectable sources (`auditId`, store-backed lease id, fs temp name) are the ones a
deterministic corpus cannot control today. Only `auditId` leaks into an observable output (repair
action ids); the other two are internal.

---

## 11. Hand-rolled crypto: where it is and is not

`packages/store/src/atomic.ts:496-568` contains a hand-written SHA-256 with its own round-constant
table, kept there so that `@mirk/store`'s root and KV entry points stay dependency-free and
browser-safe. It hashes only the canonical JSON of an atomic mutation request
(`atomic.ts:490`).

`@mirk/artifact` does **not** use it. Every artifact hash goes through `@noble/hashes`
(`util.ts:1-2`), which the spec justifies explicitly (`artifact-spec.md:177-178`: "Mirk does not
implement cryptographic primitives"). `node:crypto` is imported once, in `fs.ts:1`, and only for
`randomUUID`.

Consequence for the port: `hashlib.sha256` reproduces all four hashing sites (store request digests,
artifact content digests, metadata fingerprints, finalization digests). No custom hash
implementation is needed in Python, and the two TypeScript implementations must agree with each
other — worth one corpus case that hashes the same input through both.

---

## 12. Scenario list

`[T]` asserted by an existing test. `[S]` specified in `docs/artifact-spec.md` or a source comment
but not directly asserted. `[P]` established by probing. `[PURE]` deterministic, no I/O, corpus-ready
as data in / data out. `[IO]` needs a live object store or repository.

### A. Canonical JSON and hashing — all `[PURE]`

1. `[P]` `sha256(b"")` = `e3b0c442…b855`.
2. `[P]` `sha256(b"hello")` = `2cf24dba…9824`.
3. `[P]` `sha256(bytes([0]))` = `6e340b9c…fa01d`.
4. `[P]` `sha256` of U+1F600 encoded UTF-8 = `f0443a34…7e2d9`.
5. `[T]` chunked and single-buffer sources with identical concatenation produce identical digest and
   size. (`artifact.test.ts:13-27`, `object-store-conformance.ts:53-62`)
6. `[P]` object keys sort by code point: `{U+1F600, U+FFFD, "a", "A", "ä"}` →
   `{"A":4,"a":3,"ä":5,"�":2,"\u{1F600}":1}`. A UTF-16 sort gives a different digest.
7. `[P]` numeric-looking keys sort lexicographically: `{"10","2","a","b"}` → `10` before `2`.
8. `[P]` `-0` canonicalizes to `0`.
9. `[P]` `1e21` → `1e+21`; `1e-7` → `1e-7` (no zero-padded exponent); `1e100` → `1e+100`;
   `5e-324` → `5e-324`.
10. `[P]` `9007199254740993` → `9007199254740992` (float64 clamp).
11. `[P]` `100` → `100`, never `100.0`.
12. `[P]` `{}` → `{}`, `[]` → `[]`.
13. `[P]` `{a:[null,{b:null}],c:null}` → `{"a":[null,{"b":null}],"c":null}`.
14. `[P]` `[true,false,null]` → `[true,false,null]`.
15. `[P]` string escapes: `"` `\` `\n` `\t` short forms; C0 controls as lowercase `\u00xx`.
16. `[P]` U+007F, U+2028, U+2029 and all non-ASCII are emitted raw, never escaped.
17. `[P]` a surrogate pair round-trips as one raw UTF-8 character.
18. `[P]` a lone surrogate is emitted as `\ud800`; the port must not emit an unencodable raw one.
19. `[P]` `NaN`/`Infinity` throw `non-finite numbers are not JSON-safe`.
20. `[P]` `undefined` throws `value is not JSON-safe`.
21. `[P]` a sparse array throws `sparse arrays are not JSON-safe` (TS-only).
22. `[P]` an array with an extra enumerable property throws `array properties are not JSON-safe` (TS-only).
23. `[S]` a cyclic value throws `cyclic values are not JSON-safe`.
24. `[S]` a `Date`, `Map`, or class instance throws `only plain objects are JSON-safe`.
25. `[P]` `metadataFingerprint({mediaType,filename})` = sha256 of the sorted canonical text.
26. `[P]` `artifactFinalizationDigest` of the worked record in §1.3 = `a5666b0d…b54a`.
27. `[T]` a finalization digest always matches `/^[0-9a-f]{64}$/`. (`hardening.test.ts:49`)
28. `[S]` the finalization request omits `id`, `objectKey`, `createdAt`, and idempotency fields.
29. `[S]` `kind`/`filename` absent versus present-but-empty differ in the finalization digest
    (`=== undefined` guard) but not in the metadata fingerprint (truthiness guard).

### B. Validation — all `[PURE]`

30. `[T]` `assertObjectKey("../escape")` throws `/invalid object key/`. (`object-store-conformance.ts:88`)
31. `[S]` empty key, a key containing U+0000, a leading `/`, and any `.`/`..` path segment all throw.
32. `[S]` `mediaType` without `/` or blank throws `mediaType must be a non-empty MIME type`.
33. `[S]` a producer with a blank `system` throws `producer.system must be non-empty`.
34. `[S]` annotations over 64 KiB of `JSON.stringify` UTF-8 throw `annotations exceeds 64 KiB`.
35. `[S]` annotations nested past depth 20 throw `annotations exceeds maximum depth 20`.
36. `[S]` annotations containing a non-finite number throw `annotations contains a non-finite number`.
37. `[S]` lineage `parameters` are bounded with label `lineage parameters`.

### C. Coordinator write and read — `[IO]`

38. `[T]` `write` returns a descriptor with the injected id, correct `sizeBytes` and `createdAt`, and
    **no** `objectKey`. (`artifact.test.ts:30-50`)
39. `[T]` `verify` on a fresh write is `ok: true`. (`artifact.test.ts:47`)
40. `[T]` `read` returns the original bytes. (`artifact.test.ts:48-49`)
41. `[S]` `write` derives the object key as `<namespace>/<id>` and always puts with `ifAbsent: true`.
42. `[S]` `verify` reason precedence: `object-missing`, then `size-mismatch`, then `digest-mismatch`.
43. `[S]` `read` on an unknown id returns `undefined`; on a record whose object is gone it throws
    `artifact object missing: <id>`.
44. `[S]` `verify` on an unknown id throws `artifact not found: <id>`.
45. `[T]` a metadata commit failure deletes the orphan object and the error carries
    `cleanup: "succeeded"`. (`artifact.test.ts:146-164`)
46. `[S]` a store that does not drain the source fails with
    `object store did not consume the complete byte source`.
47. `[S]` a store reporting a different size fails with `object store reported N bytes after M were streamed`.
48. `[T]` `import` verifies bytes by reading them back; two imports of one key both succeed.
    (`artifact.test.ts:166-190`)
49. `[T]` deleting one of two artifacts sharing an object keeps the bytes; deleting the last removes
    them. (`artifact.test.ts:184-189`)
50. `[S]` `delete` on an unknown id returns `false`.
51. `[S]` a failed object delete after a successful metadata delete throws
    `artifact metadata deleted but object deletion failed: <id>`.

### D. Idempotency — `[IO]`, decision logic `[PURE]`

52. `[T]` repeating a write with the same key and identical bytes and metadata returns the original
    id. (`artifact.test.ts:52-84`, `hardening.test.ts:16-50`)
53. `[T]` the same key with different bytes throws `ArtifactConflictError`. (`artifact.test.ts:70-77`)
54. `[T]` the same key with a different `mediaType` throws `ArtifactConflictError`. (`:78-83`)
55. `[T]` declared `sources` participate in the fingerprint, so changing them conflicts.
    (`artifact.test.ts:115-144`)
56. `[T]` replay still works after `updateAnnotations` mutated the record, because the original
    receipt is retained. (`hardening.test.ts:52-79`)
57. `[T]` two coordinators with different namespaces and the same caller key produce two artifacts.
    (`hardening.test.ts:130-154`)
58. `[S]` the repository key is `<encodeURIComponent(namespace)>:<encodeURIComponent(key)>`.
59. `[S]` `createIdempotent` returns `created` / `replayed` / `conflict` with the digest pair, and
    backfills a receipt for a legacy record that carries the key but has none.
60. `[S]` a receipt pointing at a missing record is a `conflict`, not a silent recreate.
61. `[S]` a store without atomic capability makes `{mode:"repository-atomic"}` a constructor
    `TypeError`.

### E. Repository ordering, paging, filtering — `[PURE]` given a record set

62. `[T]` records sort newest-`createdAt` first; a `limit: 1` page returns the newest.
    (`store.test.ts:13-22`)
63. `[T]` following `nextCursor` returns the next record. (`store.test.ts:20-21`)
64. `[T]` a cursor not in the result set throws `invalid artifact cursor`. (`store.test.ts:38-42`)
65. `[T]` records persist across a real SQLite close and reopen. (`store.test.ts:24-36`)
66. `[S]` cursor encoding is `<createdAt>:<id>` and is positional within one query.
67. `[S]` `limit` clamps to `[1, 500]` with a default of 50; `limit: 0` yields one item.
68. `[S]` the last page omits `nextCursor`.
69. `[S]` `createdAfter`/`createdBefore` are strictly exclusive on both ends.
70. `[S]` empty-string filter values are no-ops (truthiness guards).
71. `[S]` producer filters never match a record with no producer.
72. **DIVERGENCE** `[S]` id tie-break uses `localeCompare`, not code point, contradicting
    `order.ts`. The corpus must pick code-point descending.

### F. Lineage — `[IO]`

73. `[T]` a write with `sources` records one edge, retrievable via `getSources`.
    (`artifact.test.ts:86-113`)
74. `[T]` an edge closing a cycle throws `ArtifactConflictError("lineage cycle forbidden")`. (`:104-112`)
75. `[S]` a self-edge is a cycle.
76. `[S]` a duplicate edge id throws `lineage edge already exists: <id>`.
77. `[S]` an edge with a missing endpoint throws `lineage endpoints must exist`.
78. `[S]` deleting a record removes every edge touching it.
79. `[S]` edges are **not** written on an idempotent replay.
80. `[S]` an edge's `createdAt` comes from the committed record, not a fresh clock read.
81. **DIVERGENCE** `[S]` memory checks the cycle before endpoint existence; the store repository
    checks endpoints first. Pick one.

### G. Leases — `[IO]`

82. `[T]` a live shared-writer lease blocks orphan repair with `conflict/lease-unavailable`; after
    expiry the same plan applies. (`hardening.test.ts:81-114`)
83. `[T]` a lease that expires mid-inspection and is superseded does not delete the object.
    (`hardening.test.ts:210-257`)
84. `[S]` shared leases coexist; exclusive blocks shared and vice versa with distinct reasons.
85. `[S]` reclaiming an expired lease bumps the generation, fencing the stale holder on renew.
86. `[S]` `releaseObjectLease` returns false on any field mismatch.
87. `[S]` an exclusive-delete request fails with `reference-created` when a record references the key.

### H. Maintenance — `[IO]`

88. `[T]` an object store without `list` yields `coverage: "partial"` and no `scannedObjects`.
    (`hardening.test.ts:116-128`)
89. `[T]` a three-edge lineage cycle is detected and conditionally removed.
    (`hardening.test.ts:156-208`)
90. `[T]` a throwing object-store delete propagates instead of becoming a conflict.
    (`hardening.test.ts:259-276`)
91. `[S]` orphan deletion re-checks references, digest, size, and etag twice, with a lease renewal
    before each read and before the delete.
92. `[S]` `reverify-imported-object` never rewrites the record.
93. `[S]` findings sort by `code\0artifactId\0maintenanceRef\0detail` in code-point order.
94. `[S]` action ids are `metadataFingerprint({schema, auditId, operation, precondition})`, so they
    inherit the random `auditId`.
95. `[S]` `applyRepair` with an unknown `auditId` returns `not-found` for every action.

### I. Object-store conformance — `[IO]`, runs against all four adapters

96. `[T]` round-trips bytes, size, mediaType, metadata. (`object-store-conformance.ts:35`)
97. `[T]` accepts an async-iterable source and totals the size. (`:53`)
98. `[T]` overwrites when `ifAbsent` is unset. (`:64`)
99. `[T]` missing key: `get` undefined, `head` undefined, `delete` false. (`:72`)
100. `[T]` delete reports prior existence, then false. (`:79`)
101. `[T]` invalid keys throw. (`:88`)
102. `[T]` `ifAbsent` refuses to replace and preserves the original bytes. (`:94`)
103. `[T]` `FileObjectStore` persists across instances. (`fs.test.ts:35-40`)
104. `[T]` deleting removes bytes and sidecar. (`fs.test.ts:42-48`)
105. `[T]` key `a` and key `a/b` coexist. (`fs.test.ts:50-55`)
106. `[T]` a corrupt sidecar degrades `head` to a `stat` fallback rather than throwing.
     (`fs.test.ts:57-64`)
107. `[T]` a missing sidecar with bytes present yields `{key, sizeBytes}`. (`fs.test.ts:66-70`)
108. `[T]` a failed `ifAbsent` put does not poison the key. (`fs.test.ts:72-82`)
109. `[T]` an overwrite refreshes the sidecar. (`fs.test.ts:84-88`)
110. `[T]` OpenDAL memory backend streams a chunked write and enforces `ifAbsent`.
     (`opendal.test.ts:17-37`)
111. `[T]` OpenDAL rejects `digestMetadataKey` when the backend cannot store user metadata.
     (`opendal.test.ts:39-46`)
112. `[T]` OpenDAL `list` is recursive, sorted, and includes a bare prefix that is itself an object.
     (`opendal.test.ts:48-59`)
113. `[T]` a source failure after bytes were written cleans the conditional object, so the retry
     succeeds. (`opendal.test.ts:61-72`)
114. **DIVERGENCE** `[S]` all three `list` implementations sort by `localeCompare`. Specify code
     point.

---

## 13. Proposed hashing corpus

Directory, following the Phase 2 note in `docs/python-port-spec.md:300-302` ("hashing must be
byte-identical across languages and gets its own corpus directory"):

```
conformance/artifact/hashing/
  bytes/            content digests over raw bytes
  canonical-json/   canonical text + its digest
  fingerprint/      metadataFingerprint cases
  finalization/     artifactFinalizationDigest cases
  errors/           inputs that must be rejected, with the exact message
```

### 13.1 Encoding problem and its solution

JSON cannot express three of the inputs that matter most: negative zero, a lone surrogate, and the
integer/float distinction. The corpus therefore wraps scalars that need it:

```json
{"$num": "-0"}                 // parse as float64 from this exact decimal text
{"$codepoints": [55296]}       // build a string from these code points, incl. lone surrogates
{"$b64": "aGVsbG8="}           // raw bytes
{"$utf8": "hello"}             // bytes from UTF-8 of this string
```

Anything not wrapped is ordinary JSON and means itself. A loader in each language expands the
wrappers before calling the implementation.

### 13.2 File shapes

`bytes/*.json`:

```json
{
  "name": "hello-utf8",
  "input": {"$utf8": "hello"},
  "expected": {
    "algorithm": "sha256",
    "value": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    "sizeBytes": 5
  }
}
```

`canonical-json/*.json`:

```json
{
  "name": "key-order-astral",
  "input": {"😀": 1, "�": 2, "a": 3, "A": 4, "ä": 5},
  "expected_text": "{\"A\":4,\"a\":3,\"ä\":5,\"�\":2,\"😀\":1}",
  "expected_sha256": "b43f65e9bee3e7086d257a2e046302e7008f9750eb067cdb13564c7315f934d6"
}
```

`expected_text` is the canonical string; implementations must compare the produced text **and** its
digest, because a text comparison localizes a failure that a digest comparison only detects.

`errors/*.json`:

```json
{"name": "nan", "input": {"$num": "NaN"}, "expected_error": "non-finite numbers are not JSON-safe"}
```

### 13.3 The twelve cases that discriminate

Every value below is **PROBED** against the real implementation.

| # | Case | Input | `expected_text` | `expected_sha256` | Mistake it catches |
| --- | --- | --- | --- | --- | --- |
| 1 | astral key order | `{U+1F600:1, U+FFFD:2, "a":3, "A":4, "ä":5}` | `{"A":4,"a":3,"ä":5,"�":2,"\u{1F600}":1}` | `b43f65e9bee3e7086d257a2e046302e7008f9750eb067cdb13564c7315f934d6` | UTF-16 code-unit key sort |
| 2 | numeric-looking keys | `{"b":1,"a":2,"10":3,"2":4}` | `{"10":3,"2":4,"a":2,"b":1}` | `61148428c19ea27217951d647538266ed8df349d71b8982b3e3e37dfeb0b9643` | JS property-enumeration order; numeric key sort |
| 3 | negative zero | `{"$num":"-0"}` | `0` | `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9` | Python `-0.0` |
| 4 | large exponent | `1e21` | `1e+21` | `241c4643fa70b1dcde1205b71be4e3bebb17e9f880c8e1a33d0ead6c27271d3c` | fixed-notation printing at the 21 boundary |
| 5 | small exponent | `1e-7` | `1e-7` | `5b33e02f2c5103a05d32f6ba9cb058294452bfbf393967f68bb30c1bdcbbab22` | Python's zero-padded `1e-07` |
| 6 | 2^53 + 1 | `{"$num":"9007199254740993"}` | `9007199254740992` | `c681da39d7273a6a24c15c9cac3a75526ff2ecf8ba4ee60346a0c70c8163bdb2` | Python's exact big ints |
| 7 | integral float | `100` | `100` | `ad57366865126e55649ecb23ae1d48887544976efea46a48eb5d85a6eeb4d306` | `100.0` |
| 8 | subnormal | `5e-324` | `5e-324` | `c46e7ca1be4c8734f373a56530787288fa2058d73d07855e9247e949f811a42a` | non-shortest float repr |
| 9 | empty containers | `{"a":{},"b":[]}` | `{"a":{},"b":[]}` | compute at corpus build | whitespace, `null` for empty |
| 10 | nested nulls | `{"a":[null,{"b":null}],"c":null}` | `{"a":[null,{"b":null}],"c":null}` | `2a7f1a3c029c0e48f68eaeb0215f2f862a39cafd9d9ed84fc7b6a7d1d3a384ce` | dropping nulls the way some emitters do |
| 11 | surrogate pair | `"\u{1F600}"` | `"😀"` raw UTF-8 | `7a0c50b92434b015545fe93ab723db2d4b2cdd14a441405624a9ce8be29f1d5a` | `ensure_ascii=True` |
| 12 | lone surrogate | `{"$codepoints":[55296]}` | `"\ud800"` | `8c0c59dd0d275aadcd462a5fe12eb352cbdfeaf961eae4f85a4660521df7d2f5` | raw lone surrogate, unencodable in UTF-8 |

Three more worth carrying, also **PROBED**:

| # | Case | `expected_text` | `expected_sha256` |
| --- | --- | --- | --- |
| 13 | C0 controls U+0000 U+0001 U+001F | `" "` | `842096a6d3fcd0968fe35809ea5810d33f7072b93743fc0f7b4ff484ae727d20` |
| 14 | quote/backslash/newline/tab | `"a\"b\\c\nd\te"` | `e0127043d1716c8ca6a938b7e89d96244bbca272dba3306802222a2daf1fecb7` |
| 15 | U+2028 U+2029 unescaped | raw two-character string | `e3a0e2262ac7790f4df36b522a8fbdd4ee3370d568eb15dc25c5f1775f14ed6c` |

Plus the empty containers and simple arrays as cheap sanity anchors:
`{}` → `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`,
`[]` → `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`,
`[true,false,null]` → `4d0f18de2133118249c26acc481838d4f6bb6bc1de882d99abbd19ae9397e8df`,
`{"a":{"b":{"c":[1,2,{"d":"e"}]}}}` → `f16ac108f5aa7e1af9d308eb47a1b02f21f2dfa65cc8f9a2af6b54b85d617502`,
`"café ünï 中文"` → `45e7e822afdd27e7e40f6b80bb165c0fb7396ec8e72f3bec1b5872c2d9c66aa5`,
U+007F → `6fe76740e12a93d5598fe685cb6ad3d3c94e44609065a56866b69647772026ec`,
`1.5` → `9f29a130438b81170b92a42650f9a94291ecad60bd47af2a3886e75f7f728725`,
`1e100` → `33d5997bb6b66e3ae3b8e79fff5fe0954bc7b2a38a9d95d83f437d0e57b68f82`.

### 13.4 Error corpus

Six entries with exact messages: `non-finite numbers are not JSON-safe` (NaN and each infinity),
`value is not JSON-safe` (undefined — TypeScript only), `cyclic values are not JSON-safe`,
`symbol keys are not JSON-safe` (TypeScript only), `sparse arrays are not JSON-safe` (TypeScript
only), `array properties are not JSON-safe` (TypeScript only), `only plain objects are JSON-safe`.
Mark the TypeScript-only ones with a `languages: ["ts"]` field so the Python runner skips rather
than fails them.

### 13.5 Fingerprint and finalization corpus

At least these, all **PROBED**:

- `metadataFingerprint({mediaType:"text/plain", filename:"hello.txt"})` =
  `4a9d9af2e1f893f6705ac4e4fb157e41206e815e5090451e23f566a2f3be8297`.
- The §1.3 record's `artifactFinalizationDigest` =
  `a5666b0df1c2ae50a2fd988e4e82d66412721abe5de63fc8842265268475b54a`.
- A record with `kind: ""` versus no `kind`, proving the two produce **different** finalization
  digests and **identical** metadata fingerprints.
- A record differing only in `id`, `objectKey`, or `createdAt`, proving the finalization digest is
  unchanged.
- A record whose `annotations` contain the number and string cases from §13.3, proving the
  canonicalization rules reach through nested metadata.

---

## 14. Portability decisions a port must make

1. **`localeCompare` appears in five places** (`memory.ts:106,462`, `fs.ts:166`,
   `artifact-opendal/src/index.ts:193`) where the rest of Mirk uses code-point order. Specify code
   point and fix TypeScript, or the two languages will page and list differently.
2. **`auditId` is not injectable**, so repair action ids are not reproducible. Add an id factory
   option to `ArtifactMaintenance` in both languages.
3. **Empty-string `kind`/`filename`** are treated differently by the fingerprint and the
   finalization digest. Decide whether to normalize empty strings to absent everywhere.
4. **`addLineage` validation order** differs between the two repositories. Pick one order so the
   error a caller sees is contractual.
5. **Number formatting** needs a real ECMAScript `Number::toString` implementation in Python. This
   is the single largest piece of net-new code the port requires, and it is shared with
   `@mirk/store`'s atomic request digest, so write it once.
6. **Streams**: the Python port should be a synchronous `Iterable[bytes]` port, consistent with the
   Phase 1 sync-by-design decision, with the asyncio wrapper mirroring `toAsync`.
7. **`@mirk/store` reuse**: `StoreArtifactRepository` needs only the KV port, the collection port,
   `getVersioned`, and `mutateAtomically`. No new store surface is required.
