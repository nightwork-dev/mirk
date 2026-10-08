import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { QdrantClient } from "@qdrant/js-client-rest";
import { compareExpect } from "../../store/src/conformance/compare.js";
import type { Scenario } from "../../store/src/conformance/format.js";
import { executeStep, vectorDimensionsFor, type Target } from "../../store/src/conformance/runner.js";
import { QdrantVectorStore } from "../src/index.js";

const qdrantUrl = process.env.MIRK_QDRANT_URL;
const describeQdrant = qdrantUrl ? describe : describe.skip;
const corpusDirectory = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../..",
  "conformance",
  "vector",
);
const scenarios = readdirSync(corpusDirectory)
  .filter((file) => file.endsWith(".json"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(corpusDirectory, file), "utf8")) as Scenario);

describeQdrant("QdrantVectorStore vector conformance corpus", () => {
  it("contains the complete committed vector corpus", () => {
    expect(scenarios).toHaveLength(36);
  });

  it.each(scenarios)("replays $id against native Qdrant", async (scenario) => {
    expect(vectorDimensionsFor(scenario.steps)).toBe(3);
    const client = new QdrantClient({ url: qdrantUrl, checkCompatibility: false });
    const physical = `mirk_ts_corpus_${randomUUID().replaceAll("-", "")}`;
    const store = await QdrantVectorStore.open(client, { collectionName: physical, dimensions: 3 });
    try {
      const methods = ["upsert", "upsertMany", "get", "has", "remove", "count", "search"] as const;
      const api: Record<string, unknown> = {};
      for (const method of methods) {
        api[method] = (store[method] as (...args: unknown[]) => unknown).bind(store);
      }
      const target: Target = { kind: "vector", api };
        for (const [index, step] of scenario.steps.entries()) {
          const outcome = await executeStep(target, step);
          if (step.expect === undefined) {
            expect(outcome, `${scenario.id} step ${index} setup`).toEqual({ ok: true, value: null });
            continue;
          }
          expect(compareExpect(step.expect, outcome), `${scenario.id} step ${index} ${step.op}`).toBeNull();
        }
    } finally {
      await client.deleteCollection(physical);
    }
  });
});
