import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compareExpect } from "../../store/src/conformance/compare.js";
import { executeStep, scenarioStoreSetup, targetKindFor } from "../../store/src/conformance/runner.js";
import type { Scenario } from "../../store/src/conformance/format.js";
import { PostgresAdapter, type PostgresAdapterTestOptions } from "./postgres-adapter.js";

const connectionString = process.env.MIRK_POSTGRES_TEST_URL;
const describePostgres = connectionString ? describe : describe.skip;
const corpusRoot = fileURLToPath(new URL("../../../conformance/store/", import.meta.url));

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
  "list", "getById", "put", "remove", "count",
  "listWhereIn", "ensureIndex", "getVersioned", "mutateAtomically", "pruneExpiredReceipts",
] as const;

// Every skip names the scenario and the README difference it reflects. A
// scenario that neither runs green nor matches an entry fails.
const JSONB_TEXT = "jsonb rejects lone surrogates";
const STRICT_PAGINATION = "negative or fractional limit and offset are rejected";
const UNVALIDATED_FILTERS = "filter and collection-name input is not validated like the reference";
const SKIPS = new Map<string, string>([
  ["store/lone-surrogate-values-are-storable", JSONB_TEXT],
  ["store/atomic/lone-surrogate-values", JSONB_TEXT],
  ["store/limit-fractional-truncates", STRICT_PAGINATION],
  ["store/limit-negative-returns-nothing", STRICT_PAGINATION],
  ["store/offset-negative-is-zero", STRICT_PAGINATION],
  ["store/collection-empty-name-throws", UNVALIDATED_FILTERS],
  ["store/list-where-in-non-scalar-value-throws", UNVALIDATED_FILTERS],
  ["store/atomic/reject-operation-limit-exceeded", "the remote default maxOperations is 128, not the in-process 4096"],
]);

describePostgres("PostgreSQL replays the store conformance corpus", () => {
  let pool: Pool;
  const schemas: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString, max: 4 });
  });
  afterAll(async () => {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("reads the whole store corpus", () => {
    expect(scenarios.length).toBeGreaterThan(100);
  });

  for (const scenario of scenarios) {
    const skip = SKIPS.get(scenario.id);
    if (skip) {
      it.skip(`${scenario.id} [skip: ${skip}]`, () => {});
      continue;
    }
    it(scenario.id, async () => {
      expect(targetKindFor(scenario.ports)).toBe("store");
      const schema = `mirk_conformance_${randomUUID().replaceAll("-", "")}`;
      schemas.push(schema);
      const setup = scenarioStoreSetup(scenario);
      const options: PostgresAdapterTestOptions = { pool, schema, versionIdentity: "conformance", ...setup.options };
      const adapter = await PostgresAdapter.open(options);
      const store = adapter.kv as unknown as Record<string, (...args: unknown[]) => unknown>;
      const api = { ...Object.fromEntries(METHODS.map((name) => [name, store[name]!.bind(store)])), ...setup.api };
      try {
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
        await adapter.close();
      }
    });
  }
});
