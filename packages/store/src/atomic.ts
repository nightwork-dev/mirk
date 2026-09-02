// ─── @mirk/store/atomic ────────────────────────────────────────────────────
// Optional, declarative atomic mutation capability. This module is deliberately
// dependency-free (including the digest implementation) so it remains safe to
// import from the root package and browser-facing ports.

import type { AsyncStore, SyncStore } from "./types.js";
// `order.ts` is itself import-free, so this keeps the module dependency-free.
import { compareCodePoints } from "./order.js";

/** @deprecated Spelled `compareCodePoints` in `./order.js`; kept for the
 *  published `@mirk/store/atomic` surface. */
export { compareCodePoints as compareCodePoint } from "./order.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export type StoreTarget =
  | { kind: "key"; key: string }
  | { kind: "record"; collection: string; id: string };

declare const storeVersionBrand: unique symbol;
export type StoreVersion = string & { readonly [storeVersionBrand]: true };

export interface VersionedStoreValue<T> {
  value: T;
  version: StoreVersion;
}

export interface SyncVersionedReadStore {
  getVersioned<T>(target: StoreTarget): VersionedStoreValue<T> | null;
}

export interface AsyncVersionedReadStore {
  getVersioned<T>(target: StoreTarget): Promise<VersionedStoreValue<T> | null>;
}

export type StoreCondition =
  | { target: StoreTarget; expected: "missing" }
  | { target: StoreTarget; expected: "present" }
  | { target: StoreTarget; expected: "version"; version: StoreVersion };

export type AtomicStoreOperation =
  | { op: "set"; key: string; value: JsonValue }
  | { op: "delete"; key: string }
  | { op: "put"; collection: string; item: { id: string } & JsonObject }
  | { op: "remove"; collection: string; id: string };

export interface AtomicIdempotency {
  key: string;
  outcome?: JsonValue;
}

export interface AtomicMutationRequest {
  conditions?: readonly StoreCondition[];
  operations: readonly AtomicStoreOperation[];
  idempotency?: AtomicIdempotency;
}

export type AtomicMutationResult =
  | {
      status: "applied" | "replayed";
      requestDigest: string;
      versions: readonly {
        target: StoreTarget;
        version: StoreVersion | null;
      }[];
      outcome?: JsonValue;
    }
  | {
      status: "conflict";
      condition: StoreCondition;
      observed: "missing" | "present" | StoreVersion;
    }
  | {
      status: "idempotency-conflict";
      key: string;
      expectedRequestDigest: string;
      receivedRequestDigest: string;
    };

export type AtomicCompletedMutationResult = Extract<
  AtomicMutationResult,
  { status: "applied" | "replayed" }
>;

export type AtomicMutationRejectionCode =
  | "invalid-request"
  | "unsupported-operation"
  | "condition-limit-exceeded"
  | "operation-limit-exceeded"
  | "request-size-exceeded"
  | "outcome-size-exceeded";

