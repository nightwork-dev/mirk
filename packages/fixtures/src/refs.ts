import { FixtureError } from "./errors.js";
import type { ExplicitRef } from "./types.js";

const TYPE_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ID_RE = /^[^:\s][^:\s]*$/;

export interface ParsedRef {
  type: string;
  id: string;
}

export function parseRef(ref: string): ParsedRef {
  const idx = ref.indexOf(":");
  if (idx <= 0 || idx === ref.length - 1 || ref.indexOf(":", idx + 1) !== -1) {
    throw invalidRef(ref);
  }

  const type = ref.slice(0, idx);
  const id = ref.slice(idx + 1);
  if (!TYPE_RE.test(type) || !ID_RE.test(id)) {
    throw invalidRef(ref);
  }
  return { type, id };
}

export function formatRef(type: string, id: string): string {
  return `${type}:${id}`;
}

export function isCanonicalRef(value: string): boolean {
  try {
    parseRef(value);
    return true;
  } catch {
    return false;
  }
}

export function isExplicitRef(value: unknown): value is ExplicitRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return typeof (value as { $ref?: unknown }).$ref === "string";
}

export function refString(value: ExplicitRef | string): string {
  return typeof value === "string" ? value : value.$ref;
}

function invalidRef(ref: string): FixtureError {
  return new FixtureError({
    severity: "error",
    code: "invalid-ref",
    message: `Invalid fixture ref "${ref}". Expected "type:id".`,
    fixture: ref,
  });
}
