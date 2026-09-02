// ─── Conformance corpus replay ──────────────────────────────────────────────
// Replays every scenario in the language-neutral corpus at `conformance/`
// against every backend that implements its ports. The Python suite replays the
// same files; a behavior that is not in the corpus is not contractual.
//
// This file never authors an expectation. It reads the committed JSON and
// checks it with the same comparator the generator used. Regenerate with
// `pnpm conformance:gen`; `pnpm conformance:current` fails on drift.

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { compareExpect } from "./conformance/compare.js";
import type { Expect, Scenario, Step } from "./conformance/format.js";
import {
  backendCapabilities,
  openTarget,
  unsupportedCapabilities,
} from "./conformance/backends.js";
import { executeStep, unsupportedPorts, type BackendName } from "./conformance/runner.js";

const CORPUS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "conformance");
const BACKENDS: BackendName[] = ["memory", "sqlite"];
/** Directories the generator owns. A directory that exists must carry at least
 *  one scenario AND have at least one of them executed by every backend. */
const KNOWN_DIRS = ["store", "vector", "search", "graph"] as const;

function jsonFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
  }
  return out.sort();
}

/** Structural validation of a scenario file: the required keys, the step shape,
 *  and exactly one recognized `expect` form. A hand check rather than a schema
 *  validator dependency — `conformance/scenario.schema.json` is the document the
 *  Python runner validates against. */
function structuralProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "scenario must be a JSON object";
  }
  const record = value as Record<string, unknown>;
  for (const key of ["id", "title"]) {
    if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
      return `"${key}" must be a non-empty string`;
    }
  }
  for (const key of ["ports", "capabilities"]) {
    const list = record[key];
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) {
      return `"${key}" must be an array of strings`;
    }
  }
  if (!Array.isArray(record.ports) || record.ports.length === 0) {
    return '"ports" must name at least one port';
  }
  for (const key of Object.keys(record)) {
    if (!["id", "title", "ports", "capabilities", "steps"].includes(key)) {
      return `unexpected top-level key "${key}"`;
    }
  }
  const steps = record.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return '"steps" must be a non-empty array';
  }
  // The load-side half of the generator's refusal: a corpus file made only of
  // setup steps replays green while checking nothing.
  if (
    !steps.some(
      (raw) => raw !== null && typeof raw === "object" && !Array.isArray(raw) &&
        (raw as Record<string, unknown>).expect !== undefined,
    )
  ) {
    return `scenario ${String(record.id)} asserts nothing: at least one step needs an "expect"`;
  }
  for (const [index, raw] of steps.entries()) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return `step ${index} must be an object`;
    }
    const step = raw as Record<string, unknown>;
    if (typeof step.op !== "string" || step.op.length === 0) {
      return `step ${index} needs a non-empty "op"`;
    }
    if (!Array.isArray(step.args)) return `step ${index} needs an "args" array`;
    for (const key of Object.keys(step)) {
      if (!["op", "args", "expect"].includes(key)) {
        return `step ${index} has unexpected key "${key}"`;
      }
    }
    if (step.expect === undefined) continue;
    const problem = expectProblem(step.expect);
    if (problem) return `step ${index} expect: ${problem}`;
  }
  return null;
}

function expectProblem(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "must be an object";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const joined = keys.join(",");
  if (joined === "value") return null;
  if (joined === "ids") {
    return Array.isArray(record.ids) && record.ids.every((id) => typeof id === "string")
      ? null
      : '"ids" must be an array of strings';
  }
  if (joined === "throws") {
    return typeof record.throws === "string" ? null : '"throws" must be a string';
  }
  if (keys.includes("values")) {
    const allowed = ["approxFields", "ignoreFields", "tol", "values"];
    const unexpected = keys.filter((key) => !allowed.includes(key));
    if (unexpected.length > 0) return `unexpected key(s) {${unexpected.join(",")}} on a values expect`;
    if (!Array.isArray(record.values)) return '"values" must be an array';
    for (const key of ["approxFields", "ignoreFields"]) {
      if (record[key] === undefined) continue;
      const list = record[key];
      if (!Array.isArray(list) || list.length === 0 || !list.every((f) => typeof f === "string")) {
        return `"${key}" must be a non-empty array of strings`;
      }
    }
    if (record.tol !== undefined && (typeof record.tol !== "number" || !(record.tol > 0))) {
      return '"tol" must be a positive number';
    }
    return null;
  }
  return `unrecognized form with keys {${joined}}`;
}

