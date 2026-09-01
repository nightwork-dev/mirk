// ─── Expectation comparison ─────────────────────────────────────────────────
// One comparator, used at generation time (does SQLite satisfy the expectation
// the memory reference produced?) and at replay time (does this backend satisfy
// the committed expectation?). Returns null on agreement, or a human-readable
// diff naming the JSON path that disagrees.
//
// Ordering, ids, counts and error messages are EXACT. Tolerance applies only to
// the fields a scenario names in `approxFields` — Mirk's parity contract is
// ordering, and a tolerant compare would hide the bug we most care about.
// `ignoreFields` drops a field from both sides entirely, for output that is
// real but not cross-backend contract.
//
// Throwing is decided here and nowhere else, symmetrically:
//   - a step whose expectation is `{throws}` PASSES only if the call raised and
//     the exception's message equals the pinned string exactly; if the call
//     returned normally the step FAILS;
//   - a step with any other expectation FAILS if the call raised.
// A step with no expectation at all is setup, and the caller enforces the same
// rule on it: setup that throws is a failure, not silence.

import {
  DEFAULT_TOL,
  isExpectIds,
  isExpectThrows,
  isExpectValue,
  isExpectValues,
  type Expect,
} from "./format.js";
import type { StepOutcome } from "./runner.js";

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Exact deep equality over JSON values, reporting the first divergent path.
 *  Integers and floats of equal value are equal (IEEE doubles, `===`). */
function deepDiff(actual: unknown, expected: unknown, path: string): string | null {
  if (typeName(actual) !== typeName(expected)) {
    return `at ${path}: expected ${typeName(expected)} ${show(expected)}, got ${typeName(actual)} ${show(actual)}`;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (actual.length !== expected.length) {
      return `at ${path}: expected length ${expected.length}, got ${actual.length} (${show(actual)})`;
    }
    for (let i = 0; i < expected.length; i++) {
      const diff = deepDiff(actual[i], expected[i], `${path}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }
  if (isRecord(expected) && isRecord(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      if (!(key in expected)) {
        return `at ${path}.${key}: unexpected key with value ${show(actual[key])}`;
      }
      if (!(key in actual)) {
        return `at ${path}.${key}: missing key, expected ${show(expected[key])}`;
      }
      const diff = deepDiff(actual[key], expected[key], `${path}.${key}`);
      if (diff) return diff;
    }
    return null;
  }
  if (actual !== expected) {
    return `at ${path}: expected ${show(expected)}, got ${show(actual)}`;
  }
  return null;
}

/** Remove the ignored fields from a record. Applied to both sides, so an
 *  ignored field is not compared and not required to be present. */
export function stripIgnored(value: unknown, ignoreFields: readonly string[]): unknown {
  if (ignoreFields.length === 0 || !isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (ignoreFields.includes(key)) continue;
    out[key] = entry;
  }
  return out;
}

function compareRecords(
  actual: unknown,
  expected: unknown[],
  approxFields: readonly string[],
  ignoreFields: readonly string[],
  tol: number,
): string | null {
  if (!Array.isArray(actual)) {
    return `at $: expected an array of ${expected.length} records, got ${typeName(actual)} ${show(actual)}`;
  }
  if (actual.length !== expected.length) {
    return `at $: expected length ${expected.length}, got ${actual.length} (${show(actual)})`;
  }
  for (let i = 0; i < expected.length; i++) {
    const expectedRow = stripIgnored(expected[i], ignoreFields);
    const actualRow = stripIgnored(actual[i], ignoreFields);
    if (!isRecord(expectedRow) || !isRecord(actualRow)) {
      const diff = deepDiff(actualRow, expectedRow, `$[${i}]`);
      if (diff) return diff;
      continue;
    }
    const keys = [...new Set([...Object.keys(expectedRow), ...Object.keys(actualRow)])].sort();
    for (const key of keys) {
      if (!(key in expectedRow)) {
        return `at $[${i}].${key}: unexpected key with value ${show(actualRow[key])}`;
      }
      if (!(key in actualRow)) {
        return `at $[${i}].${key}: missing key, expected ${show(expectedRow[key])}`;
      }
      if (approxFields.includes(key)) {
        const a = actualRow[key];
        const e = expectedRow[key];
        if (typeof a !== "number" || typeof e !== "number") {
          return `at $[${i}].${key}: approx field must be numeric, expected ${show(e)}, got ${show(a)}`;
        }
        if (Math.abs(a - e) > tol) {
          return `at $[${i}].${key}: expected ${e} within ${tol}, got ${a} (delta ${Math.abs(a - e)})`;
        }
        continue;
      }
      const diff = deepDiff(actualRow[key], expectedRow[key], `$[${i}].${key}`);
      if (diff) return diff;
    }
  }
  return null;
}

/** Check one step's outcome against its expectation. `null` means agreement. */
export function compareExpect(expect: Expect, actual: StepOutcome): string | null {
  if (isExpectThrows(expect)) {
    // Declared to throw. Returning normally is a failure: a validation rule
    // that stops firing must not pass as agreement.
    if (actual.ok) {
      return `expected a throw with message ${show(expect.throws)}, but the call returned ${show(actual.value)}`;
    }
    // Messages are contract. Exact string, not a code, class or prefix.
    if (actual.message !== expect.throws) {
      return `at $.message: expected ${show(expect.throws)}, got ${show(actual.message)}`;
    }
    return null;
  }

  // Not declared to throw. Raising is a failure, whatever the message says.
  if (!actual.ok) {
    return `expected a result, but the call threw ${show(actual.message)}`;
  }

  if (isExpectValue(expect)) {
    return deepDiff(actual.value, expect.value, "$");
  }
  if (isExpectValues(expect)) {
    return compareRecords(
      actual.value,
      expect.values,
      expect.approxFields ?? [],
      expect.ignoreFields ?? [],
      expect.tol ?? DEFAULT_TOL,
    );
  }
  if (isExpectIds(expect)) {
    if (!Array.isArray(actual.value)) {
      return `at $: expected an array of records, got ${typeName(actual.value)} ${show(actual.value)}`;
    }
    const ids = actual.value.map((row) => (isRecord(row) ? row.id : undefined));
    return deepDiff(ids, expect.ids, "$.ids");
  }

  return `unrecognized expect form ${show(expect)}`;
}
