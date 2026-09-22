import { describe, expect, it } from "vitest";
import { createNodeEngines } from "@surrealdb/node";
import { Surreal, createRemoteEngines } from "surrealdb";

import { SurrealConnection as SharedSurrealConnection } from "../index.js";
import { SurrealSearchAdapter, SurrealUnsupportedError } from "../search.js";
import { SurrealVectorAdapter, SurrealVectorError, type SurrealConnection } from "../vector.js";

function v(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

class RecordingConnection implements SurrealConnection {
  readonly calls: { surql: string; bindings?: Record<string, unknown> }[] = [];
  dimensions = new Map<string, number>();
  rows: unknown[] = [];

  async query<T>(surql: string, bindings?: Record<string, unknown>): Promise<T> {
    this.calls.push({ surql, bindings });
    if (surql.includes("FROM mirk_vector_dimensions") && surql.includes("LIMIT 1")) {
      const dimensions = this.dimensions.get(String(bindings?.collection));
      return (dimensions ? [{ collection: bindings?.collection, dimensions }] : []) as T;
    }
    if (surql.includes("CREATE mirk_vector_dimensions")) {
      this.dimensions.set(String(bindings?.collection), Number(bindings?.dimensions));
      return [] as T;
    }
    if (surql.includes("vector::similarity::cosine")) return this.rows as T;
    return [] as T;
  }
}

describe("SurrealVectorAdapter", () => {
  it("executes cosine ranking and metadata filters in embedded SurrealDB", async () => {
    const client = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
    const connection = await SharedSurrealConnection.open({
      client,
      endpoint: "mem://",
      namespace: "mirk",
      database: `vector_${Date.now()}`,
    });
    try {
      const vectors = await SurrealVectorAdapter.open(connection);
      await vectors.upsertMany("docs", [
        { id: "a", vector: new Float32Array([1, 0]), metadata: { kind: "keep" } },
        { id: "b", vector: new Float32Array([0.8, 0.2]), metadata: { kind: "keep" } },
        { id: "c", vector: new Float32Array([0, 1]), metadata: { kind: "skip" } },
      ]);
      expect(await vectors.count("docs")).toBe(3);
      expect(await vectors.get("docs", "a")).toEqual({
        id: "a",
        vector: new Float32Array([1, 0]),
        metadata: { kind: "keep" },
      });

      await expect(vectors.search("docs", new Float32Array([1, 0]), {
        topK: 2,
        where: { kind: "keep" },
      })).resolves.toEqual([
        { id: "a", score: 1, metadata: { kind: "keep" } },
        expect.objectContaining({ id: "b", metadata: { kind: "keep" } }),
      ]);
    } finally {
      await connection.close();
      await client.close();
    }
  });
  it("scores vectors in SurrealQL after metadata filters", async () => {
    const connection = new RecordingConnection();
    connection.dimensions.set("docs", 4);
    connection.rows = [{ doc_id: "a", score: 1, metadata: { type: "document" } }];
    const adapter = await SurrealVectorAdapter.open(connection, { dimensions: 4 });

    const rows = await adapter.search<{ type: string }>("docs", v(1, 0, 0, 0), {
      topK: 2,
      where: { type: "document" },
      whereNot: { archived: true },
    });

    expect(rows.map((row) => row.id)).toEqual(["a"]);
    const searchCall = connection.calls.find((call) => call.surql.includes("vector::similarity::cosine"));
    expect(searchCall?.surql).toContain("metadata[$where_0_key] = $where_0_value");
    expect(searchCall?.surql).toContain("metadata[$where_not_1_key] != $where_not_1_value");
    expect(searchCall?.surql).toContain("ORDER BY score DESC, doc_id ASC");
  });

  it("persists inferred dimensions before the first write", async () => {
    const connection = new RecordingConnection();
    const adapter = await SurrealVectorAdapter.open(connection);

    await adapter.upsert("docs", { id: "a", vector: v(1, 0, 0) });

    expect(connection.dimensions.get("docs")).toBe(3);
    expect(adapter.meta.dimensions).toBe(3);
  });
});

describe("SurrealVectorError", () => {
  async function caught(promise: Promise<unknown>): Promise<SurrealVectorError> {
    const error = await promise.then(() => undefined, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SurrealVectorError);
    return error as SurrealVectorError;
  }

  it("codes invalid open options, search input and vectors", async () => {
    expect((await caught(SurrealVectorAdapter.open(new RecordingConnection(), { dimensions: -1 }))).code).toBe("invalid-dimensions");
    expect((await caught(SurrealVectorAdapter.open(new RecordingConnection(), { documentsTable: "bad-name" }))).code).toBe("invalid-identifier");

    const adapter = await SurrealVectorAdapter.open(new RecordingConnection());
    expect((await caught(adapter.search("empty", v(1, 0)))).code).toBe("dimensions-unknown");
    expect((await caught(adapter.upsert("docs", { id: "z", vector: v(0, 0) }))).code).toBe("invalid-vector");
    await adapter.upsert("docs", { id: "a", vector: v(1, 0) });
    expect((await caught(adapter.search("docs", v(1, 0), { topK: -1 }))).code).toBe("invalid-top-k");
  });

  it("codes a collection reopened at different dimensions", async () => {
    const connection = new RecordingConnection();
    connection.dimensions.set("docs", 3);
    const adapter = await SurrealVectorAdapter.open(connection, { dimensions: 4 });
    expect((await caught(adapter.search("docs", v(1, 0, 0, 0)))).code).toBe("dimensions-changed");
  });

  it("keeps name on the prototype, like built-in errors", async () => {
    const error = await caught(SurrealVectorAdapter.open(new RecordingConnection(), { dimensions: 1.5 }));
    expect(error.name).toBe("SurrealVectorError");
    expect(Object.keys(error)).not.toContain("name");
    expect(error.message).toBe("Vector dimensions must be a non-negative integer; got 1.5.");
  });
});

describe("SurrealSearchAdapter", () => {
  it("fails closed until the weighted search contract is proven", async () => {
    const adapter = await SurrealSearchAdapter.open(new RecordingConnection());

    const rejection = expect(adapter.search("docs", "opal")).rejects;
    await rejection.toThrow(SurrealUnsupportedError);
    await rejection.toMatchObject({ code: "unsupported-capability", name: "SurrealUnsupportedError" });
    const error = await adapter.search("docs", "opal").catch((reason: unknown) => reason);
    expect(Object.keys(error as object)).not.toContain("name");
  });
});
