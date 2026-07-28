import { describe, expect, it } from "vitest";

import { createNodeSurrealConnection } from "./node.js";
import { SurrealStoreAdapter } from "./store.js";

describe("createNodeSurrealConnection", () => {
  it("owns an embedded client shared by separately opened adapters", async () => {
    const connection = await createNodeSurrealConnection({
      endpoint: "mem://",
      namespace: "mirk",
      database: `node_${Date.now()}`,
    });
    const first = await SurrealStoreAdapter.open(connection);
    const second = await SurrealStoreAdapter.open(connection);
    await first.set("shared", { ok: true });
    expect(await second.get("shared")).toEqual({ ok: true });
    await connection.close();
    await expect(connection.query("RETURN true")).rejects.toThrow("closed");
  });
});
