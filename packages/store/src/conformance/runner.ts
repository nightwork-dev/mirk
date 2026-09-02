// ─── Conformance runner ─────────────────────────────────────────────────────
// Executes one scenario step against one backend target. Shared by the
// generator (which derives expectations from the in-memory reference) and by
// the vitest replay (which checks the committed corpus). One code path, so a
// generated expectation and a replayed assertion cannot mean different things.
//
// Zero native dependencies. Backend construction lives in ./backends.ts.
//
// A step never "half succeeds". `executeStep` reports exactly one of two
// outcomes — a JSON-normalized value, or the exact message of the exception the
// call raised — and the comparator decides which one the scenario asked for.

import type { Scenario } from "./format.js";

export type BackendName = "memory" | "sqlite";

/** Which target a scenario's `ports` select. `kv`, `collection` and `atomic`
 *  are one object (SyncStore), so they share the "store" target. `hash` binds a
 *  pure, backend-independent target: canonical JSON and SHA-256. `fixtures`
 *  binds an authored-data loader over the backend store, so a store-source
 *  scenario runs against the real backend. */
export type TargetKind = "store" | "vector" | "search" | "graph" | "hash" | "fixtures";

export interface Target {
  kind: TargetKind;
  api: Record<string, unknown>;
}

export type StepOutcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/** Ports each backend implements. Both TypeScript backends implement all five.
 *  A scenario naming anything else is a corpus error, not a capability gap:
 *  runners FAIL on it and name the port. Skipping would let a typo in `ports`
 *  silently retire a scenario from every backend at once. */
export const BACKEND_PORTS: Record<BackendName, readonly string[]> = {
  memory: ["kv", "collection", "atomic", "hash", "vector", "search", "graph", "fixtures"],
  sqlite: ["kv", "collection", "atomic", "hash", "vector", "search", "graph", "fixtures"],
};

/** The ports a scenario names that this backend cannot bind. Empty is the only
 *  acceptable answer for a corpus scenario. */
export function unsupportedPorts(backend: BackendName, ports: readonly string[]): string[] {
  const supported = BACKEND_PORTS[backend];
  return ports.filter((port) => !supported.includes(port));
}

export function targetKindFor(ports: readonly string[]): TargetKind {
  if (ports.includes("fixtures")) return "fixtures";
  if (ports.includes("hash")) return "hash";
  if (ports.includes("vector")) return "vector";
  if (ports.includes("search")) return "search";
  if (ports.includes("graph")) return "graph";
  if (ports.includes("kv") || ports.includes("collection") || ports.includes("atomic"))
    return "store";
  throw new Error(`no target for ports ${JSON.stringify(ports)}.`);
}

export function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number");
}

/** Vector dimensions for a scenario: the length of the first vector-shaped
 *  argument, either a bare number array or a `vector` field on a document. */
export function vectorDimensionsFor(steps: ReadonlyArray<{ args: unknown[] }>): number {
  for (const step of steps) {
    for (const arg of step.args) {
      if (isNumberArray(arg)) return arg.length;
      const candidates = Array.isArray(arg) ? arg : [arg];
      for (const candidate of candidates) {
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
          const vector = (candidate as Record<string, unknown>).vector;
          if (isNumberArray(vector)) return vector.length;
        }
      }
    }
  }
  throw new Error("a vector scenario must carry at least one vector argument.");
}

function withVectorField(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!isNumberArray(record.vector)) return value;
  return { ...record, vector: Float32Array.from(record.vector) };
}

/** Vectors travel through JSON as number arrays. Convert exactly the two places
 *  the vector port takes one: a bare query vector argument, and the `vector`
 *  field of a document (or of each document in a batch). Nothing else is
 *  touched, so a numeric metadata array stays an array. */
/** The four wrapper keys the `hash` target understands. JSON cannot express
 *  `-0`, a non-finite number, an integer above 2^53, a lone surrogate, or raw
 *  bytes, and every one of those is a case the hashing contract turns on. */
