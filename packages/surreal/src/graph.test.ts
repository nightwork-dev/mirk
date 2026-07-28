import { describe, expect, it } from "vitest";
import { createNodeEngines } from "@surrealdb/node";
import { Surreal, createRemoteEngines } from "surrealdb";

import { SurrealGraphAdapter, type SurrealQueryConnection } from "./graph.js";
import { SurrealConnection } from "./index.js";

class RecordingConnection implements SurrealQueryConnection {
  readonly calls: Array<{ sql: string; bindings: Record<string, unknown> | undefined }> = [];
  responses: unknown[] = [];

  async query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T> {
    if (sql.startsWith("DEFINE TABLE")) return [] as T;
    this.calls.push({ sql, bindings });
    return (this.responses.shift() ?? []) as T;
  }
}

const graphOptions = {
  graphs: {
    links: {
      nodeTable: "mirk_graph_node",
      relationTable: "mirk_graph_relation",
    },
  },
};

describe("SurrealGraphAdapter", () => {
  it("executes relation CRUD and bounded traversal in embedded SurrealDB", async () => {
    const client = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
    const connection = await SurrealConnection.open({
      client,
      endpoint: "mem://",
      namespace: "mirk",
      database: `graph_${Date.now()}`,
    });
    try {
      const adapter = await SurrealGraphAdapter.open(connection, graphOptions);
      await adapter.edges.put("links", { id: "e1", from: "a", to: "b", type: "mentions", rank: 1 });
      await adapter.edges.put("links", { id: "e2", from: "b", to: "c", type: "mentions", rank: 2 });
      await expect(adapter.edges.list("links")).resolves.toEqual([
        { id: "e1", from: "a", to: "b", type: "mentions", rank: 1 },
        { id: "e2", from: "b", to: "c", type: "mentions", rank: 2 },
      ]);
      await expect(adapter.edges.traverseGraph("links", {
        start: "a",
        depth: 2,
        direction: "out",
        edgeTypes: ["mentions"],
      })).resolves.toEqual({
        nodes: ["b", "c"],
        edges: [
          { id: "e1", from: "a", to: "b", type: "mentions", rank: 1 },
          { id: "e2", from: "b", to: "c", type: "mentions", rank: 2 },
        ],
      });
    } finally {
      await connection.close();
      await client.close();
    }
  });
  it("gates native traversal to explicitly configured graph collections", async () => {
    const adapter = await SurrealGraphAdapter.open(new RecordingConnection(), graphOptions);

    expect(adapter.edges.canTraverseGraph("links")).toBe(true);
    expect(adapter.edges.canTraverseGraph("plain_edges")).toBe(false);
  });

  it("round-trips flat Mirk edge records through relation rows", async () => {
    const connection = new RecordingConnection();
    connection.responses.push([
      [
        {
          id: "mirk_graph_relation:stored",
          edge_id: "e2",
          in: "mirk_graph_node:b",
          out: "mirk_graph_node:c",
          type: "mentions",
          weight: 2,
        },
      ],
    ]);
    connection.responses.push([
      [
        {
          id: "mirk_graph_relation:stored",
          edge_id: "e2",
          in: "mirk_graph_node:b",
          out: "mirk_graph_node:c",
          type: "mentions",
          weight: 2,
        },
      ],
    ]);
    const adapter = await SurrealGraphAdapter.open(connection, graphOptions);

    await expect(
      adapter.edges.put("links", { id: "e2", from: "b", to: "c", type: "mentions", weight: 2 }),
    ).resolves.toEqual({ id: "e2", from: "b", to: "c", type: "mentions", weight: 2 });

    await expect(adapter.edges.getById("links", "e2")).resolves.toEqual({
      id: "e2",
      from: "b",
      to: "c",
      type: "mentions",
      weight: 2,
    });
    expect(connection.calls[0]?.sql).toContain("RELATE $fromRecord");
    expect(connection.calls[0]?.sql).toContain("mirk_graph_relation");
    expect(connection.calls[0]?.bindings).toMatchObject({
      nodeTable: "mirk_graph_node",
      fromId: "b",
      toId: "c",
      edgeId: "e2",
    });
  });

  it("maps relation endpoint listWhereIn queries without shape sniffing generic collections", async () => {
    const connection = new RecordingConnection();
    connection.responses.push([
      [
        {
          edge_id: "e1",
          in: "mirk_graph_node:a",
          out: "mirk_graph_node:b",
          type: "likes",
          published: true,
        },
      ],
    ]);
    connection.responses.push([[{ id: "flat", from: "looks-like-edge", to: "but-is-generic" }]]);
    const adapter = await SurrealGraphAdapter.open(connection, graphOptions);

    await expect(
      adapter.edges.listWhereIn("links", "from", ["a", "c"], { where: { published: true, from: "ignored" } }),
    ).resolves.toEqual([{ id: "e1", from: "a", to: "b", type: "likes", published: true }]);

    await adapter.edges.listWhereIn("unconfigured", "from", ["looks-like-edge"]);

    expect(connection.calls[0]?.sql).toContain("in IN $endpointIds");
    expect(connection.calls[0]?.sql).not.toContain("from =");
    expect(connection.calls[0]?.bindings).toMatchObject({
      endpointIds: ["mirk_graph_node:a", "mirk_graph_node:c"],
      where_published: true,
    });
    expect(connection.calls[1]?.sql).toContain("FROM unconfigured");
    expect(connection.calls[1]?.sql).toContain("from IN $values");
  });

  it("uses one bounded recursive query for native traversal and returns deterministic full-edge parity", async () => {
    const connection = new RecordingConnection();
    connection.responses.push([
      {
        result: [
          {
            nodes: ["mirk_graph_node:c", "mirk_graph_node:b", "mirk_graph_node:b"],
            edges: [
              {
                edge_id: "e2",
                in: "mirk_graph_node:b",
                out: "mirk_graph_node:c",
                type: "mentions",
                rank: 2,
              },
              {
                edge_id: "e1",
                in: "mirk_graph_node:a",
                out: "mirk_graph_node:b",
                type: "mentions",
                rank: 1,
              },
              {
                edge_id: "e1",
                in: "mirk_graph_node:a",
                out: "mirk_graph_node:b",
                type: "mentions",
                rank: 1,
              },
            ],
          },
        ],
      },
    ]);
    const adapter = await SurrealGraphAdapter.open(connection, graphOptions);

    const result = await adapter.edges.traverseGraph("links", {
      start: "a",
      depth: 2,
      direction: "out",
      edgeTypes: ["mentions"],
      edgeFilter: { where: { rank: 1 } },
    });

    expect(result).toEqual({
      nodes: ["b", "c"],
      edges: [
        { id: "e1", from: "a", to: "b", type: "mentions", rank: 1 },
        { id: "e2", from: "b", to: "c", type: "mentions", rank: 2 },
      ],
    });
    expect(connection.calls).toHaveLength(1);
    expect(connection.calls[0]?.sql).toContain("{..2+collect}");
    expect(connection.calls[0]?.sql).toContain("->mirk_graph_relation->(?)");
    expect(connection.calls[0]?.sql).toContain("type IN $edgeTypes");
    expect(connection.calls[0]?.sql).toContain("rank = $where_rank");
  });

  it("does not issue a traversal query for depth zero", async () => {
    const connection = new RecordingConnection();
    const adapter = await SurrealGraphAdapter.open(connection, graphOptions);

    await expect(adapter.edges.traverseGraph("links", { start: "a", depth: 0 })).resolves.toEqual({
      nodes: [],
      edges: [],
    });
    expect(connection.calls).toEqual([]);
  });
});