export class AtomicMutationRejectedError extends Error {
  readonly name = "AtomicMutationRejectedError";
  constructor(readonly code: AtomicMutationRejectionCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AtomicMutationBackendError extends Error {
  readonly name = "AtomicMutationBackendError";
  constructor(
    readonly code: "unavailable" | "serialization-failure",
    readonly retryable: boolean,
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AtomicMutationIndeterminateError extends Error {
  readonly name = "AtomicMutationIndeterminateError";
  constructor(
    readonly requestDigest: string,
    readonly idempotencyKey: string | undefined,
    readonly recovery: "retry-with-same-key" | "manual-reconciliation",
    message = "Atomic mutation outcome is indeterminate."
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface SyncAtomicMutationStore extends SyncVersionedReadStore {
  mutateAtomically(request: AtomicMutationRequest): AtomicMutationResult;
}

export interface AsyncAtomicMutationStore extends AsyncVersionedReadStore {
  mutateAtomically(
    request: AtomicMutationRequest
  ): Promise<AtomicMutationResult>;
}

export function supportsAtomicMutation(
  store: SyncStore
): store is SyncStore & SyncAtomicMutationStore {
  const candidate = store as Partial<SyncAtomicMutationStore>;
  return (
    typeof candidate.getVersioned === "function" &&
    typeof candidate.mutateAtomically === "function"
  );
}

export function supportsAsyncAtomicMutation(
  store: AsyncStore
): store is AsyncStore & AsyncAtomicMutationStore {
  const candidate = store as Partial<AsyncAtomicMutationStore>;
  return (
    typeof candidate.getVersioned === "function" &&
    typeof candidate.mutateAtomically === "function"
  );
}

export const MAX_ATOMIC_CONDITIONS = 128;
export const MAX_ATOMIC_OPERATIONS = 128;
export const MAX_ATOMIC_REQUEST_BYTES = 1024 * 1024;
export const MAX_ATOMIC_OUTCOME_BYTES = 64 * 1024;

const REQUEST_SCHEMA = "mirk-atomic-request/v1";
const encoder = new TextEncoder();

export function compareTargets(a: StoreTarget, b: StoreTarget): number {
  if (a.kind !== b.kind) return a.kind === "key" ? -1 : 1;
  if (a.kind === "key" && b.kind === "key")
    return compareCodePoints(a.key, b.key);
  if (a.kind === "record" && b.kind === "record") {
    return (
      compareCodePoints(a.collection, b.collection) ||
      compareCodePoints(a.id, b.id)
    );
  }
  return 0;
}

export function targetKey(target: StoreTarget): string {
  // Length-prefix each component. Raw separators are not sufficient because
  // callers may legitimately use those code points in keys, collection names,
  // or ids (for example `collection: "a\0b", id: "c"` versus `"a", "b\0c"`).
  const part = (value: string): string => `${value.length}:${value}`;
  return target.kind === "key"
    ? `k:${part(target.key)}`
    : `r:${part(target.collection)}:${part(target.id)}`;
}

export function cloneJson<T extends JsonValue>(value: T): T {
  // The validator below guarantees JSON values. Parsing the canonical encoding
  // also gives in-memory receipts the same value-copy behavior as SQLite.
  return JSON.parse(canonicalJson(value)) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
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

interface ValidatedRequest {
  conditions: StoreCondition[];
  operations: AtomicStoreOperation[];
  idempotency?: AtomicIdempotency;
  requestDigest: string;
  outcome?: JsonValue;
}

function invalid(message: string): never {
  throw new AtomicMutationRejectedError("invalid-request", message);
}

function targetFromUnknown(value: unknown): StoreTarget {
  if (
    !isPlainObject(value) ||
    (value.kind !== "key" && value.kind !== "record")
  )
    invalid("invalid store target");
  if (value.kind === "key") {
    if (typeof value.key !== "string")
      invalid("key target requires a string key");
    return { kind: "key", key: value.key };
  }
  if (
    typeof value.collection !== "string" ||
    value.collection.length === 0 ||
    typeof value.id !== "string"
  ) {
    invalid("record target requires string collection and id");
  }
  return { kind: "record", collection: value.collection, id: value.id };
}

function jsonSafe(value: unknown, label: string): asserts value is JsonValue {
  try {
    canonicalJson(value);
  } catch (error) {
    invalid(
      `${label} is not JSON-safe: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function operationTarget(operation: AtomicStoreOperation): StoreTarget {
  switch (operation.op) {
    case "set":
    case "delete":
      return { kind: "key", key: operation.key };
    case "put":
      return {
        kind: "record",
        collection: operation.collection,
        id: operation.item.id,
      };
    case "remove":
      return {
        kind: "record",
        collection: operation.collection,
        id: operation.id,
      };
    default:
      throw new AtomicMutationRejectedError(
        "unsupported-operation",
        "unsupported atomic operation"
      );
  }
}

function normalizeOperation(value: unknown): AtomicStoreOperation {
  if (!isPlainObject(value) || typeof value.op !== "string")
    invalid("invalid atomic operation");
  switch (value.op) {
    case "set":
      if (typeof value.key !== "string") invalid("set requires a string key");
      jsonSafe(value.value, "set value");
      return { op: "set", key: value.key, value: cloneJson(value.value) };
    case "delete":
      if (typeof value.key !== "string")
        invalid("delete requires a string key");
      return { op: "delete", key: value.key };
    case "put":
      if (
        typeof value.collection !== "string" ||
        value.collection.length === 0 ||
        !isPlainObject(value.item) ||
        typeof value.item.id !== "string"
      ) {
        invalid("put requires a collection and an item with a string id");
      }
      jsonSafe(value.item, "put item");
      return {
        op: "put",
        collection: value.collection,
        item: cloneJson(value.item) as { id: string } & JsonObject,
      };
    case "remove":
      if (
        typeof value.collection !== "string" ||
        value.collection.length === 0 ||
        typeof value.id !== "string"
      )
        invalid("remove requires string collection and id");
      return { op: "remove", collection: value.collection, id: value.id };
    default:
      throw new AtomicMutationRejectedError(
        "unsupported-operation",
        `unsupported atomic operation: ${value.op}`
      );
  }
}

function normalizeCondition(value: unknown): StoreCondition {
  if (!isPlainObject(value)) invalid("invalid atomic condition");
  const target = targetFromUnknown(value.target);
  if (value.expected === "missing" || value.expected === "present")
    return { target, expected: value.expected };
  if (value.expected === "version" && typeof value.version === "string") {
    return {
      target,
      expected: "version",
      version: value.version as StoreVersion,
    };
  }
  invalid("invalid atomic condition expectation");
}

/** Validate and canonicalize a request before any backend decision point. */
export function validateAtomicRequest(
  request: AtomicMutationRequest
): ValidatedRequest {
  if (!isPlainObject(request)) invalid("request must be a plain object");
  if (!Array.isArray(request.operations) || request.operations.length === 0)
    invalid("operations must be a non-empty array");
  if (request.operations.length > MAX_ATOMIC_OPERATIONS) {
    throw new AtomicMutationRejectedError(
      "operation-limit-exceeded",
      `at most ${MAX_ATOMIC_OPERATIONS} operations are supported`
    );
  }
  if (request.conditions !== undefined && !Array.isArray(request.conditions))
    invalid("conditions must be an array");
  if ((request.conditions?.length ?? 0) > MAX_ATOMIC_CONDITIONS) {
    throw new AtomicMutationRejectedError(
      "condition-limit-exceeded",
      `at most ${MAX_ATOMIC_CONDITIONS} conditions are supported`
    );
  }

  const conditions: StoreCondition[] = [];
  for (let index = 0; index < (request.conditions?.length ?? 0); index += 1) {
    if (!(index in (request.conditions ?? [])))
      invalid("conditions must not be sparse");
    conditions.push(normalizeCondition(request.conditions![index]));
  }
  const conditionKeys = new Set<string>();
  for (const condition of conditions) {
    const key = targetKey(condition.target);
    if (conditionKeys.has(key))
      invalid("repeated conditions for one target are not supported");
    conditionKeys.add(key);
  }
  conditions.sort((a, b) => compareTargets(a.target, b.target));

  const operations: AtomicStoreOperation[] = [];
  for (let index = 0; index < request.operations.length; index += 1) {
    if (!(index in request.operations))
      invalid("operations must not be sparse");
    operations.push(normalizeOperation(request.operations[index]));
  }
  const operationKeys = new Set<string>();
  for (const operation of operations) {
    const key = targetKey(operationTarget(operation));
    if (operationKeys.has(key))
      invalid("repeated operation targets are not supported");
    operationKeys.add(key);
  }

  let idempotency: AtomicIdempotency | undefined;
  let outcome: JsonValue | undefined;
  if (request.idempotency !== undefined) {
    if (
      !isPlainObject(request.idempotency) ||
      typeof request.idempotency.key !== "string"
    )
      invalid("idempotency requires a string key");
    idempotency = { key: request.idempotency.key };
    if ("outcome" in request.idempotency) {
      jsonSafe(request.idempotency.outcome, "idempotency outcome");
      outcome = cloneJson(request.idempotency.outcome);
      const outcomeBytes = encoder.encode(canonicalJson(outcome)).byteLength;
      if (outcomeBytes > MAX_ATOMIC_OUTCOME_BYTES) {
        throw new AtomicMutationRejectedError(
          "outcome-size-exceeded",
          `outcome exceeds ${MAX_ATOMIC_OUTCOME_BYTES} bytes`
        );
      }
      idempotency.outcome = outcome;
    }
  }

  const digestInput: Record<string, unknown> = {
    schema: REQUEST_SCHEMA,
    conditions,
    operations,
  };
  if (outcome !== undefined) digestInput.outcome = outcome;
  const encoded = canonicalJson(digestInput);
  // The idempotency key is deliberately excluded from the digest (the same
  // mutation has the same request identity under any key), but it is still
  // part of the bounded wire request and must not provide an unbounded escape
  // from MAX_ATOMIC_REQUEST_BYTES.
  const requestEncoding =
    idempotency === undefined
      ? encoded
      : canonicalJson({
          ...digestInput,
          idempotency: { key: idempotency.key },
        });
  const requestBytes = encoder.encode(requestEncoding).byteLength;
  if (requestBytes > MAX_ATOMIC_REQUEST_BYTES) {
    throw new AtomicMutationRejectedError(
      "request-size-exceeded",
      `request exceeds ${MAX_ATOMIC_REQUEST_BYTES} bytes`
    );
  }
  return {
    conditions,
    operations,
    idempotency,
    outcome,
    requestDigest: sha256Hex(encoded),
  };
}

// Small synchronous SHA-256 implementation. Keeping this here avoids pulling
// node:crypto into root/kv imports while producing the standard SHA-256 digest.
function sha256Hex(input: string): string {
  const bytes = encoder.encode(input);
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
