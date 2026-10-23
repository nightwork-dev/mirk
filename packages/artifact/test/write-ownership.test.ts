import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactCoordinator,
  InMemoryArtifactRepository,
  InMemoryObjectStore,
  ObjectAlreadyExistsError,
  type ByteSource,
  type ObjectStore,
} from "../src/index.js";
import { FileObjectStore } from "../src/fs.js";
import { ArtifactMaintenance } from "../src/maintenance.js";
import { drain } from "./object-store-conformance.js";

const text = (value: string) => new TextEncoder().encode(value);
const read = async (store: ObjectStore, key: string) =>
  new TextDecoder().decode(await drain(await store.get(key)));

async function* failingSource(): AsyncIterable<Uint8Array> {
  yield text("partial");
  throw new Error("source failed");
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const stores: [string, () => Promise<ObjectStore>][] = [
  ["InMemoryObjectStore", async () => new InMemoryObjectStore()],
  [
    "FileObjectStore",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "mirk-write-ownership-"));
      roots.push(root);
      return new FileObjectStore({ root });
    },
  ],
];

for (const [name, open] of stores) {
  describe(`${name} write ownership`, () => {
    it("never deletes a concurrent writer's object after a write that stored nothing", async () => {
      const objects = await open();
      const put = objects.put.bind(objects);
      // Another writer with the same deterministic id lands its object between
      // this write's failure and the coordinator's cleanup.
      objects.put = async (key: string, source: ByteSource, options?: Parameters<ObjectStore["put"]>[2]) => {
        try {
          return await put(key, source, options);
        } catch (error) {
          if (key === "artifacts/same") await put(key, text("winner"), { mediaType: "text/plain" });
          throw error;
        }
      };
      const coordinator = new ArtifactCoordinator(objects, new InMemoryArtifactRepository(), {
        idFactory: () => "same",
      });
      await expect(
        coordinator.write({ bytes: failingSource(), mediaType: "text/plain" }),
      ).rejects.toMatchObject({ cleanup: "not-needed" });
      expect(await read(objects, "artifacts/same")).toBe("winner");
    });

    it("refuses an ifAbsent write when another writer created the key while it streamed", async () => {
      const objects = await open();
      let theirs: unknown;
      async function* slowSource(): AsyncIterable<Uint8Array> {
        yield text("mine");
        theirs = await objects.put("k", text("theirs"), { ifAbsent: true }).catch((error: unknown) => error);
        yield text("!");
      }
      const mine = await objects.put("k", slowSource(), { ifAbsent: true }).catch((error: unknown) => error);
      const stored = await read(objects, "k");
      // Exactly one create-if-missing wins, and the stored bytes are the winner's.
      expect([mine, theirs].filter((outcome) => outcome instanceof ObjectAlreadyExistsError)).toHaveLength(1);
      expect(stored).toBe(mine instanceof Error ? "theirs" : "mine!");
    });
  });
}

describe("ArtifactMaintenance namespace", () => {
  it("plans deletions only inside its namespace and leaves everything else alone", async () => {
    const objects = new InMemoryObjectStore();
    const repository = new InMemoryArtifactRepository();
    await objects.put("artifacts/orphan", text("orphan"));
    await objects.put("other-app/upload", text("not ours"));
    await objects.put("artifacts-archive/old", text("not ours either"));
    const maintenance = new ArtifactMaintenance(objects, repository, { namespace: "artifacts" });
    const report = await maintenance.audit();
    expect(report.findings.map((finding) => finding.code)).toEqual(["object-without-record"]);
    const plan = await maintenance.planRepair(report);
    expect(plan.actions.map((action) => action.operation)).toEqual(["delete-unreferenced-object"]);
    expect((await maintenance.applyRepair(plan)).map((result) => result.status)).toEqual(["applied"]);
    expect(await objects.head("artifacts/orphan")).toBeUndefined();
    expect(await read(objects, "other-app/upload")).toBe("not ours");
    expect(await read(objects, "artifacts-archive/old")).toBe("not ours either");
  });
});
