import { canonicalJson } from "./canonical.js";

export const ENCRYPTED_RECORD_VERSION = 1;
export const ENCRYPTED_RECORD_SUITE = "AES-256-GCM";
export const ENCRYPTED_RECORD_PURPOSE = "mirk.store.encrypted-record";

const NONCE_BYTES = 12;
const AES_256_KEY_BYTES = 32;
const AES_GCM_TAG_BITS = 128;
const AES_GCM_TAG_BYTES = AES_GCM_TAG_BITS / 8;
const MAX_CONTEXT_FIELD_BYTES = 1_024;
const MAX_KEY_ID_BYTES = 256;
const MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_PLAINTEXT_BYTES + AES_GCM_TAG_BYTES;

const CONTEXT_KEYS = [
  "tenantScope",
  "vaultId",
  "recordId",
  "revisionId",
] as const;
const ENVELOPE_KEYS = [
  "ciphertext",
  "keyId",
  "nonce",
  "purpose",
  "recordId",
  "revisionId",
  "suite",
  "tenantScope",
  "vaultId",
  "version",
] as const;

const textEncoder = new TextEncoder();

type BrowserOrNodeGlobal = typeof globalThis & {
  atob?: (data: string) => string;
  btoa?: (data: string) => string;
  Buffer?: {
    from(
      data: string | ArrayBuffer | ArrayBufferView,
      encoding?: string,
    ): {
      toString(encoding?: string): string;
      readonly length: number;
      [index: number]: number;
    };
  };
  crypto?: CryptoLike;
};

type CryptoLike = {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
  subtle: SubtleCryptoLike;
};

type SubtleCryptoLike = {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: "AES-GCM"; length: 256 },
    extractable: false,
    keyUsages: ["encrypt"] | ["decrypt"],
  ): Promise<unknown>;
  encrypt(
    algorithm: { name: "AES-GCM"; iv: Uint8Array; additionalData: Uint8Array; tagLength: 128 },
    key: unknown,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
  decrypt(
    algorithm: { name: "AES-GCM"; iv: Uint8Array; additionalData: Uint8Array; tagLength: 128 },
    key: unknown,
    data: Uint8Array,
  ): Promise<ArrayBuffer>;
};

export type EncryptedRecordContext = {
  tenantScope: string;
  vaultId: string;
  recordId: string;
  revisionId: string;
};

export type EncryptedRecordEnvelope = {
  version: typeof ENCRYPTED_RECORD_VERSION;
  suite: typeof ENCRYPTED_RECORD_SUITE;
  purpose: typeof ENCRYPTED_RECORD_PURPOSE;
  tenantScope: string;
  vaultId: string;
  recordId: string;
  revisionId: string;
  keyId: string;
  nonce: string;
  ciphertext: string;
};

export type EncryptedRecordErrorCode =
  | "authentication-failed"
  | "invalid-context"
  | "invalid-envelope"
  | "invalid-key"
  | "unsupported-format";

export class EncryptedRecordError extends Error {
  declare readonly name: "EncryptedRecordError";
  readonly code: EncryptedRecordErrorCode;

