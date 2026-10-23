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
      for (const [key, field] of Object.entries(entry)) {
        Object.defineProperty(out, key, {
          value: visit(field, [...path, key]),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
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
  return decodeNode(value, pathTree(paths)) as T;
}

interface PathNode {
  encoded: boolean;
  children: Map<string | number, PathNode>;
}

function pathTree(paths: readonly ValuePath[]): PathNode {
  const root: PathNode = { encoded: false, children: new Map() };
  for (const path of paths) {
    let node = root;
    for (const step of path) {
      let child = node.children.get(step);
      if (child === undefined) {
        child = { encoded: false, children: new Map() };
        node.children.set(step, child);
      }
      node = child;
    }
    node.encoded = true;
  }
  return root;
}

// One walk over the marked paths. A container is copied at most once, and
// only when something under it decodes.
function decodeNode(container: unknown, node: PathNode): unknown {
  if (node.encoded) {
    const bytes = bytesOf(container);
    if (bytes !== undefined && bytes.length % 2 === 0) return utf16leString(bytes);
  }
  if (node.children.size === 0) return container;
  if (Array.isArray(container)) {
    let copy: unknown[] | undefined;
    for (const [step, child] of node.children) {
      if (typeof step !== "number" || !Number.isInteger(step) || step < 0 || step >= container.length) continue;
      const next = decodeNode(container[step], child);
      if (next === container[step]) continue;
      copy ??= container.slice();
      copy[step] = next;
    }
    return copy ?? container;
  }
  if (isPlainObject(container)) {
    let copy: Record<string, unknown> | undefined;
    for (const [step, child] of node.children) {
      if (typeof step !== "string" || !Object.prototype.hasOwnProperty.call(container, step)) continue;
      const next = decodeNode(container[step], child);
      if (next === container[step]) continue;
      copy ??= { ...container };
      // defineProperty, so a "__proto__" key stays an own field.
      Object.defineProperty(copy, step, { value: next, writable: true, enumerable: true, configurable: true });
    }
    return copy ?? container;
  }
  return container;
}

function markerPaths(marker: unknown): ValuePath[] {
  if (!isPlainObject(marker) || marker.kind !== LONE_SURROGATE_CODEC || !Array.isArray(marker.paths)) return [];
  return marker.paths.filter(
    (path): path is ValuePath =>
      Array.isArray(path) && path.every((step) => typeof step === "string" || typeof step === "number"),
  );
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