const HASH_WRAPPER_KEYS = ["$num", "$codepoints", "$b64", "$utf8"] as const;

const hashEncoder = new TextEncoder();

function hashWrapperKey(value: object): (typeof HASH_WRAPPER_KEYS)[number] | null {
  const keys = Object.keys(value);
  if (keys.length !== 1) return null;
  const key = keys[0] as (typeof HASH_WRAPPER_KEYS)[number];
  return HASH_WRAPPER_KEYS.includes(key) ? key : null;
}

/** Expand hash wrappers recursively. An object with exactly one key from the
 *  wrapper set IS a wrapper; anything else is ordinary data and means itself. */
export function expandHashArg(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expandHashArg);
  if (value === null || typeof value !== "object") return value;
  const wrapper = hashWrapperKey(value);
  const record = value as Record<string, unknown>;
  if (wrapper === "$num") return Number(record.$num as string);
  if (wrapper === "$codepoints")
    return String.fromCodePoint(...(record.$codepoints as number[]));
  if (wrapper === "$b64") return base64ToBytes(record.$b64 as string);
  if (wrapper === "$utf8") return hashEncoder.encode(record.$utf8 as string);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) out[key] = expandHashArg(entry);
  return out;
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decoded by hand so this module keeps its zero-dependency promise: no Buffer,
 *  no atob, nothing that differs between Node and a browser. */
function base64ToBytes(text: string): Uint8Array {
  const body = text.replace(/=+$/, "");
  const bytes = new Uint8Array((body.length * 3) >> 2);
  let accumulator = 0;
  let bits = 0;
  let out = 0;
  for (const character of body) {
    const digit = BASE64_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error(`invalid base64 character ${JSON.stringify(character)}.`);
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (accumulator >> bits) & 0xff;
    }
  }
  return bytes;
}

function prepareArgs(kind: TargetKind, args: readonly unknown[]): unknown[] {
  if (kind === "hash") return args.map(expandHashArg);
  if (kind !== "vector") return [...args];
  return args.map((arg) => {
    if (isNumberArray(arg)) return Float32Array.from(arg);
    if (Array.isArray(arg)) return arg.map(withVectorField);
    return withVectorField(arg);
  });
}

function toJsonReady(value: unknown): unknown {
  if (value instanceof Float32Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(toJsonReady);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = toJsonReady(entry);
    }
    return out;
  }
  return value;
}

/** Normalize a live result to JSON: Float32Array becomes number[], `undefined`
 *  object properties are stripped, and a `void` return becomes null. */
export function normalizeResult(value: unknown): unknown {
  const ready = toJsonReady(value);
  if (ready === undefined) return null;
  return JSON.parse(JSON.stringify(ready)) as unknown;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Dispatch `step.op` to a method of the same name on the target, with the
 * step's positional args. Async targets (graph) are awaited.
 *
 * The two outcomes are symmetric and the comparator treats them as mutually
 * exclusive: `{ ok: true }` carries the JSON-normalized return value, and
 * `{ ok: false }` carries the exception's message string verbatim. Whether a
 * throw is a pass or a failure is never decided here — a step marked `throws`
 * needs `ok: false` with a matching message, and every other step needs
 * `ok: true`.
 */
export async function executeStep(
  target: Target,
  step: { op: string; args: unknown[] },
): Promise<StepOutcome> {
  const method = target.api[step.op];
  if (typeof method !== "function") {
    return { ok: false, message: `unknown op "${step.op}" on the ${target.kind} target.` };
  }
  try {
    const raw: unknown = await (method as (...a: unknown[]) => unknown).apply(
      target.api,
      prepareArgs(target.kind, step.args),
    );
    return { ok: true, value: normalizeResult(raw) };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

/** What a backend factory is handed: enough of a scenario to pick a target and
 *  size a vector store. */
export type TargetRequest = Pick<Scenario, "ports"> & {
  steps: ReadonlyArray<{ args: unknown[] }>;
};
