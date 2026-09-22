// ─── Scenarios: canonical JSON and content digests ──────────────────────────
// The `hash` port: a pure target with no backend behind it (`canonicalJson`,
// `canonicalDigest`, `sha256Hex`, `sha256Bytes`). Every case here is a place two
// languages can disagree while both looking correct — key order above the BMP,
// negative zero, the fixed/exponential boundary, integers past 2^53, lone
// surrogates, `ensure_ascii`. Each canonical-json scenario pins the TEXT and the
// DIGEST, because the text localizes a failure the digest only detects.
//
// The values are cross-checked: `docs/python-port/digests/artifact.md` §2 and
// §13.3 probed them independently of this corpus. A generated value that
// disagrees with that document is a finding, not a refresh.
//
// Inputs JSON cannot express are wrapped: `{$num}` (parsed as float64 from
// decimal text), `{$codepoints}` (a string built from code points, lone
// surrogates included), `{$b64}` and `{$utf8}` (raw bytes). The runner expands
// them for the `hash` target only.

import { defineScenario } from "../../src/conformance/define.js";

/** Both ops over the same input: the canonical text, then its digest. */
function canonicalCase(name: string, title: string, input: unknown) {
  return defineScenario({
    id: `artifact/hashing/canonical-json/${name}`,
    title,
    ports: ["hash"],
    steps: [
      { op: "canonicalJson", args: [input], expect: { value: true } },
      { op: "canonicalDigest", args: [input], expect: { value: true } },
    ],
  });
}

function rejectCase(name: string, title: string, input: unknown) {
  return defineScenario({
    id: `artifact/hashing/canonical-json/${name}`,
    title,
    ports: ["hash"],
    steps: [
      { op: "canonicalJson", args: [input], expect: { throws: true } },
      { op: "canonicalDigest", args: [input], expect: { throws: true } },
    ],
  });
}

const ALL_BYTE_VALUES = ((): string => {
  const bytes = Array.from({ length: 256 }, (_, i) => i);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return Buffer.from(binary, "binary").toString("base64");
})();

