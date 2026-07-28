import { describe, expect, it } from "vitest";
import { Surreal, createRemoteEngines } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

import { SurrealConnection, type SurrealClientLike } from "../src/index.js";

function createEmbeddedClient(): Surreal {
  return new Surreal({
    engines: {
      ...createRemoteEngines(),
      ...createNodeEngines(),
    },
  });
}

describe("SurrealConnection", () => {
  it("opens an injected client and does not close caller-owned clients", async () => {
    const client = createEmbeddedClient();
    const connection = await SurrealConnection.open({
      client,
      endpoint: "mem://",
      namespace: "mirk",
      database: "connection",
    });

    await connection.query("CREATE thing CONTENT { value: 1 }");
    await connection.close();

    const rows = await client.query("SELECT VALUE value FROM thing");
    expect(rows).toEqual([[1]]);
    await client.close();
  });

  it("does not close an injected client even when closed repeatedly", async () => {
    let closeCount = 0;
    const client: SurrealClientLike = {
      async connect() {},
      async close() {
        closeCount += 1;
      },
      async query<T>() {
        return [] as T;
      },
    };

    const connection = await SurrealConnection.open({ client });
    await connection.close();
    await connection.close();

    expect(closeCount).toBe(0);
  });

  it("rejects queries after close", async () => {
    const client = createEmbeddedClient();
    const connection = await SurrealConnection.open({
      client,
      endpoint: "mem://",
      namespace: "mirk",
      database: "closed",
    });

    await connection.close();
    await expect(connection.query("SELECT 1")).rejects.toThrow("closed");
    await client.close();
  });
});
