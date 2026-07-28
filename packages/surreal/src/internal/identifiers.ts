export const KV_TABLE = "mirk_kv";

const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

export function assertSafeTableIdentifier(identifier: string): string {
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new Error(`Unsafe Surreal table identifier: ${identifier}`);
  }
  return identifier;
}

export function collectionTable(collection: string): string {
  if (collection.length === 0) throw new Error("Invalid collection name.");
  return assertSafeTableIdentifier(`mirk_c_${utf8Hex(collection)}`);
}

function utf8Hex(value: string): string {
  let hex = "";
  for (const byte of new TextEncoder().encode(value)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
