// ─── Conformance scenario format ────────────────────────────────────────────
// The on-disk shape of a `conformance/**/*.json` file, declared once. Every
// runner in every language reads this shape. The JSON Schema below is the
// language-neutral copy of the same declaration and is written to
// `conformance/scenario.schema.json` by the generator.
//
// Zero native dependencies: this module and its siblings (define, runner,
// compare) are pure logic so the vitest replay and the Python port's
// counterpart describe the same contract. Backend construction, which does
// touch better-sqlite3, lives in ./backends.ts.
//
// Scenario files are GENERATED, never authored. See conformance/README.md.

/** Exact deep equality against the step's JSON-normalized result. */
export interface ExpectValue {
  value: unknown;
}

/** A list of records compared position by position.
 *
 *  - `approxFields` compare within `tol` instead of exactly.
 *  - `ignoreFields` are removed from BOTH sides before comparing, for values
 *    that are real output but not cross-backend contract (bm25 scores, say,
 *    where ranking and `meta` are contract and the float is not).
 *  - Every other field compares exactly. Length and order are always exact.
 *
 *  Both modifiers may appear on the same expectation. */
export interface ExpectValues {
  values: unknown[];
  approxFields?: string[];
  ignoreFields?: string[];
  tol?: number;
}

/** Ordered result ids only, for contracts that fix ranking but nothing else. */
export interface ExpectIds {
  ids: string[];
}

/** The step must throw, and the exception's message must equal this string
 *  exactly. Messages are contract, not codes or classes. */
export interface ExpectThrows {
  throws: string;
}

export type Expect = ExpectValue | ExpectValues | ExpectIds | ExpectThrows;

/** One operation against the scenario's target. `op` is a port method name as
 *  spelled in the TypeScript port; `args` are positional JSON values.
 *
 *  A step with no `expect` is setup. Setup is not silence: it must complete
 *  without throwing, on every backend, at generation time and at replay time. */
export interface Step {
  op: string;
  args: unknown[];
  expect?: Expect;
}

export interface Scenario {
  /** Stable, unique, `<directory>/<name>`. Also the file path under conformance/. */
  id: string;
  title: string;
  /** Ports this scenario touches. A runner skips a scenario whose ports it does
   *  not implement and reports the skip. */
  ports: string[];
  /** Optional capabilities the scenario requires (`listWhereIn`, `vec0`). */
  capabilities: string[];
  steps: Step[];
}

export function isExpectValue(expect: Expect): expect is ExpectValue {
  return "value" in expect;
}

export function isExpectValues(expect: Expect): expect is ExpectValues {
  return "values" in expect;
}

export function isExpectIds(expect: Expect): expect is ExpectIds {
  return "ids" in expect;
}

export function isExpectThrows(expect: Expect): expect is ExpectThrows {
  return "throws" in expect;
}

/** The default tolerance for `approxFields`. Vector scores only; ordering, ids,
 *  counts and messages are exact everywhere. */
export const DEFAULT_TOL = 1e-6;

/** JSON Schema (draft 2020-12) for a scenario file. Kept beside the TypeScript
 *  declaration above so the two cannot drift apart unreviewed. */
export const scenarioSchema: Record<string, unknown> = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://mirk.dev/conformance/scenario.schema.json",
  title: "Mirk conformance scenario",
  type: "object",
  additionalProperties: false,
  required: ["id", "title", "ports", "capabilities", "steps"],
  properties: {
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    ports: { type: "array", items: { type: "string" }, minItems: 1 },
    capabilities: { type: "array", items: { type: "string" } },
    steps: { type: "array", items: { $ref: "#/$defs/step" }, minItems: 1 },
  },
  $defs: {
    step: {
      type: "object",
      additionalProperties: false,
      required: ["op", "args"],
      properties: {
        op: { type: "string", minLength: 1 },
        args: { type: "array" },
        expect: { $ref: "#/$defs/expect" },
      },
    },
    expect: {
      type: "object",
      oneOf: [
        { $ref: "#/$defs/expectValue" },
        { $ref: "#/$defs/expectValues" },
        { $ref: "#/$defs/expectIds" },
        { $ref: "#/$defs/expectThrows" },
      ],
    },
    expectValue: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: true },
    },
    // `values` is the only required key. `approxFields`, `tol` and
    // `ignoreFields` are independent optional modifiers, so a scenario may
    // carry either, both, or neither.
    expectValues: {
      type: "object",
      additionalProperties: false,
      required: ["values"],
      properties: {
        values: { type: "array" },
        approxFields: { type: "array", items: { type: "string" }, minItems: 1 },
        ignoreFields: { type: "array", items: { type: "string" }, minItems: 1 },
        tol: { type: "number", exclusiveMinimum: 0 },
      },
    },
    expectIds: {
      type: "object",
      additionalProperties: false,
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "string" } } },
    },
    expectThrows: {
      type: "object",
      additionalProperties: false,
      required: ["throws"],
      properties: { throws: { type: "string" } },
    },
  },
};
