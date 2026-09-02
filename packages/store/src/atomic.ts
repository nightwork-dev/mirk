// ─── @mirk/store/atomic ────────────────────────────────────────────────────
// Optional, declarative atomic mutation capability. This module is deliberately
// dependency-free (including the digest implementation) so it remains safe to
// import from the root package and browser-facing ports.

import type { AsyncStore, SyncStore } from "./types.js";
// `order.ts` and `canonical.ts` are dependency-free, so this keeps the module
// dependency-free.
import { compareCodePoints } from "./order.js";
import { canonicalJson, isPlainObject, sha256Hex } from "./canonical.js";

/** @deprecated Spelled `compareCodePoints` in `./order.js`; kept for the
 *  published `@mirk/store/atomic` surface. */
export { compareCodePoints as compareCodePoint } from "./order.js";

/** Canonical JSON used by request digests and bounded payload checks.
 *  Implemented in `./canonical.js`; re-exported here because
 *  `@mirk/store/atomic` and the package root are its published homes. */
export { canonicalJson } from "./canonical.js";

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

/** The request bounds one store applies before its atomic decision point.
 *
 * These are a wire-contract guard, so their right value depends on how far the
 * request travels. A remote adapter serializes the batch over a network and
 * wants the conservative default; an embedded backend never leaves the process
 * and can afford far more. Each store publishes what it enforces.
 */
export interface AtomicMutationLimits {
  readonly maxOperations: number;
  readonly maxConditions: number;
  readonly maxRequestBytes: number;
}

/** The portable defaults: what every store enforced before limits were
 *  configurable, and what a remote or unknown transport should keep. */
export const DEFAULT_ATOMIC_LIMITS: AtomicMutationLimits = Object.freeze({
  maxOperations: 128,
  maxConditions: 128,
  maxRequestBytes: 1024 * 1024,
});

/** In-process backends (the reference and the SQLite adapter) — the request is
 *  never serialized onto a wire and the batch is one local transaction. */
export const IN_PROCESS_ATOMIC_LIMITS: AtomicMutationLimits = Object.freeze({
  maxOperations: 4096,
  maxConditions: 1024,
  maxRequestBytes: 16 * 1024 * 1024,
});

function limitField(
  overrides: Partial<AtomicMutationLimits> | undefined,
  base: AtomicMutationLimits,
  field: keyof AtomicMutationLimits
): number {
  const value = overrides?.[field];
  if (value === undefined) return base[field];
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `${field} must be a positive safe integer; got ${String(value)}.`
    );
  }
  return value;
}

/** Merge caller overrides onto a backend's own defaults. */
export function resolveAtomicLimits(
  overrides?: Partial<AtomicMutationLimits>,
  base: AtomicMutationLimits = DEFAULT_ATOMIC_LIMITS
): AtomicMutationLimits {
  return Object.freeze({
    maxOperations: limitField(overrides, base, "maxOperations"),
    maxConditions: limitField(overrides, base, "maxConditions"),
    maxRequestBytes: limitField(overrides, base, "maxRequestBytes"),
  });
}

export interface SyncAtomicMutationStore extends SyncVersionedReadStore {
  /** The request bounds this store enforces. */
  readonly atomicLimits: AtomicMutationLimits;
  mutateAtomically(request: AtomicMutationRequest): AtomicMutationResult;
}

export interface AsyncAtomicMutationStore extends AsyncVersionedReadStore {
  /** The request bounds this store enforces. */
  readonly atomicLimits: AtomicMutationLimits;
  mutateAtomically(
    request: AtomicMutationRequest
  ): Promise<AtomicMutationResult>;
}

function hasAtomicLimits(candidate: {
  atomicLimits?: AtomicMutationLimits;
}): boolean {
  const limits = candidate.atomicLimits;
  return (
    typeof limits === "object" &&
    limits !== null &&
    typeof limits.maxOperations === "number" &&
    typeof limits.maxConditions === "number" &&
    typeof limits.maxRequestBytes === "number"
  );
}

export function supportsAtomicMutation(
  store: SyncStore
): store is SyncStore & SyncAtomicMutationStore {
  const candidate = store as Partial<SyncAtomicMutationStore>;
  return (
    typeof candidate.getVersioned === "function" &&
    typeof candidate.mutateAtomically === "function" &&
    hasAtomicLimits(candidate)
  );
}

export function supportsAsyncAtomicMutation(
  store: AsyncStore
): store is AsyncStore & AsyncAtomicMutationStore {
  const candidate = store as Partial<AsyncAtomicMutationStore>;
  return (
    typeof candidate.getVersioned === "function" &&
    typeof candidate.mutateAtomically === "function" &&
    hasAtomicLimits(candidate)
  );
}

/** @deprecated Read `store.atomicLimits.maxConditions`, or
 *  `DEFAULT_ATOMIC_LIMITS.maxConditions` for the portable default. */
export const MAX_ATOMIC_CONDITIONS = DEFAULT_ATOMIC_LIMITS.maxConditions;
/** @deprecated Read `store.atomicLimits.maxOperations`, or
 *  `DEFAULT_ATOMIC_LIMITS.maxOperations` for the portable default. */
export const MAX_ATOMIC_OPERATIONS = DEFAULT_ATOMIC_LIMITS.maxOperations;
/** @deprecated Read `store.atomicLimits.maxRequestBytes`, or
 *  `DEFAULT_ATOMIC_LIMITS.maxRequestBytes` for the portable default. */
export const MAX_ATOMIC_REQUEST_BYTES = DEFAULT_ATOMIC_LIMITS.maxRequestBytes;
/** A fixed cap, not configurable: an idempotency outcome is persisted under its
 *  key forever, so no backend may accept a larger one. */
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
  request: AtomicMutationRequest,
  limits: AtomicMutationLimits = DEFAULT_ATOMIC_LIMITS
): ValidatedRequest {
  if (!isPlainObject(request)) invalid("request must be a plain object");
  if (!Array.isArray(request.operations) || request.operations.length === 0)
    invalid("operations must be a non-empty array");
  if (request.operations.length > limits.maxOperations) {
    throw new AtomicMutationRejectedError(
      "operation-limit-exceeded",
      `request has ${request.operations.length} operations; this store's maxOperations is ${limits.maxOperations}`
    );
  }
  if (request.conditions !== undefined && !Array.isArray(request.conditions))
    invalid("conditions must be an array");
  const conditionCount = request.conditions?.length ?? 0;
  if (conditionCount > limits.maxConditions) {
    throw new AtomicMutationRejectedError(
      "condition-limit-exceeded",
      `request has ${conditionCount} conditions; this store's maxConditions is ${limits.maxConditions}`
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
          `outcome is ${outcomeBytes} bytes; the fixed outcome cap is ${MAX_ATOMIC_OUTCOME_BYTES} bytes`
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
  if (requestBytes > limits.maxRequestBytes) {
    throw new AtomicMutationRejectedError(
      "request-size-exceeded",
      `request is ${requestBytes} bytes; this store's maxRequestBytes is ${limits.maxRequestBytes}`
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
