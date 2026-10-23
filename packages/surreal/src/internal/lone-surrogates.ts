/**
 * SurrealDB strings are UTF-8, so a lone UTF-16 surrogate in a JavaScript string
 * comes back as U+FFFD. A record that holds one stores each such string as bytes
 * (its UTF-16LE code units) and carries `LONE_SURROGATE_CODEC` so reads know to
 * turn the bytes back into the string. Records without the marker are returned as
 * stored, so a record written before this encoding existed reads unchanged.
 */
export const LONE_SURROGATE_CODEC = "utf16le-lone-surrogates";

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export interface EncodedValue<T> {
  value: T;
  encoded: boolean;
}

export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE_RE.test(text);
}

export function encodeLoneSurrogates<T>(value: T): EncodedValue<T> {
  let encoded = false;
  const visit = (entry: unknown): unknown => {
    if (typeof entry === "string") {
      if (!hasLoneSurrogate(entry)) return entry;
      encoded = true;
      return utf16leBytes(entry);
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry !== null && typeof entry === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(entry as Record<string, unknown>)) out[key] = visit(field);
      return out;
    }
    return entry;
  };
  const next = visit(value) as T;
  return encoded ? { value: next, encoded } : { value, encoded };
}

export function decodeLoneSurrogates<T>(value: T, codec: unknown): T {
  if (codec !== LONE_SURROGATE_CODEC) return value;
  const visit = (entry: unknown): unknown => {
    if (entry instanceof ArrayBuffer) return utf16leString(new Uint8Array(entry));
    if (entry instanceof Uint8Array) return utf16leString(entry);
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry !== null && typeof entry === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(entry as Record<string, unknown>)) out[key] = visit(field);
      return out;
    }
    return entry;
  };
  return visit(value) as T;
}

function utf16leBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    bytes[index * 2] = unit & 0xff;
    bytes[index * 2 + 1] = unit >> 8;
  }
  return bytes;
}

function utf16leString(bytes: Uint8Array): string {
  let text = "";
  for (let index = 0; index + 1 < bytes.length; index += 2) {
    text += String.fromCharCode(bytes[index]! | (bytes[index + 1]! << 8));
  }
  return text;
}