export const scenarios = [
  // ── Key ordering ────────────────────────────────────────────────────────
  canonicalCase(
    "key-order-astral",
    "keys sort by Unicode code point, so an astral key sorts after U+FFFD",
    { "\u{1F600}": 1, "�": 2, a: 3, A: 4, "ä": 5 },
  ),
  canonicalCase(
    "numeric-looking-keys",
    'numeric-looking keys sort as text, so "10" precedes "2"',
    { b: 1, a: 2, "10": 3, "2": 4 },
  ),
  canonicalCase(
    "empty-key",
    "the empty string is an ordinary key and sorts first",
    { "": 1, a: 2 },
  ),
  canonicalCase(
    "keys-astral-versus-bmp",
    "two keys differing only above the BMP order by code point, not UTF-16 unit",
    { "a�b": 1, "a\u{1F600}b": 2 },
  ),

  // ── Numbers ─────────────────────────────────────────────────────────────
  canonicalCase("negative-zero", "negative zero prints as 0", { $num: "-0" }),
  canonicalCase("negative-zero-in-array", "negative zero prints as 0 inside an array", [
    { $num: "-0" },
  ]),
  canonicalCase("negative-zero-in-object", "negative zero prints as 0 inside an object", {
    a: { $num: "-0" },
  }),
  canonicalCase(
    "exponent-boundary-1e21",
    "a decimal exponent of 21 switches to exponential form",
    1e21,
  ),
  canonicalCase(
    "exponent-boundary-1e20",
    "a decimal exponent of 20 stays in fixed form",
    1e20,
  ),
  canonicalCase(
    "exponent-boundary-1e-7",
    "a decimal exponent of -7 switches to exponential form with no zero padding",
    1e-7,
  ),
  canonicalCase(
    "exponent-boundary-1e-6",
    "a decimal exponent of -6 stays in fixed form",
    1e-6,
  ),
  canonicalCase("exponent-1e100", "a large exponent carries no leading zeros", 1e100),
  canonicalCase("exponent-2-5e-8", "a small exponential keeps its fractional digits", 2.5e-8),
  canonicalCase(
    "two-pow-53-plus-one",
    "an integer past 2^53 is clamped to the nearest float64",
    { $num: "9007199254740993" },
  ),
  canonicalCase("integral-float", "an integral value prints without a fraction", 100),
  canonicalCase("subnormal", "the smallest subnormal keeps its shortest round-trip form", 5e-324),
  canonicalCase("max-double", "the largest finite float64 round-trips", 1.7976931348623157e308),
  canonicalCase("one-and-a-half", "a simple fraction round-trips", 1.5),
  canonicalCase("negative-one-and-a-half", "a negative fraction keeps its sign", -1.5),
  canonicalCase(
    "float-sum-artifact",
    "the shortest round-trip digits of 0.1 + 0.2 are preserved in full",
    0.30000000000000004,
  ),
  canonicalCase(
    "large-integral",
    "a large integral value below the exponent boundary prints in full",
    123456789012345680000,
  ),

  // ── Strings ─────────────────────────────────────────────────────────────
  canonicalCase(
    "escapes",
    "quote, backslash, newline and tab take their short escape forms",
    'a"b\\c\nd\te',
  ),
  canonicalCase(
    "c0-controls",
    "C0 controls without a short form escape as lowercase \\u00XX",
    { $codepoints: [0, 1, 31] },
  ),
  canonicalCase(
    "line-separators",
    "U+2028 and U+2029 are emitted raw, not escaped",
    { $codepoints: [8232, 8233] },
  ),
  canonicalCase(
    "delete-character",
    "U+007F is emitted raw, not escaped",
    { $codepoints: [127] },
  ),
  canonicalCase(
    "surrogate-pair",
    "an astral character is emitted as raw UTF-8, never as an ASCII escape",
    "\u{1F600}",
  ),
  canonicalCase(
    "lone-surrogate",
    "a lone surrogate escapes as \\udXXX and is in contract",
    { $codepoints: [55296] },
  ),
  canonicalCase(
    "non-ascii-text",
    "accented and CJK text is emitted as raw UTF-8",
    "café ünï 中文",
  ),

  // ── Containers ──────────────────────────────────────────────────────────
  canonicalCase("empty-object", "an empty object is {}", {}),
  canonicalCase("empty-array", "an empty array is []", []),
  canonicalCase("empty-containers", "empty containers nest without whitespace", { a: {}, b: [] }),
  canonicalCase("literals-array", "true, false and null keep their JSON spellings", [
    true,
    false,
    null,
  ]),
  canonicalCase("nested-nulls", "nulls are values and are never dropped", {
    a: [null, { b: null }],
    c: null,
  }),
  canonicalCase("nested-mixed", "nesting adds no separators beyond , and :", {
    a: { b: { c: [1, 2, { d: "e" }] } },
  }),

  // ── Rejections reachable from JSON input ────────────────────────────────
  rejectCase("reject-nan", "NaN is not JSON-safe", { $num: "NaN" }),
  rejectCase("reject-positive-infinity", "positive infinity is not JSON-safe", {
    $num: "Infinity",
  }),
  rejectCase("reject-negative-infinity", "negative infinity is not JSON-safe", {
    $num: "-Infinity",
  }),

  // ── Digests over raw bytes ──────────────────────────────────────────────
  defineScenario({
    id: "artifact/hashing/bytes/utf8-hello",
    title: "sha256 over the UTF-8 bytes of a short string reports size and lowercase hex",
    ports: ["hash"],
    steps: [{ op: "sha256Bytes", args: [{ $utf8: "hello" }], expect: { value: true } }],
  }),

  defineScenario({
    id: "artifact/hashing/bytes/empty",
    title: "sha256 over zero bytes is the empty digest with sizeBytes 0",
    ports: ["hash"],
    steps: [{ op: "sha256Bytes", args: [{ $b64: "" }], expect: { value: true } }],
  }),

  defineScenario({
    id: "artifact/hashing/bytes/all-byte-values",
    title: "sha256 over all 256 byte values spans the padding boundary and stays binary-safe",
    ports: ["hash"],
    steps: [{ op: "sha256Bytes", args: [{ $b64: ALL_BYTE_VALUES }], expect: { value: true } }],
  }),

  defineScenario({
    id: "artifact/hashing/bytes/sha256-hex-empty-string",
    title: "sha256Hex over the empty string is the empty digest",
    ports: ["hash"],
    steps: [{ op: "sha256Hex", args: [""], expect: { value: true } }],
  }),

  defineScenario({
    id: "artifact/hashing/bytes/sha256-hex-non-ascii",
    title: "sha256Hex hashes the UTF-8 encoding of its text, not its code units",
    ports: ["hash"],
    steps: [{ op: "sha256Hex", args: ["café 中文"], expect: { value: true } }],
  }),

  // ── Strings are UTF-16 ──────────────────────────────────────────────────
  // `$codepoints` builds a JavaScript string, and a JavaScript string is UTF-16:
  // a high surrogate followed by a low surrogate IS the astral character, not
  // two lone surrogates. A port whose strings are code-point sequences has to
  // join pairs the same way or it canonicalizes this to two `\u` escapes.
  defineScenario({
    id: "artifact/hashing/canonical-json/surrogate-pair-from-code-units",
    title: "a high and a low surrogate given as code units form one astral character",
    ports: ["hash"],
    steps: [
      { op: "canonicalJson", args: [{ $codepoints: [55357, 56832] }], expect: { value: true } },
      { op: "canonicalDigest", args: [{ $codepoints: [55357, 56832] }], expect: { value: true } },
      {
        op: "canonicalJson",
        args: [{ $codepoints: [55357, 56832, 55296, 56832, 56832] }],
        expect: { value: true },
      },
    ],
  }),

  // `sha256Hex` hashes the UTF-8 of its text the way TextEncoder produces it:
  // a lone surrogate becomes U+FFFD (EF BF BD), never an encoding error.
  defineScenario({
    id: "artifact/hashing/bytes/sha256-hex-lone-surrogate",
    title: "sha256Hex over a lone surrogate hashes the replacement character, as TextEncoder does",
    ports: ["hash"],
    steps: [
      { op: "sha256Hex", args: [{ $codepoints: [55296] }], expect: { value: true } },
      { op: "sha256Hex", args: [{ $codepoints: [97, 56320, 98] }], expect: { value: true } },
      { op: "sha256Hex", args: [{ $codepoints: [65533] }], expect: { value: true } },
    ],
  }),
];