const files = (existsSync(CORPUS_DIR) ? jsonFiles(CORPUS_DIR) : []).filter(
  (file) => relative(CORPUS_DIR, file) !== "scenario.schema.json",
);

const scenarios = files.map((file) => ({
  file,
  relativePath: relative(CORPUS_DIR, file).split(sep).join("/"),
  scenario: JSON.parse(readFileSync(file, "utf8")) as Scenario,
}));

/** backend → corpus directory → number of scenarios actually executed. */
const executed: Record<string, Record<string, number>> = {};
let totalExecuted = 0;

describe("conformance corpus", () => {
  it("found scenario files", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("every file is structurally a scenario and its id matches its path", () => {
    for (const { relativePath, scenario } of scenarios) {
      const problem = structuralProblem(scenario);
      expect(problem, `${relativePath}: ${problem}`).toBeNull();
      expect(`${scenario.id}.json`, `${relativePath}: id does not match path`).toBe(relativePath);
    }
  });

  it("reports the capabilities each backend has", () => {
    const declared = new Set(scenarios.flatMap(({ scenario }) => scenario.capabilities ?? []));
    for (const backend of BACKENDS) {
      const have = backendCapabilities(backend);
      console.log(`conformance capabilities: ${backend} -> ${have.join(", ") || "(none)"}`);
      expect(have.length, `${backend} reports no capabilities`).toBeGreaterThan(0);
    }
    // The gate is only meaningful if something in the corpus goes through it.
    expect(
      [...declared].length,
      "no corpus scenario declares a capability, so the capability gate is untested",
    ).toBeGreaterThan(0);
  });

  it("carries the store scenarios", () => {
    const storeScenarios = scenarios.filter(({ scenario }) => scenario.id.startsWith("store/"));
    expect(storeScenarios.length).toBeGreaterThan(0);
  });
});

for (const backend of BACKENDS) {
  describe(backend, () => {
    for (const { relativePath, scenario } of scenarios) {
      const name = `${backend} ${scenario.id}`;
      it(name, async () => {
        // No skip path. Both TypeScript backends implement every port, so a
        // scenario the runner cannot bind is a corpus error and must fail
        // naming the port. A skip would let a typo in `ports` quietly retire a
        // scenario from every backend at once.
        const unknown = unsupportedPorts(backend, scenario.ports);
        expect(
          unknown,
          `${scenario.id}: ${backend} cannot bind port(s) ${unknown.join(", ")}`,
        ).toEqual([]);

        // Same rule for optional capabilities, and for the same reason: a
        // scenario that declares `vec0` and then runs on a backend without it
        // proves the fallback path, not the capability. Hard failure, no skip.
        const missing = unsupportedCapabilities(backend, scenario.capabilities ?? []);
        expect(
          missing,
          `${scenario.id}: ${backend} lacks capability(ies) ${missing.join(", ")}`,
        ).toEqual([]);

        const dir = relativePath.slice(0, relativePath.indexOf("/"));
        executed[backend] ??= {};
        executed[backend][dir] = (executed[backend][dir] ?? 0) + 1;
        totalExecuted += 1;

        const { target, dispose } = openTarget(backend, scenario);
        try {
          for (const [index, step] of (scenario.steps as Step[]).entries()) {
            const outcome = await executeStep(target, step);
            if (step.expect === undefined) {
              expect(
                outcome.ok,
                `${scenario.id} step ${index} (${step.op}): setup step threw ${
                  outcome.ok ? "" : outcome.message
                }`,
              ).toBe(true);
              continue;
            }
            const diff = compareExpect(step.expect as Expect, outcome);
            expect(diff, `${scenario.id} step ${index} (${step.op}): ${diff}`).toBeNull();
          }
        } finally {
          dispose();
        }
      });
    }
  });
}

// ── Guard the guard ─────────────────────────────────────────────────────────
// Presence-gated loops assert nothing when the corpus is empty. These run after
// the replay and check the corpus itself, not the backends.
afterAll(() => {
  expect(totalExecuted, "no conformance scenario was executed").toBeGreaterThan(0);
  const present = new Set(scenarios.map(({ relativePath }) => relativePath.split("/")[0]));
  for (const dir of KNOWN_DIRS) {
    if (!present.has(dir)) continue;
    for (const backend of BACKENDS) {
      expect(
        executed[backend]?.[dir] ?? 0,
        `${backend} executed no scenario from conformance/${dir}`,
      ).toBeGreaterThan(0);
    }
  }
  expect(present.has("store"), "the corpus has no store scenarios").toBe(true);
});
