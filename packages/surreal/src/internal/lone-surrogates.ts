/**
 * SurrealDB strings are UTF-8, so a lone UTF-16 surrogate in a JavaScript string
 * comes back as U+FFFD. A record that holds one stores each such string as bytes
 * (its UTF-16LE code units) and carries a codec marker that lists the path of
 * every string it encoded. Reads decode those paths and nothing else, so other
 * bytes in the record stay bytes. Records without the marker read unchanged.
 */
export const LONE_SURROGATE_CODEC = "utf16le-lone-surrogates";

export type ValuePath = Array<string | number>;

export interface LoneSurrogateMarker {
  kind: typeof LONE_SURROGATE_CODEC;
  paths: ValuePath[];
}

export interface EncodedValue<T> {
  value: T;
  marker: LoneSurrogateMarker | undefined;
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function hasLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE_RE.test(text);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function encodeLoneSurrogates<T>(value: T): EncodedValue<T> {
  const paths: ValuePath[] = [];
  const visit = (entry: unknown, path: ValuePath): unknown => {
    if (typeof entry === "string") {
      if (!hasLoneSurrogate(entry)) return entry;
      paths.push(path);
      return utf16leBytes(entry);
    }
    if (Array.isArray(entry)) return entry.map((item, index) => visit(item, [...path, index]));
    if (isPlainObject(entry)) {
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(entry)) out[key] = visit(field, [...path, key]);
      return out;
    }
    return entry;
  };
  const next = visit(value, []) as T;
  return paths.length === 0
    ? { value, marker: undefined }
    : { value: next, marker: { kind: LONE_SURROGATE_CODEC, paths } };
}

/**
 * Turn each marked path back into its string. A path that no longer leads to
 * even-length bytes is left as stored, so a hand-edited record still reads.
 */
export function decodeLoneSurrogates<T>(value: T, marker: unknown): T {
  const paths = markerPaths(marker);
  if (paths.length === 0) return value;
  let root: unknown = value;
  for (const path of paths) root = replaceAt(root, path, 0);
  return root as T;
}

function markerPaths(marker: unknown): ValuePath[] {
  if (!isPlainObject(marker) || marker.kind !== LONE_SURROGATE_CODEC || !Array.isArray(marker.paths)) return [];
  return marker.paths.filter(
    (path): path is ValuePath =>
      Array.isArray(path) && path.every((step) => typeof step === "string" || typeof step === "number"),
  );
}

function replaceAt(container: unknown, path: ValuePath, depth: number): unknown {
  if (depth === path.length) {
    const bytes = bytesOf(container);
    return bytes === undefined || bytes.length % 2 !== 0 ? container : utf16leString(bytes);
  }
  const step = path[depth]!;
  if (Array.isArray(container) && typeof step === "number" && step < container.length) {
    const copy = [...container];
    copy[step] = replaceAt(container[step], path, depth + 1);
    return copy;
  }
  if (isPlainObject(container) && typeof step === "string" && Object.prototype.hasOwnProperty.call(container, step)) {
    return { ...container, [step]: replaceAt(container[step], path, depth + 1) };
  }
  return container;
}

function bytesOf(value: unknown): Uint8Array | undefined {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  return undefined;
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
  for (let index = 0; index < bytes.length; index += 2) {
    text += String.fromCharCode(bytes[index]! | (bytes[index + 1]! << 8));
  }
  return text;
}
