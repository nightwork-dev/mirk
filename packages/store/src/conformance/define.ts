// ─── Scenario authoring ─────────────────────────────────────────────────────
// Authors declare INPUTS and the FORM of each assertion. They never write an
// expected value: the generator runs the scenario against the in-memory
// reference and fills `expect` in, then refuses to write the file unless the
// SQLite adapter satisfies that same expect.
//
// The markers mirror the `Expect` forms in format.ts:
//   { value: true }                        exact deep equality
//   { approxFields } / { ignoreFields }    list of records, per-field handling
//   { ids: true }                          ordered result ids only
//   { throws: true }                       must throw; the generator pins the
//                                          exact message
//
// A step with no marker is setup. Setup still has to succeed: a setup step that
// throws fails generation and fails replay.

/** Exact deep equality on this step's result. */
export interface MarkValue {
  value: true;
}

/** Compare this step's result as a list of records. `approxFields` compare
 *  within `tol` (default 1e-6); `ignoreFields` are dropped from both sides;
 *  everything else, plus length and order, compares exactly. Both modifiers may
 *  be given together. */
export interface MarkValues {
  approxFields?: string[];
  ignoreFields?: string[];
  tol?: number;
}

/** Compare only the ordered ids of this step's result. */
export interface MarkIds {
  ids: true;
}

/** This step must throw. The generator pins the exact message. */
export interface MarkThrows {
  throws: true;
}

export type StepMarker = MarkValue | MarkValues | MarkIds | MarkThrows;

/** A step as authored: an operation, its positional args, and optionally the
 *  form of the assertion. */
export interface AuthoredStep {
  op: string;
  args: unknown[];
  expect?: StepMarker;
}

export interface AuthoredScenario {
  id: string;
  title: string;
  ports: string[];
  capabilities: string[];
  steps: AuthoredStep[];
}

export interface ScenarioInput {
  id: string;
  title: string;
  ports: string[];
  capabilities?: string[];
  steps: AuthoredStep[];
}

export function isMarkValue(marker: StepMarker): marker is MarkValue {
  return "value" in marker;
}

export function isMarkValues(marker: StepMarker): marker is MarkValues {
  return "approxFields" in marker || "ignoreFields" in marker;
}

export function isMarkIds(marker: StepMarker): marker is MarkIds {
  return "ids" in marker;
}

export function isMarkThrows(marker: StepMarker): marker is MarkThrows {
  return "throws" in marker;
}

/** Two or more kebab segments. The first is the corpus directory the generator
 *  clears and counts; anything between it and the name nests
 *  (`artifact/hashing/canonical-json/<name>`). */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

export function defineScenario(input: ScenarioInput): AuthoredScenario {
  if (!ID_PATTERN.test(input.id)) {
    throw new Error(
      `scenario id must be "<directory>/…/<kebab-name>" with kebab segments; got ${JSON.stringify(input.id)}.`,
    );
  }
  if (input.title.trim().length === 0) {
    throw new Error(`scenario ${input.id}: title is required.`);
  }
  if (input.ports.length === 0) {
    throw new Error(`scenario ${input.id}: at least one port is required.`);
  }
  if (input.steps.length === 0) {
    throw new Error(`scenario ${input.id}: at least one step is required.`);
  }
  // A scenario made only of setup steps replays green forever without checking
  // a single result, so it is evidence of nothing. Setup steps still have to
  // complete, but at least one step must carry an `expect` marker.
  if (!input.steps.some((step) => step.expect !== undefined)) {
    throw new Error(
      `scenario ${input.id} asserts nothing: at least one step needs an \`expect\` marker.`,
    );
  }
  return {
    id: input.id,
    title: input.title,
    ports: [...input.ports],
    capabilities: [...(input.capabilities ?? [])],
    steps: input.steps,
  };
}
