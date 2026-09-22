export const KV_TABLE = "mirk_kv";

export type SurrealIdentifierErrorCode = "invalid-identifier" | "invalid-collection-name";

export class SurrealIdentifierError extends Error {
  declare readonly name: "SurrealIdentifierError";
  constructor(readonly code: SurrealIdentifierErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(SurrealIdentifierError.prototype, "name", {
  value: "SurrealIdentifierError",
  writable: true,
  configurable: true,
  enumerable: false,
});

const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

export function assertSafeTableIdentifier(identifier: string): string {
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new SurrealIdentifierError("invalid-identifier", `Unsafe Surreal table identifier: ${identifier}`);
  }
  return identifier;
}

export function collectionTable(collection: string): string {
  if (collection.length === 0) throw new SurrealIdentifierError("invalid-collection-name", "Invalid collection name.");
  return assertSafeTableIdentifier(`mirk_c_${utf8Hex(collection)}`);
}

function utf8Hex(value: string): string {
  let hex = "";
  for (const byte of new TextEncoder().encode(value)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
