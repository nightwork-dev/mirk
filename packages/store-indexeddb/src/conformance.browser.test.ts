import { afterAll, describe, expect, it } from "vitest";
import { compareExpect } from "../../store/src/conformance/compare.js";
import type { Expect, Scenario, Step } from "../../store/src/conformance/format.js";
import { executeStep, targetKindFor } from "../../store/src/conformance/runner.js";
import { openIndexedDbAdapter } from "./index.js";

declare global {
  interface ImportMeta {
    glob<T>(pattern: string, options: { eager: true; import: "default" }): Record<string, T>;
  }
}

const corpus = import.meta.glob<Scenario>("../../../conformance/store/**/*.json", {
  eager: true,
  import: "default",
});

/** Every token in the corpus is pinned to this identity (`conformance-v<n>`). */
const CONFORMANCE_VERSION_IDENTITY = "conformance";

const STORE_METHODS = [
  "get",
  "set",
  "has",
  "delete",
  "keys",
  "list",
  "getById",
  "put",
  "remove",
  "count",
  "getVersioned",
  "mutateAtomically",
] as const;

/** Optional capabilities this adapter does not implement, with the reason. A
 *  scenario declaring one is reported as skipped under that reason; a scenario
 *  declaring a capability missing from this table fails. */
const GATED_CAPABILITIES: Record<string, string> = {
  listWhereIn: "the adapter does not implement the optional listWhereIn (IN query) method",
};

const scenarios = Object.values(corpus).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
let executed = 0;
let gated = 0;

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

describe("conformance corpus on IndexedDB", () => {
  it("found the store corpus", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const scenario of scenarios) {
    const capabilities = scenario.capabilities ?? [];
    const gates = capabilities.filter((capability) => capability in GATED_CAPABILITIES);
    const unknown = capabilities.filter((capability) => !(capability in GATED_CAPABILITIES));
    if (unknown.length > 0) {
      it(scenario.id, () => {
        expect(unknown, `${scenario.id} declares a capability this target neither implements nor gates`).toEqual([]);
      });
      continue;
    }
    if (gates.length > 0) {
      gated += 1;
      it.skip(`${scenario.id} (gated: ${gates.map((gate) => GATED_CAPABILITIES[gate]).join("; ")})`, () => {});
      continue;
    }
    it(scenario.id, async () => {
      expect(scenario.capabilities ?? [], `${scenario.id} declares an unknown capability`).toEqual([]);
      expect(targetKindFor(scenario.ports)).toBe("store");
      executed += 1;
      const dbName = `mirk-conformance-${crypto.randomUUID()}`;
      const adapter = await openIndexedDbAdapter({ dbName, versionIdentity: CONFORMANCE_VERSION_IDENTITY });
      const api: Record<string, unknown> = {};
      for (const name of STORE_METHODS) api[name] = adapter[name].bind(adapter);
      try {
        for (const [index, step] of (scenario.steps as Step[]).entries()) {
          const outcome = await executeStep({ kind: "store", api }, step);
          if (step.expect === undefined) {
            expect(outcome.ok, `${scenario.id} step ${index} (${step.op}): setup step threw ${outcome.ok ? "" : outcome.message}`).toBe(true);
            continue;
          }
          const diff = compareExpect(step.expect as Expect, outcome);
          expect(diff, `${scenario.id} step ${index} (${step.op}): ${diff}`).toBeNull();
        }
      } finally {
        await adapter.close();
        await deleteDatabase(dbName);
      }
    });
  }
});

afterAll(() => {
  console.log(`IndexedDB conformance: ran ${executed} of ${scenarios.length} store scenarios; ${gated} gated by capability`);
  expect(executed + gated).toBe(scenarios.length);
  expect(executed).toBeGreaterThan(0);
});
