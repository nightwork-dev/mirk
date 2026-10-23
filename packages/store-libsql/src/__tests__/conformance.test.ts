import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compareExpect } from "../../../store/src/conformance/compare.js";
import { executeStep, scenarioStoreSetup, targetKindFor } from "../../../store/src/conformance/runner.js";
import type { Scenario } from "../../../store/src/conformance/format.js";
import {
  dropTables,
  fileTarget,
  runPrefix,
  sqldBinary,
  sqldTarget,
  startSqld,
  tursoConnection,
  tursoTarget,
  type Sqld,
  type Target,
} from "./targets.js";

const corpusRoot = fileURLToPath(new URL("../../../../conformance/store/", import.meta.url));

function scenarioPaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return scenarioPaths(path);
      return entry.name.endsWith(".json") ? [path] : [];
    })
    .sort();
}

const scenarios = scenarioPaths(corpusRoot).map(
  (path) => ({ file: relative(corpusRoot, path), ...JSON.parse(readFileSync(path, "utf8")) }) as Scenario & { file: string },
);

const METHODS = [
  "get", "set", "has", "delete", "keys",
  "list", "listWhereIn", "getById", "put", "remove", "count",
  "getVersioned", "mutateAtomically", "pruneExpiredReceipts",
] as const;

// Every skip names the scenario and the README difference it reflects. A
// scenario that neither runs green nor matches an entry fails.
const REMOTE_SKIPS = new Map<string, string>([
  ["store/atomic/reject-operation-limit-exceeded", "a server uses the portable maxOperations of 128, not the in-process 4096"],
]);

function replay(target: Target): void {
  it("reads the whole store corpus", () => {
    expect(scenarios.length).toBeGreaterThan(100);
  });

  for (const scenario of scenarios) {
    const skip = target.remote ? REMOTE_SKIPS.get(scenario.id) : undefined;
    if (skip) {
      it.skip(`${scenario.id} [skip: ${skip}]`, () => {});
      continue;
    }
    it(scenario.id, async () => {
      expect(targetKindFor(scenario.ports)).toBe("store");
      const database = await target.fresh();
      try {
        const setup = scenarioStoreSetup(scenario);
        const adapter = await database.open({ versionIdentity: "conformance", ...setup.options });
        const store = adapter.kv as unknown as Record<string, (...args: unknown[]) => unknown>;
        const api = { ...Object.fromEntries(METHODS.map((name) => [name, store[name]!.bind(store)])), ...setup.api };
        for (const [index, step] of scenario.steps.entries()) {
          const outcome = await executeStep({ kind: "store", api }, step);
          if (step.expect === undefined) {
            expect(outcome.ok, `${scenario.id} step ${index} (${step.op}) threw ${outcome.ok ? "" : outcome.message}`).toBe(true);
            continue;
          }
          const diff = compareExpect(step.expect, outcome);
          expect(diff, `${scenario.id} step ${index} (${step.op}): ${diff}`).toBeNull();
        }
      } finally {
        await database.dispose();
      }
    });
  }
}

describe("libSQL file: replays the store conformance corpus", { timeout: 30_000 }, () => replay(fileTarget()));

describe.runIf(sqldBinary)("libSQL sqld replays the store conformance corpus", { timeout: 60_000 }, () => {
  let server: Sqld;
  beforeAll(async () => {
    server = await startSqld(sqldBinary!);
  });
  afterAll(async () => {
    await server?.stop();
  });
  replay(sqldTarget(() => server));
});

describe.runIf(tursoConnection)("libSQL Turso replays the store conformance corpus", { timeout: 120_000 }, () => {
  afterAll(async () => {
    await dropTables(tursoConnection!, runPrefix);
  });
  replay(tursoTarget());
});
