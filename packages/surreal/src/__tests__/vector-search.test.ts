import { describe, expect, it } from "vitest";
import { createNodeEngines } from "@surrealdb/node";
import { Surreal, createRemoteEngines } from "surrealdb";
import { SurrealConnection } from "../index.js";
import { SurrealVectorAdapter } from "../vector.js";

const v = (...values: number[]): Float32Array => Float32Array.from(values);

describe("SurrealVectorAdapter on the embedded engine", () => {
  it("shares immutable named spaces across collections, replaces whole maps and isolates namespaces", async () => {
    const client = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
    const connection = await SurrealConnection.open({ client, endpoint: "mem://", namespace: "mirk", database: `vector_${Date.now()}` });
    try {
      const vectors = await SurrealVectorAdapter.open(connection);
      await vectors.ensureSpace("text", { dimensions: 2 });
      await vectors.ensureSpace("image", { dimensions: 3 });
      await vectors.ensureSpace("text", { dimensions: 2 });
      await expect(vectors.ensureSpace("text", { dimensions: 3 })).rejects.toMatchObject({ code: "space-definition-conflict" });
      expect((await vectors.listSpaces()).map((space) => [space.name, space.dimensions])).toEqual([["image", 3], ["text", 2]]);
      await vectors.upsertMany("docs", [
        { id: "a", vectors: { text: v(1, 0), image: v(0, 1, 0) }, metadata: { kind: "keep", archived: false } },
        { id: "b", vectors: { text: v(0.8, 0.2) }, metadata: { kind: "keep", archived: true } },
        { id: "c", vectors: { text: v(0, 1) }, metadata: { kind: "skip", archived: false } },
      ]);
      expect(await vectors.count("docs")).toBe(3);
      expect((await vectors.get("docs", "a"))!.vectors).toEqual({ text: v(1, 0), image: v(0, 1, 0) });
      expect((await vectors.search("docs", { space: "image", vector: v(0, 1, 0) })).map((hit) => hit.id)).toEqual(["a"]);
      expect((await vectors.search("docs", { space: "text", vector: v(1, 0) }, { whereNot: { kind: "keep", archived: true } })).map((hit) => hit.id)).toEqual(["a", "c"]);
      expect((await vectors.search("docs", { space: "text", vector: v(1, 0) }, { minScore: 1 })).map((hit) => hit.id)).toEqual(["a"]);
      await expect(vectors.upsertMany("docs", [{ id: "valid", vectors: { text: v(1, 0) } }, { id: "bad", vectors: { text: v(1) } }])).rejects.toMatchObject({ code: "dimension-mismatch" });
      expect(await vectors.count("docs")).toBe(3);
      await vectors.upsert("docs", { id: "a", vectors: { text: v(1, 0) } });
      expect(await vectors.search("docs", { space: "image", vector: v(0, 1, 0) })).toEqual([]);
      expect((await vectors.get("docs", "a"))!.metadata).toBeUndefined();
      const other = await SurrealVectorAdapter.open(connection, { namespace: "other" });
      expect(await other.listSpaces()).toEqual([]);
      expect(await other.count("docs")).toBe(0);
      await other.ensureSpace("text", { dimensions: 4 });
      expect(await vectors.remove("docs", "a")).toBe(true);
      expect(await vectors.remove("docs", "a")).toBe(false);
      expect(await vectors.count("docs")).toBe(2);
      await expect(vectors.search("docs", { space: "unknown", vector: v(1) })).rejects.toMatchObject({ code: "unknown-space" });
      await vectors.upsert("plain", { id: "none", vectors: { text: v(1, 0) } });
      expect((await vectors.search("plain", { space: "text", vector: v(1, 0) }, { whereNot: { archived: true } })).map((hit) => hit.id)).toEqual(["none"]);
      expect(await vectors.search("plain", { space: "text", vector: v(1, 0) }, { where: {} })).toEqual([]);
    } finally { await connection.close(); await client.close(); }
  });
  it("migrates a legacy collection without deleting document identity or metadata", async () => {
    const client = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
    const connection = await SurrealConnection.open({ client, endpoint: "mem://", namespace: "mirk", database: `legacy_${Date.now()}` });
    try {
      await connection.query(`DEFINE TABLE mirk_vector_dimensions SCHEMALESS;
        DEFINE TABLE mirk_vector_documents SCHEMALESS;
        CREATE mirk_vector_dimensions CONTENT {collection:'docs',dimensions:2};
        CREATE mirk_vector_documents CONTENT {collection:'docs',doc_id:'a',vector:[1,0],metadata:{kind:'legacy'}};`);
      const vectors = await SurrealVectorAdapter.open(connection);
      expect(await vectors.get("docs", "a")).toEqual({ id: "a", vectors: { default: v(1, 0) }, metadata: { kind: "legacy" } });
      expect(await (await SurrealVectorAdapter.open(connection)).count("docs")).toBe(1);
    } finally { await connection.close(); await client.close(); }
  });

});
