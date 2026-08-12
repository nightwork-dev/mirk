import { describe, expect, it } from "vitest";
import { InMemoryObjectStore } from "@mirk/artifact";
import type { ByteStream } from "@mirk/artifact";
import {
  InMemoryKv,
  InMemorySearchStore,
  InMemoryVectorStore,
  toAsync,
  toAsyncSearch,
  toAsyncVector,
} from "@mirk/store";
import {
  copyCollection,
  copyGraphManifest,
  copyObjectManifest,
  copySearchManifest,
  copyVectorManifest,
  migrateStore,
  runMigrationWithVerification,
  upgradeCheckpointV1,
} from "../src/index.js";
import type { MigrationCheckpointV2 } from "../src/index.js";

async function* manifest<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}

async function drain(stream: ByteStream | undefined): Promise<Uint8Array> {
  if (!stream) throw new Error("expected byte stream");
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of stream) {
    parts.push(part);
    size += part.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

describe("@mirk/migrate", () => {
  const plan = {
    schema: "mirk-migration-plan/v1" as const,
    planDigest: "sha256:plan-a",
    sourceIdentity: "source:test",
    destinationIdentity: "destination:test",
  };

  it("upgrades v1 checkpoints only with an explicit complete plan", () => {
    expect(
      upgradeCheckpointV1({
        checkpoint: { lane: "collection:items", processed: 4 },
        plan,
        convertedAt: 123,
      })
    ).toEqual({
      plan,
      lane: "collection:items",
      processed: 4,
      updatedAt: 123,
    });
    expect(() =>
      upgradeCheckpointV1({
        checkpoint: { lane: "", processed: 4 },
        plan,
        convertedAt: 123,
      })
    ).toThrow("lane");
    expect(() =>
      upgradeCheckpointV1({
        checkpoint: { lane: "items", processed: -1 },
        plan,
        convertedAt: 123,
      })
    ).toThrow("processed");
    expect(() =>
      upgradeCheckpointV1({
        checkpoint: {
          lane: "collection:items",
          collection: "other",
          processed: 1,
        },
        plan,
        convertedAt: 123,
      })
    ).toThrow("collection");
  });

  it("normalizes resume checkpoints strictly and rejects duplicates or mixed lanes", async () => {
    const source = toAsync(new InMemoryKv());
    const destination = toAsync(new InMemoryKv());
    const checkpoint = { lane: "collection:items", processed: 0 } as const;

    await expect(
      copyCollection(source, destination, "items", {
        resume: [checkpoint, { ...checkpoint }],
      })
    ).rejects.toThrow("duplicate resume checkpoint lane");
    await expect(
      copyCollection(source, destination, "items", {
        resume: [1] as never,
      })
    ).rejects.toThrow("checkpoint lists must contain checkpoint objects");
    await expect(
      copyCollection(source, destination, "items", {
        resume: {
          first: 1,
          second: { lane: "other", processed: 1 },
        },
      })
    ).rejects.toThrow("cannot mix");
    await expect(
      copyCollection(source, destination, "items", {
        resume: {
          [checkpoint.lane]: { lane: checkpoint.lane, processed: 1, plan },
        },
      })
    ).rejects.toThrow("v2 checkpoint must include plan and updatedAt");
    await expect(
      copyCollection(source, destination, "items", {
        resume: new Map([[checkpoint.lane, 1]]) as never,
      })
    ).rejects.toThrow("checkpoint map or checkpoint list");
  });

  it("matches every plan identity field and snapshots plan data for checkpoints", async () => {
    const source = toAsync(new InMemoryKv());
    const destination = toAsync(new InMemoryKv());
    await source.put("items", { id: "a" });
    await source.put("items", { id: "b" });
    const mutablePlan = { ...plan };
    const emitted: MigrationCheckpointV2[] = [];
    await copyCollection(source, destination, "items", {
      plan: mutablePlan,
      batchSize: 1,
      onCheckpoint(value) {
        if ("plan" in value) {
          emitted.push({ ...value, plan: { ...value.plan } });
          value.plan.planDigest = "mutated-by-callback";
          mutablePlan.destinationIdentity = "mutated-by-caller";
        }
      },
    });
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.plan).toEqual(plan);
    expect(emitted[1]?.plan).toEqual(plan);
    await expect(
      copyCollection(source, destination, "items", {
        plan: { ...plan, sourceIdentity: "source:other" },
        resume: { [emitted[0]!.lane]: emitted[0]! },
      })
    ).rejects.toThrow("plan identity mismatch");
  });

  it("rejects a v2 resume checkpoint from a different plan before copying", async () => {
    const source = toAsync(new InMemoryKv());
    const destination = toAsync(new InMemoryKv());
    await source.put("items", { id: "a", value: "a" });
    let checkpoint: MigrationCheckpointV2 | undefined;
    await copyCollection(source, destination, "items", {
      plan,
      onCheckpoint(value) {
        if ("plan" in value) checkpoint = value;
      },
    });
    if (!checkpoint) throw new Error("expected v2 checkpoint");

    await expect(
      copyCollection(source, destination, "items", {
        plan: { ...plan, planDigest: "sha256:plan-b" },
        resume: { [checkpoint.lane]: checkpoint },
      })
    ).rejects.toThrow("plan identity mismatch");
  });

  it("resumes from an explicitly upgraded v1 checkpoint", async () => {
    const source = toAsync(new InMemoryKv());
    const destination = toAsync(new InMemoryKv());
    await source.put("items", { id: "a", value: "a" });
    await source.put("items", { id: "b", value: "b" });
    const checkpoint = upgradeCheckpointV1({
      checkpoint: { lane: "collection:items", processed: 1 },
      plan,
      convertedAt: 456,
    });

    expect(
      await copyCollection(source, destination, "items", {
        plan,
        resume: { [checkpoint.lane]: checkpoint },
      })
    ).toBe(2);
    expect(await destination.list("items", { sortBy: "id" })).toEqual([
      { id: "b", value: "b" },
    ]);
  });

  it("returns caller-owned post-copy verification results without treating a failed check as an exception", async () => {
    const wrapped = await runMigrationWithVerification(
      async () => 3,
      (result) => ({
        ok: false,
        checked: result,
        diagnostics: [
          {
            code: "missing",
            message: "one entry was not found",
            locator: "items:b",
          },
        ],
      })
    );
    expect(wrapped).toEqual({
      result: 3,
      verification: {
        ok: false,
        checked: 3,
        diagnostics: [
          {
            code: "missing",
            message: "one entry was not found",
            locator: "items:b",
          },
        ],
      },
    });
  });

  it("does not invoke verification after a failed copy and rejects malformed callbacks", async () => {
    let verified = false;
    await expect(
      runMigrationWithVerification(
        async () => {
          throw new Error("copy failed");
        },
        () => {
          verified = true;
          return { ok: true, checked: 0, diagnostics: [] };
        }
      )
    ).rejects.toThrow("copy failed");
    expect(verified).toBe(false);
    await expect(
      runMigrationWithVerification(1, null as never)
    ).rejects.toThrow("verify must be a function");
  });

  it("rejects duplicate collections before any migration and safely returns prototype-named lanes", async () => {
    const source = toAsync(new InMemoryKv());
    const destination = toAsync(new InMemoryKv());
    await expect(
      migrateStore(source, destination, ["items", "items"], {})
    ).rejects.toThrow("duplicate migration collection");
    const result = await migrateStore(source, destination, ["__proto__"]);
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(
      true
    );
    expect(result["__proto__"]).toBe(0);
  });

  it("copies a known collection and resumes from a checkpoint idempotently", async () => {
    const source = toAsync(new InMemoryKv());
    const destination = toAsync(new InMemoryKv());
    for (const id of ["a", "b", "c"])
      await source.put("items", { id, value: id });

    let last = 0;
    await expect(
      copyCollection(source, destination, "items", {
        batchSize: 1,
        onCheckpoint(value) {
          last = value.processed;
          if (last === 2) throw new Error("interrupted");
        },
      })
    ).rejects.toThrow("interrupted");

    await copyCollection(source, destination, "items", {
      resume: { "collection:items": last },
    });
    expect(await destination.list("items", { sortBy: "id" })).toEqual([
      { id: "a", value: "a" },
      { id: "b", value: "b" },
      { id: "c", value: "c" },
    ]);
  });

  it("copies caller-supplied vector and search manifests", async () => {
    const vector = toAsyncVector(new InMemoryVectorStore({ dimensions: 2 }));
    const search = toAsyncSearch(new InMemorySearchStore());

    await copyVectorManifest(
      manifest([
        {
          collection: "docs",
          document: { id: "v1", vector: Float32Array.from([1, 0]) },
        },
      ]),
      vector
    );
    await copySearchManifest(
      manifest([
        { collection: "docs", document: { id: "s1", text: "mirk surreal" } },
      ]),
      search
    );

    expect(await vector.has("docs", "v1")).toBe(true);
    expect((await search.search("docs", "surreal"))[0]?.id).toBe("s1");
  });

  it("copies object manifests without requiring source enumeration", async () => {
    const destination = new InMemoryObjectStore();
    await copyObjectManifest(
      manifest([
        {
          key: "images/a",
          bytes: new Uint8Array([1, 2, 3]),
          mediaType: "image/png",
        },
      ]),
      destination
    );
    expect(await destination.head("images/a")).toEqual({
      key: "images/a",
      sizeBytes: 3,
      mediaType: "image/png",
    });
  });

  it("rebuilds a representative export from store collections and deterministic manifests", async () => {
    const source = toAsync(new InMemoryKv());
    const destination = toAsync(new InMemoryKv());
    const vector = toAsyncVector(new InMemoryVectorStore({ dimensions: 3 }));
    const search = toAsyncSearch(new InMemorySearchStore());
    const objects = new InMemoryObjectStore();
    const checkpoints: Record<string, number> = {};

    for (const item of [
      { id: "doc:a", title: "Alpha", kind: "note", status: "published" },
      { id: "doc:b", title: "Beta", kind: "note", status: "draft" },
      { id: "doc:c", title: "Gamma", kind: "report", status: "published" },
    ])
      await source.put("documents", item);
    for (const item of [
      { id: "run:1", status: "complete", documentId: "doc:a" },
      { id: "run:2", status: "queued", documentId: "doc:c" },
    ])
      await source.put("runs", item);

    await expect(
      migrateStore(source, destination, ["documents", "runs"], {
        batchSize: 2,
        onCheckpoint(value) {
          checkpoints[value.lane] = value.processed;
          if (value.lane === "collection:documents" && value.processed === 2)
            throw new Error("interrupted collections");
        },
      })
    ).rejects.toThrow("interrupted collections");

    await migrateStore(source, destination, ["documents", "runs"], {
      batchSize: 2,
      resume: checkpoints,
      onCheckpoint(value) {
        checkpoints[value.lane] = value.processed;
      },
    });

    const vectorEntries = [
      {
        collection: "documents",
        document: {
          id: "doc:a",
          vector: Float32Array.from([1, 0, 0]),
          metadata: { kind: "note", status: "published" },
        },
      },
      {
        collection: "documents",
        document: {
          id: "doc:b",
          vector: Float32Array.from([0, 1, 0]),
          metadata: { kind: "note", status: "draft" },
        },
      },
      {
        collection: "documents",
        document: {
          id: "doc:c",
          vector: Float32Array.from([0.8, 0, 0.2]),
          metadata: { kind: "report", status: "published" },
        },
      },
    ];
    await expect(
      copyVectorManifest(manifest(vectorEntries), vector, {
        batchSize: 2,
        onCheckpoint(value) {
          checkpoints[value.lane] = value.processed;
          if (value.processed === 2) throw new Error("interrupted vector");
        },
      })
    ).rejects.toThrow("interrupted vector");
    await copyVectorManifest(manifest(vectorEntries), vector, {
      resume: checkpoints,
      onCheckpoint(value) {
        checkpoints[value.lane] = value.processed;
      },
    });

    const searchEntries = [
      {
        collection: "documents",
        document: {
          id: "doc:a",
          fields: { title: "Alpha gardens", body: "surreal storage migration" },
          meta: { kind: "note", status: "published" },
        },
      },
      {
        collection: "documents",
        document: {
          id: "doc:b",
          fields: { title: "Beta workshop", body: "draft export checkpoint" },
          meta: { kind: "note", status: "draft" },
        },
      },
      {
        collection: "documents",
        document: {
          id: "doc:c",
          fields: {
            title: "Gamma storage report",
            body: "surreal graph vector object migration",
          },
          meta: { kind: "report", status: "published" },
        },
      },
    ];
    await expect(
      copySearchManifest(manifest(searchEntries), search, {
        batchSize: 2,
        onCheckpoint(value) {
          checkpoints[value.lane] = value.processed;
          if (value.processed === 2) throw new Error("interrupted search");
        },
      })
    ).rejects.toThrow("interrupted search");
    await copySearchManifest(manifest(searchEntries), search, {
      resume: checkpoints,
      onCheckpoint(value) {
        checkpoints[value.lane] = value.processed;
      },
    });

    const graphEntries = [
      {
        collection: "document_edges",
        edge: {
          id: "edge:1",
          from: "doc:a",
          to: "run:1",
          type: "produced",
          weight: 1,
        },
      },
      {
        collection: "document_edges",
        edge: {
          id: "edge:2",
          from: "doc:c",
          to: "run:2",
          type: "scheduled",
          weight: 0.5,
        },
      },
      {
        collection: "document_edges",
        edge: {
          id: "edge:3",
          from: "doc:c",
          to: "doc:a",
          type: "references",
          weight: 0.25,
        },
      },
    ];
    await expect(
      copyGraphManifest(manifest(graphEntries), destination, {
        batchSize: 2,
        onCheckpoint(value) {
          checkpoints[value.lane] = value.processed;
          if (value.processed === 2) throw new Error("interrupted graph");
        },
      })
    ).rejects.toThrow("interrupted graph");
    await copyGraphManifest(manifest(graphEntries), destination, {
      resume: checkpoints,
      onCheckpoint(value) {
        checkpoints[value.lane] = value.processed;
      },
    });

    const objectEntries = [
      {
        key: "exports/doc-a.md",
        bytes: new TextEncoder().encode("# Alpha"),
        mediaType: "text/markdown",
        metadata: { id: "doc:a" },
      },
      {
        key: "exports/doc-c.json",
        bytes: new TextEncoder().encode('{"id":"doc:c"}'),
        mediaType: "application/json",
        metadata: { id: "doc:c" },
      },
      {
        key: "exports/thumbs/doc-a.bin",
        bytes: new Uint8Array([1, 2, 3, 4]),
        mediaType: "application/octet-stream",
        metadata: { id: "doc:a" },
      },
    ];
    await expect(
      copyObjectManifest(manifest(objectEntries), objects, {
        batchSize: 2,
        onCheckpoint(value) {
          checkpoints[value.lane] = value.processed;
          if (value.processed === 2) throw new Error("interrupted object");
        },
      })
    ).rejects.toThrow("interrupted object");
    await copyObjectManifest(manifest(objectEntries), objects, {
      resume: checkpoints,
      onCheckpoint(value) {
        checkpoints[value.lane] = value.processed;
      },
    });

    expect(await destination.count("documents")).toBe(3);
    expect(await destination.count("runs")).toBe(2);
    expect(await destination.getById("documents", "doc:c")).toEqual({
      id: "doc:c",
      title: "Gamma",
      kind: "report",
      status: "published",
    });
    expect(await vector.count("documents")).toBe(3);
    expect(
      (
        await vector.search("documents", Float32Array.from([1, 0, 0]), {
          where: { status: "published" },
          topK: 2,
        })
      ).map((result) => result.id)
    ).toEqual(["doc:a", "doc:c"]);
    expect(
      (
        await search.search("documents", "surreal migration", {
          filter: { where: { status: "published" } },
        })
      )
        .map((result) => result.id)
        .sort()
    ).toEqual(["doc:a", "doc:c"]);
    expect(await destination.list("document_edges", { sortBy: "id" })).toEqual([
      { id: "edge:1", from: "doc:a", to: "run:1", type: "produced", weight: 1 },
      {
        id: "edge:2",
        from: "doc:c",
        to: "run:2",
        type: "scheduled",
        weight: 0.5,
      },
      {
        id: "edge:3",
        from: "doc:c",
        to: "doc:a",
        type: "references",
        weight: 0.25,
      },
    ]);
    expect(await objects.head("exports/doc-c.json")).toMatchObject({
      key: "exports/doc-c.json",
      sizeBytes: 14,
      mediaType: "application/json",
      metadata: { id: "doc:c" },
    });
    expect(
      new TextDecoder().decode(
        await drain(await objects.get("exports/doc-a.md"))
      )
    ).toBe("# Alpha");
    expect(checkpoints).toMatchObject({
      "collection:documents": 3,
      "collection:runs": 2,
      vector: 3,
      search: 3,
      graph: 3,
      object: 3,
    });
  });
});
