import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { NodeSqliteAdapter } from "@mirk/store/node-sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";

import { LibsqlAdapter } from "../libsql-adapter.js";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "mirk-libsql-receipts-"));
  path = join(directory, "store.db");
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

const request = {
  operations: [{ op: "set" as const, key: "k", value: 1 }],
  idempotency: { key: "once", outcome: { saved: true } },
};

it("stamps an idempotency receipt with the injected clock", async () => {
  const adapter = await LibsqlAdapter.open({ url: `file:${path}`, now: () => 1_234 });
  const client = createClient({ url: `file:${path}` });
  try {
    expect((await adapter.kv.mutateAtomically(request)).status).toBe("applied");
    const rs = await client.execute("SELECT created_at FROM _mirk_atomic_receipts WHERE idempotency_key = 'once'");
    expect(Number(rs.rows[0]!.created_at)).toBe(1_234);
  } finally {
    client.close();
    adapter.close();
  }
});

it("replays a receipt the SQLite adapter wrote without a creation time", async () => {
  const sqlite = new NodeSqliteAdapter({ path, versionIdentity: "shared" });
  expect(sqlite.kv.mutateAtomically(request).status).toBe("applied");
  const written = sqlite.kv.getVersioned({ kind: "key", key: "k" });
  sqlite.close();

  const adapter = await LibsqlAdapter.open({ url: `file:${path}` });
  try {
    expect(await adapter.kv.mutateAtomically(request)).toMatchObject({ status: "replayed", outcome: { saved: true } });
    expect(await adapter.kv.getVersioned({ kind: "key", key: "k" })).toEqual(written);
    await adapter.kv.set("k", 2);
    expect((await adapter.kv.getVersioned({ kind: "key", key: "k" }))?.version).toBe("shared-v2");
  } finally {
    adapter.close();
  }
});
