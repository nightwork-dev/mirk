import type { Vector } from "./types.js";

/** Cosine similarity in [-1, 1]. Exact. Shared by the in-memory backend and the
 *  sqlite backend's search path. Returns 0 for length mismatch or a zero vector
 *  (undefined direction). */
export function cosineSimilarity(a: Vector, b: Vector): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    an += av * av;
    bn += bv * bv;
  }
  if (an === 0 || bn === 0) return 0;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
}

/** Encode a vector as a little-endian float32 BLOB. Writes explicit LE (matching
 *  bufferToVector's readFloatLE), so it is portable across host byte order — and
 *  into a fresh buffer, so the result never aliases the source's backing memory. */
export function vectorToBuffer(vec: Vector): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i] ?? 0, i * 4);
  }
  return buf;
}

/** Inverse of vectorToBuffer. */
export function bufferToVector(buf: Buffer | Uint8Array): Vector {
  const b = buf instanceof Buffer ? buf : Buffer.from(buf);
  const out = new Float32Array(Math.floor(b.byteLength / 4));
  for (let i = 0; i < out.length; i++) {
    out[i] = b.readFloatLE(i * 4);
  }
  return out;
}

/** A vector is usable for cosine similarity only if it is all-finite and has a
 *  non-zero magnitude. A zero / non-finite vector has no cosine direction, so it is
 *  EXCLUDED from search results on EVERY backend (in-memory, sqlite JS path, and
 *  sqlite's vec0 path) — that keeps the backends in parity (vec0 would otherwise
 *  return a zero vector with a null distance). Shared so the rule lives in one place. */
export function isUsableVector(v: Vector): boolean {
  let nonZero = false;
  for (let i = 0; i < v.length; i++) {
    const x = v[i] ?? 0;
    if (!Number.isFinite(x)) return false;
    if (x !== 0) nonZero = true;
  }
  return nonZero;
}

/** Throw if a vector's length doesn't match the store's configured dimensions.
 *  Shared by every backend so the check and its message live in one place. */
export function assertDimensions(vector: Vector, dimensions: number): void {
  if (vector.length !== dimensions) {
    throw new Error(`Vector dimension mismatch: expected ${dimensions}, got ${vector.length}`);
  }
}
