import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { Surreal, createRemoteEngines } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import { describe, expect, it } from "vitest";

import { compareExpect } from "../../store/src/conformance/compare.js";
import { executeStep, targetKindFor } from "../../store/src/conformance/runner.js";
import { SurrealConnection } from "../src/index.js";
import { SurrealStoreAdapter } from "../src/store.js";

const corpusRoot = fileURLToPath(new URL("../../../conformance/store/", import.meta.url));

function scenarioPaths(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return scenarioPaths(path);
      return entry.name.endsWith(".json") ? [path] : [];
    })
    .sort();
}

const scenarios = scenarioPaths(corpusRoot).map((path) => ({
  file: relative(corpusRoot, path),
  ...JSON.parse(readFileSync(path, "utf8")),
}));

const PORT_METHODS = {
  kv: ["get", "set", "has", "delete", "keys"],
  collection: ["list", "getById", "put", "remove", "count", "ensureIndex"],
  atomic: ["getVersioned", "mutateAtomically"],
};
const CAPABILITY_METHODS = {
  listWhereIn: ["listWhereIn"],
};

function implemented(methods) {
  return methods.every((name) => typeof SurrealStoreAdapter.prototype[name] === "function");
}

const supportedPorts = new Set(
  Object.entries(PORT_METHODS)
    .filter(([, methods]) => implemented(methods))
    .map(([port]) => port),
);
const supportedCapabilities = new Set(
  Object.entries(CAPABILITY_METHODS)
    .filter(([, methods]) => implemented(methods))
    .map(([capability]) => capability),
);

// Every skip is a named rule with its reason. A scenario that neither runs nor
// matches a rule fails, so an unknown port or capability cannot drop out silently.
const SKIP_RULES = [
  {
    name: "atomic-port-not-implemented",
    reason: "SurrealStoreAdapter does not implement @mirk/store/atomic (see the README support matrix).",
    applies: (scenario) => scenario.ports.includes("atomic") && !supportedPorts.has("atomic"),
  },
];

function skipRuleFor(scenario) {
  return SKIP_RULES.find((rule) => rule.applies(scenario));
}

function unsupportedNeeds(scenario) {
  return [
    ...scenario.ports.filter((port) => !supportedPorts.has(port)),
    ...(scenario.capabilities ?? []).filter((capability) => !supportedCapabilities.has(capability)),
  ];
}

let databaseCounter = 0;

async function openStore() {
  const client = new Surreal({
    engines: {
      ...createRemoteEngines(),
      ...createNodeEngines(),
    },
  });
  const connection = await SurrealConnection.open({
    client,
    endpoint: "mem://",
    namespace: "mirk",
    database: `store_conformance_${databaseCounter++}`,
  });
  const store = await SurrealStoreAdapter.open(connection);
  return { client, connection, store };
}

function bindStore(store) {
  const api = {};
  for (const methods of [...Object.values(PORT_METHODS), ...Object.values(CAPABILITY_METHODS)]) {
    for (const name of methods) {
      if (typeof store[name] === "function") api[name] = store[name].bind(store);
    }
  }
  return api;
}

describe("Surreal store conformance corpus", () => {
  it("reads the whole store corpus", () => {
    expect(scenarios.length).toBeGreaterThan(100);
  });

  for (const scenario of scenarios) {
    const rule = skipRuleFor(scenario);
    if (rule) {
      it.skip(`${scenario.id} [skip: ${rule.name}: ${rule.reason}]`, () => {});
      continue;
    }

    it(scenario.id, async () => {
      expect(unsupportedNeeds(scenario), `${scenario.id}: unsupported ports or capabilities`).toEqual([]);
      expect(targetKindFor(scenario.ports)).toBe("store");
      const { client, connection, store } = await openStore();
      const api = bindStore(store);

      try {
        for (const [index, step] of scenario.steps.entries()) {
          const outcome = await executeStep({ kind: "store", api }, step);
          if (step.expect === undefined) {
            expect(
              outcome.ok,
              `${scenario.id} step ${index} (${step.op}) threw ${outcome.ok ? "" : outcome.message}`,
            ).toBe(true);
            continue;
          }
          const diff = compareExpect(step.expect, outcome);
          expect(diff, `${scenario.id} step ${index} (${step.op}): ${diff}`).toBeNull();
        }
      } finally {
        await connection.close();
        await client.close();
      }
    });
  }
});
