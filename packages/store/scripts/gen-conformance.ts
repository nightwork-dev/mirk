// ─── Conformance corpus generator ───────────────────────────────────────────
// The ONLY writer of `conformance/**/*.json`. Scenario inputs are authored in
// scripts/scenarios/; every expectation in the corpus is whatever the
// TypeScript in-memory reference produces right now.
//
// Two refusals keep a generated corpus from laundering a bug:
//   1. Every scenario runs against BOTH the in-memory reference and the SQLite
//      adapter. If SQLite does not satisfy the expectation memory produced, the
//      run fails with the scenario id, the step, and the diff. Nothing is
//      written — a divergence is a bug in one backend, not a corpus option.
//   2. A step marked `throws` that does not throw fails generation, and a step
//      not marked `throws` that does throw fails generation, so a validation
//      rule that stops firing cannot quietly become an expectation.
//
// Usage:
//   node … scripts/gen-conformance.ts                  writes conformance/
//   node … scripts/gen-conformance.ts --out <dir>      writes <dir> instead
//
// `--out` exists so scenario authors can verify a new scenario without touching
// the shared corpus, and so the freshness gate can generate into a temporary
// directory and diff rather than overwriting the very edit it is meant to
// catch. Only the integrator runs the no-flag form.
//
// Regenerate after an intentional semantics change and REVIEW THE DIFF: a
// surprising change in a scenario is a regression, not a refresh.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { compareExpect } from "../src/conformance/compare.js";
import {
  isMarkIds,
  isMarkThrows,
  isMarkValue,
  isMarkValues,
  type AuthoredScenario,
  type AuthoredStep,
} from "../src/conformance/define.js";
import {
  DEFAULT_TOL,
  scenarioSchema,
  type Expect,
  type Scenario,
  type Step,
} from "../src/conformance/format.js";
import { openTarget } from "../src/conformance/backends.js";
import { executeStep, type StepOutcome } from "../src/conformance/runner.js";
import { stripIgnored } from "../src/conformance/compare.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
export const DEFAULT_CORPUS_DIR = join(REPO_ROOT, "conformance");
const SCENARIOS_DIR = join(SCRIPT_DIR, "scenarios");

/** Only these subdirectories are cleared. README.md lives at the corpus root
 *  and is not generated, so it survives. */
const GENERATED_DIRS = ["store", "vector", "search", "graph"] as const;

export interface GenerationSummary {
  outDir: string;
  counts: Record<string, number>;
  total: number;
}

async function loadScenarios(): Promise<AuthoredScenario[]> {
  const files = readdirSync(SCENARIOS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  if (files.length === 0) {
    throw new Error(`no scenario modules found in ${SCENARIOS_DIR}`);
  }
  const all: AuthoredScenario[] = [];
  for (const file of files) {
    const module = (await import(pathToFileURL(join(SCENARIOS_DIR, file)).href)) as {
      scenarios?: AuthoredScenario[];
    };
    if (!Array.isArray(module.scenarios)) {
      throw new Error(`${file} must export a \`scenarios\` array.`);
    }
    all.push(...module.scenarios);
  }
  const seen = new Set<string>();
  for (const scenario of all) {
    if (seen.has(scenario.id)) throw new Error(`duplicate scenario id ${scenario.id}.`);
    seen.add(scenario.id);
  }
  all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return all;
}

function idsOf(scenarioId: string, index: number, value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `${scenarioId} step ${index}: an \`ids\` marker needs an array result, got ${JSON.stringify(value)}.`,
    );
  }
  return value.map((row, i) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`${scenarioId} step ${index}: result[${i}] is not a record.`);
    }
    const id = (row as Record<string, unknown>).id;
    if (typeof id !== "string") {
      throw new Error(`${scenarioId} step ${index}: result[${i}] has no string id.`);
    }
    return id;
  });
}

/** Turn the author's marker plus the reference outcome into a concrete
 *  expectation. Returns undefined for a setup step. */
