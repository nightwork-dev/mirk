import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";

import { LibsqlAdapter } from "../remote.js";

describe("@mirk/store-libsql/remote", () => {
  it.each(["file:./local.db", ":memory:", "sqlite://local.db", "not-a-url", "ftp://db.example"]) (
    "rejects local URL %s before creating a client",
    async (url) => {
      await expect(LibsqlAdapter.open({ url })).rejects.toThrow(
        /only accepts remote libSQL URLs .*wss:\/\/.*ws:\/\//,
      );
    },
  );

  it("rejects a local URL without closing a caller-supplied client", async () => {
    const client = createClient({ url: ":memory:" });
    await expect(LibsqlAdapter.open({ url: "file:./local.db", client })).rejects.toThrow(
      /only accepts remote libSQL URLs/,
    );
    await expect(client.execute("SELECT 1 AS ok")).resolves.toMatchObject({
      rows: [{ ok: 1 }],
    });
    client.close();
  });

  it("normalizes the remote protocol before applying the URL policy", async () => {
    const client = createClient({ url: ":memory:" });
    const adapter = await LibsqlAdapter.open({ url: "LIBSQL://example.invalid", client });
    await adapter.kv.set("policy", "ok");
    expect(await client.execute("SELECT 1 AS ok")).toMatchObject({ rows: [{ ok: 1 }] });
    adapter.close();
    client.close();
  });
});