  constructor(code: EncryptedRecordErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(EncryptedRecordError.prototype, "name", {
  value: "EncryptedRecordError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export function validateEncryptedRecordEnvelope(value: unknown): EncryptedRecordEnvelope {
  return validateEnvelope(value);
}

export async function sealEncryptedRecord(
  context: EncryptedRecordContext,
  plaintext: Uint8Array,
  key: Uint8Array,
  keyId: string,
): Promise<EncryptedRecordEnvelope> {
  const validatedContext = validateContext(context);
  const validatedKeyId = validateContextString("keyId", keyId, MAX_KEY_ID_BYTES);
  validatePlaintext(plaintext);
  const crypto = getCrypto();
  validateKey(key);
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  const envelopeHeader = {
    version: ENCRYPTED_RECORD_VERSION,
    suite: ENCRYPTED_RECORD_SUITE,
    purpose: ENCRYPTED_RECORD_PURPOSE,
    ...validatedContext,
    keyId: validatedKeyId,
  } satisfies Omit<EncryptedRecordEnvelope, "nonce" | "ciphertext">;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    copyBytes(key),
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      aesGcmParameters(nonce, authenticatedData(envelopeHeader)),
      cryptoKey,
      plaintext,
    ),
  );
  return {
    ...envelopeHeader,
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(ciphertext),
  };
}

export async function openEncryptedRecord(
  expectedContext: EncryptedRecordContext,
  envelope: EncryptedRecordEnvelope,
  key: Uint8Array,
): Promise<Uint8Array> {
  const validatedContext = validateContext(expectedContext);
  const validatedEnvelope = validateEnvelope(envelope);
  for (const field of CONTEXT_KEYS) {
    if (validatedEnvelope[field] !== validatedContext[field]) {
      throw new EncryptedRecordError(
        "authentication-failed",
        `encrypted record ${field} does not match expected context`,
      );
    }
  }
  const crypto = getCrypto();
  validateKey(key);
  const nonce = decodeBase64Url(validatedEnvelope.nonce, "nonce", NONCE_BYTES);
  const ciphertext = decodeBase64Url(
    validatedEnvelope.ciphertext,
    "ciphertext",
    undefined,
    MAX_CIPHERTEXT_BYTES,
  );
  const header = {
    version: validatedEnvelope.version,
    suite: validatedEnvelope.suite,
    purpose: validatedEnvelope.purpose,
    tenantScope: validatedEnvelope.tenantScope,
    vaultId: validatedEnvelope.vaultId,
    recordId: validatedEnvelope.recordId,
    revisionId: validatedEnvelope.revisionId,
    keyId: validatedEnvelope.keyId,
  } satisfies Omit<EncryptedRecordEnvelope, "nonce" | "ciphertext">;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    copyBytes(key),
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  try {
    const plaintext = await crypto.subtle.decrypt(
      aesGcmParameters(nonce, authenticatedData(header)),
      cryptoKey,
      ciphertext,
    );
    if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
      throw new EncryptedRecordError(
        "invalid-envelope",
        "encrypted record plaintext exceeds the size limit",
      );
    }
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof EncryptedRecordError) throw error;
    throw new EncryptedRecordError(
      "authentication-failed",
      "encrypted record authentication failed",
    );
  }
}

function validateContext(context: EncryptedRecordContext): EncryptedRecordContext {
  if (!isPlainRecord(context)) {
    throw new EncryptedRecordError("invalid-context", "encrypted record context must be an object");
  }
  const keys = Object.keys(context).sort();
  if (keys.join("\0") !== [...CONTEXT_KEYS].sort().join("\0")) {
    throw new EncryptedRecordError(
      "invalid-context",
      "encrypted record context has invalid fields",
    );
  }
  return {
    tenantScope: validateContextString("tenantScope", context.tenantScope),
    vaultId: validateContextString("vaultId", context.vaultId),
    recordId: validateContextString("recordId", context.recordId),
    revisionId: validateContextString("revisionId", context.revisionId),
  };
}

function validateEnvelope(envelope: unknown): EncryptedRecordEnvelope {
  if (!isPlainRecord(envelope)) {
    throw new EncryptedRecordError("invalid-envelope", "encrypted record envelope must be an object");
  }
  const keys = Object.keys(envelope).sort();
  if (keys.join("\0") !== [...ENVELOPE_KEYS].sort().join("\0")) {
    throw new EncryptedRecordError(
      "invalid-envelope",
      "encrypted record envelope has invalid fields",
    );
  }
  if (envelope.version !== ENCRYPTED_RECORD_VERSION) {
    throw new EncryptedRecordError(
      "unsupported-format",
      "encrypted record version is not supported",
    );
  }
  if (envelope.suite !== ENCRYPTED_RECORD_SUITE) {
    throw new EncryptedRecordError(
      "unsupported-format",
      "encrypted record suite is not supported",
    );
  }
  if (envelope.purpose !== ENCRYPTED_RECORD_PURPOSE) {
    throw new EncryptedRecordError(
      "unsupported-format",
      "encrypted record purpose is not supported",
    );
  }
  const nonce = validateBase64UrlString("nonce", envelope.nonce);
  const ciphertext = validateBase64UrlString("ciphertext", envelope.ciphertext);
  decodeBase64Url(nonce, "nonce", NONCE_BYTES);
  decodeBase64Url(ciphertext, "ciphertext", AES_GCM_TAG_BYTES, MAX_CIPHERTEXT_BYTES);
  return {
    version: ENCRYPTED_RECORD_VERSION,
    suite: ENCRYPTED_RECORD_SUITE,
    purpose: ENCRYPTED_RECORD_PURPOSE,
    tenantScope: validateContextString("tenantScope", envelope.tenantScope),
    vaultId: validateContextString("vaultId", envelope.vaultId),
    recordId: validateContextString("recordId", envelope.recordId),
    revisionId: validateContextString("revisionId", envelope.revisionId),
    keyId: validateContextString("keyId", envelope.keyId, MAX_KEY_ID_BYTES),
    nonce,
    ciphertext,
  };
}

