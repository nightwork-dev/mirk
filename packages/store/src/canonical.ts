// ─── Canonical JSON and SHA-256 ─────────────────────────────────────────────
// The byte-identical half of the atomic mutation contract, extracted so the
// hashing rules have one home and one conformance target. Dependency-free:
// `order.ts` is itself import-free, and the digest is hand-rolled rather than
// taken from node:crypto so this module stays safe for root and browser imports.
//
// Reached through `./atomic.js` and the package root; it is not a published
// subpath of its own.

import { compareCodePoints } from "./order.js";

const encoder = new TextEncoder();

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value: unknown, stack: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("non-finite numbers are not JSON-safe");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("value is not JSON-safe");
  if (stack.has(value)) throw new TypeError("cyclic values are not JSON-safe");
  if (Object.getOwnPropertySymbols(value).length > 0)
    throw new TypeError("symbol keys are not JSON-safe");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      for (let i = 0; i < value.length; i += 1) {
        if (!(i in value))
          throw new TypeError("sparse arrays are not JSON-safe");
      }
      for (const key of keys) {
        // JSON arrays contain only their canonical integer indices. Reject
        // enumerable extras (including aliases such as `01`) instead of
        // silently dropping them from the digest.
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
          throw new TypeError("array properties are not JSON-safe");
        }
      }
      return `[${value
        .map((entry) => canonicalValue(entry, stack))
        .join(",")}]`;
    }
    if (!isPlainObject(value))
      throw new TypeError("only plain objects are JSON-safe");
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalValue(value[key], stack)}`
      )
      .join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

/** Canonical JSON used by request digests and bounded payload checks. */
export function canonicalJson(value: unknown): string {
  return canonicalValue(value, new Set<object>());
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Standard SHA-256 over raw bytes, lowercase hex. */
export function sha256HexBytes(bytes: Uint8Array): string {
  const words = new Uint32Array(64);
  const K = SHA256_K;
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const bitLength = bytes.length * 8;
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLength >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = words[i - 15]!;
      const y = words[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 =
        ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i += 1) {
      const s1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i]! + words[i]!) >>> 0;
      const s0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

/** SHA-256 over the UTF-8 encoding of `text`, lowercase hex. */
export function sha256Hex(text: string): string {
  return sha256HexBytes(encoder.encode(text));
}

/** The digest of a value's canonical JSON: the identity every request digest,
 *  metadata fingerprint and finalization digest is built from. */
export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
