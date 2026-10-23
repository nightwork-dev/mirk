import { readFileSync } from "node:fs";

import { Surreal, createRemoteEngines } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";
import { describe, expect, it } from "vitest";

import { compareExpect } from "../../store/src/conformance/compare.js";
import { executeStep, targetKindFor } from "../../store/src/conformance/runner.js";
import { SurrealConnection } from "../src/index.js";
import { SurrealStoreAdapter } from "../src/store.js";

const scenarioFiles = [
  "collection-sort-by-astral-id.json",
  "limit-negative-returns-nothing.json",
];
const scenarios = scenarioFiles.map((file) =>
  JSON.parse(
    readFileSync(new URL(`../../../conformance/store/${file}`, import.meta.url), "utf8"),
  ),
);
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

describe("Surreal store conformance corpus", () => {
  for (const scenario of scenarios) {
    it(scenario.id, async () => {
      expect(targetKindFor(scenario.ports)).toBe("store");
      const { client, connection, store } = await openStore();
      const api = {
        list: store.list.bind(store),
        put: store.put.bind(store),
      };

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