function validateContextString(
  field: string,
  value: unknown,
  maxBytes = MAX_CONTEXT_FIELD_BYTES,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new EncryptedRecordError(
      field === "keyId" ? "invalid-envelope" : "invalid-context",
      `encrypted record ${field} must be a non-empty string`,
    );
  }
  if (textEncoder.encode(value).byteLength > maxBytes) {
    throw new EncryptedRecordError(
      field === "keyId" ? "invalid-envelope" : "invalid-context",
      `encrypted record ${field} exceeds the size limit`,
    );
  }
  return value;
}

function validatePlaintext(plaintext: Uint8Array): void {
  if (!(plaintext instanceof Uint8Array)) {
    throw new EncryptedRecordError("invalid-envelope", "plaintext must be a Uint8Array");
  }
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new EncryptedRecordError("invalid-envelope", "plaintext exceeds the size limit");
  }
}

function validateKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.byteLength !== AES_256_KEY_BYTES) {
    throw new EncryptedRecordError("invalid-key", "encrypted record key must be 32 bytes");
  }
}

function validateBase64UrlString(field: string, value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new EncryptedRecordError(
      "invalid-envelope",
      `encrypted record ${field} must be base64url`,
    );
  }
  return value;
}

function decodeBase64Url(
  value: string,
  field: string,
  expectedLengthOrMinLength?: number,
  maxLength?: number,
): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64UrlUnchecked(value);
  } catch {
    throw new EncryptedRecordError(
      "invalid-envelope",
      `encrypted record ${field} must be base64url`,
    );
  }
  if (field === "nonce" && expectedLengthOrMinLength !== undefined && bytes.byteLength !== expectedLengthOrMinLength) {
    throw new EncryptedRecordError(
      "invalid-envelope",
      `encrypted record ${field} has invalid length`,
    );
  }
  if (
    field !== "nonce" &&
    expectedLengthOrMinLength !== undefined &&
    bytes.byteLength < expectedLengthOrMinLength
  ) {
    throw new EncryptedRecordError(
      "invalid-envelope",
      `encrypted record ${field} is too short`,
    );
  }
  if (maxLength !== undefined && bytes.byteLength > maxLength) {
    throw new EncryptedRecordError(
      "invalid-envelope",
      `encrypted record ${field} exceeds the size limit`,
    );
  }
  return bytes;
}

function authenticatedData(
  header: Omit<EncryptedRecordEnvelope, "nonce" | "ciphertext">,
): Uint8Array {
  return textEncoder.encode(canonicalJson(header));
}

function aesGcmParameters(nonce: Uint8Array, additionalData: Uint8Array) {
  return {
    name: "AES-GCM" as const,
    iv: nonce,
    additionalData,
    tagLength: 128 as const,
  };
}

function getCrypto(): CryptoLike {
  const crypto = (globalThis as BrowserOrNodeGlobal).crypto;
  if (crypto === undefined || crypto.subtle === undefined) {
    throw new EncryptedRecordError("unsupported-format", "WebCrypto AES-GCM is unavailable");
  }
  return crypto;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encodeBase64Url(bytes: Uint8Array): string {
  const globals = globalThis as BrowserOrNodeGlobal;
  if (typeof globals.btoa === "function") {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globals
      .btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }
  if (globals.Buffer !== undefined) {
    return globals.Buffer.from(bytes).toString("base64url");
  }
  throw new EncryptedRecordError("unsupported-format", "base64 encoding is unavailable");
}

function decodeBase64UrlUnchecked(value: string): Uint8Array {
  const globals = globalThis as BrowserOrNodeGlobal;
  if (typeof globals.atob === "function") {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    );
    const binary = globals.atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  if (globals.Buffer !== undefined) {
    const buffer = globals.Buffer.from(value, "base64url");
    return Uint8Array.from({ length: buffer.length }, (_, index) => buffer[index] ?? 0);
  }
  throw new EncryptedRecordError("unsupported-format", "base64 decoding is unavailable");
}