function deriveExpect(
  scenarioId: string,
  index: number,
  step: AuthoredStep,
  outcome: StepOutcome,
): Expect | undefined {
  const marker = step.expect;
  if (!marker) {
    // Setup is not silence: a setup step that throws is a generation failure.
    if (!outcome.ok) {
      throw new Error(
        `${scenarioId} step ${index} (${step.op}): setup step threw on the memory reference: ${outcome.message}`,
      );
    }
    return undefined;
  }

  if (isMarkThrows(marker)) {
    if (outcome.ok) {
      throw new Error(
        `${scenarioId} step ${index} (${step.op}): declared throws, but the call succeeded`,
      );
    }
    return { throws: outcome.message };
  }

  if (!outcome.ok) {
    throw new Error(
      `${scenarioId} step ${index} (${step.op}): threw on the memory reference: ${outcome.message}`,
    );
  }

  if (isMarkValue(marker)) return { value: outcome.value };
  if (isMarkIds(marker)) return { ids: idsOf(scenarioId, index, outcome.value) };
  if (isMarkValues(marker)) {
    if (!Array.isArray(outcome.value)) {
      throw new Error(
        `${scenarioId} step ${index} (${step.op}): a \`values\` marker needs an array result.`,
      );
    }
    const ignoreFields = marker.ignoreFields ?? [];
    const approxFields = marker.approxFields ?? [];
    // Ignored fields are stripped from the stored expectation too, so the
    // corpus never carries a number nobody is allowed to rely on.
    const expect: Expect = { values: outcome.value.map((row) => stripIgnored(row, ignoreFields)) };
    if (approxFields.length > 0) {
      expect.approxFields = [...approxFields];
      expect.tol = marker.tol ?? DEFAULT_TOL;
    }
    if (ignoreFields.length > 0) expect.ignoreFields = [...ignoreFields];
    return expect;
  }
  throw new Error(`${scenarioId} step ${index}: unrecognized marker ${JSON.stringify(marker)}.`);
}

async function buildScenario(authored: AuthoredScenario): Promise<Scenario> {
  const memory = openTarget("memory", authored);
  const sqlite = openTarget("sqlite", authored);
  try {
    const steps: Step[] = [];
    for (const [index, authoredStep] of authored.steps.entries()) {
      const memoryOutcome = await executeStep(memory.target, authoredStep);
      const expect = deriveExpect(authored.id, index, authoredStep, memoryOutcome);
      const sqliteOutcome = await executeStep(sqlite.target, authoredStep);

      if (expect === undefined) {
        if (!sqliteOutcome.ok) {
          throw new Error(
            `${authored.id} step ${index} (${authoredStep.op}) [sqlite]: setup step threw: ${sqliteOutcome.message}`,
          );
        }
      } else {
        const diff = compareExpect(expect, sqliteOutcome);
        if (diff) {
          throw new Error(
            `${authored.id} step ${index} (${authoredStep.op}) [sqlite] disagrees with the memory reference: ${diff}`,
          );
        }
      }

      const step: Step = { op: authoredStep.op, args: authoredStep.args };
      if (expect !== undefined) step.expect = expect;
      steps.push(step);
    }
    return {
      id: authored.id,
      title: authored.title,
      ports: authored.ports,
      capabilities: authored.capabilities,
      steps,
    };
  } finally {
    memory.dispose();
    sqlite.dispose();
  }
}

function writeJson(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

export async function generate(outDir: string = DEFAULT_CORPUS_DIR): Promise<GenerationSummary> {
  const authored = await loadScenarios();

  // Everything is validated against BOTH backends before a single file is
  // written, so a failed run never leaves a half-regenerated corpus on disk.
  const built: Scenario[] = [];
  for (const scenario of authored) {
    built.push(await buildScenario(scenario));
  }

  // rm -rf FIRST, so the regeneration is the complete picture: a scenario
  // dropped from the generator must disappear from disk rather than survive
  // carrying a stale expectation that every runner would happily replay.
  for (const dir of GENERATED_DIRS) {
    rmSync(join(outDir, dir), { recursive: true, force: true });
  }

  writeJson(join(outDir, "scenario.schema.json"), scenarioSchema);

  const counts: Record<string, number> = {};
  for (const scenario of built) {
    writeJson(join(outDir, `${scenario.id}.json`), scenario);
    const dir = scenario.id.slice(0, scenario.id.indexOf("/"));
    counts[dir] = (counts[dir] ?? 0) + 1;
  }

  return { outDir, counts, total: built.length };
}

export function reportSummary(summary: GenerationSummary): void {
  for (const dir of Object.keys(summary.counts).sort()) {
    console.log(`${dir}: ${summary.counts[dir]} scenarios`);
  }
  console.log(`total: ${summary.total} scenarios -> ${summary.outDir}`);
}

function parseOutDir(argv: readonly string[]): string {
  const index = argv.indexOf("--out");
  if (index === -1) return DEFAULT_CORPUS_DIR;
  const value = argv[index + 1];
  if (!value) throw new Error("--out needs a directory argument.");
  return resolve(process.cwd(), value);
}

async function main(): Promise<void> {
  reportSummary(await generate(parseOutDir(process.argv.slice(2))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
