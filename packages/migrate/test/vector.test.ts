import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryVectorStore, toAsyncVector, type VectorDocument, type VectorSpace } from "@mirk/store/vector";
import { NodeSqliteAdapter } from "@mirk/store/node-sqlite";
import { copyVectorManifest, type VectorManifestEntry } from "../src/index.js";

const v = (...values: number[]): Float32Array => Float32Array.from(values);
const spaces: VectorSpace[] = [
  { name: "text", dimensions: 2, metric: "cosine", encoding: "float32" },
  { name: "image", dimensions: 3, metric: "cosine", encoding: "float32" },
];
async function* entries(documents: VectorDocument[]): AsyncIterable<VectorManifestEntry> {
  for (const document of documents) yield { collection: "assets", document };
}

describe("named vector manifests", () => {
  it.each(["memory", "sqlite"])("copies complete maps into %s and resumes after a checkpoint", async (backend) => {
    const directory = mkdtempSync(join(tmpdir(), "mirk-vector-copy-"));
    const path = join(directory, "copy.db");
    let database = backend === "sqlite" ? new NodeSqliteAdapter({ path }) : undefined;
    const destination = toAsyncVector(database?.vector ?? new InMemoryVectorStore());
    const source = new InMemoryVectorStore();
    for (const space of spaces) source.ensureSpace(space.name, space);
    source.upsert("assets", { id: "a", vectors: { text: v(1, 0), image: v(0, 1, 0) }, metadata: { kind: "picture" } });
    source.upsert("assets", { id: "b", vectors: { text: v(0, 1) } });
    const documents = [source.get("assets", "a")!, source.get("assets", "b")!];
    const stopped = new Error("interrupted");
    let processed = 0;
    try {
      await expect(copyVectorManifest({ spaces: source.listSpaces(), entries: entries(documents) }, destination, {
        batchSize: 1,
        async onCheckpoint(checkpoint) {
          processed = checkpoint.processed;
          expect(await destination.listSpaces()).toEqual(source.listSpaces());
          throw stopped;
        },
      })).rejects.toBe(stopped);
      expect(processed).toBe(1);
      expect(await destination.get("assets", "a")).toEqual(documents[0]);
      expect(await copyVectorManifest({ spaces, entries: entries(documents) }, destination, { resume: { vector: processed } })).toBe(2);
      expect(await destination.count("assets")).toBe(2);
      expect(await destination.get("assets", "a")).toEqual(documents[0]);
      expect(await destination.get("assets", "b")).toEqual(documents[1]);
      expect((await destination.search("assets", { space: "image", vector: v(0, 1, 0) })).map((hit) => hit.id)).toEqual(["a"]);
      if (database) {
        database.close();
        database = undefined;
        const reopened = new NodeSqliteAdapter({ path });
        try { expect(reopened.vector.get("assets", "a")).toEqual(documents[0]); expect(reopened.vector.listSpaces()).toEqual(source.listSpaces()); } finally { reopened.close(); }
      }
    } finally { database?.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects missing manifest definitions even for skipped documents", async () => {
    const destination = toAsyncVector(new InMemoryVectorStore());
    await destination.ensureSpace("image", { dimensions: 3 });
    await expect(copyVectorManifest({ spaces: [spaces[0]!], entries: entries([{ id: "a", vectors: { text: v(1, 0), image: v(0, 1, 0) } }]) }, destination, { resume: { vector: 1 } })).rejects.toMatchObject({ code: "unknown-space" });
    expect(await destination.count("assets")).toBe(0);
  });

  it("rejects changed definitions before writing or resuming documents", async () => {
    const destination = toAsyncVector(new InMemoryVectorStore());
    await destination.ensureSpace("text", { dimensions: 2 });
    const changed: VectorSpace = { ...spaces[0]!, dimensions: 4 };
    await expect(copyVectorManifest({ spaces: [changed], entries: entries([{ id: "a", vectors: { text: v(1, 0, 0, 0) } }]) }, destination, { resume: { vector: 1 } })).rejects.toMatchObject({ code: "space-definition-conflict" });
    expect(await destination.count("assets")).toBe(0);
  });
});
