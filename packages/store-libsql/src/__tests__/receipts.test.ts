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

it("stamps a receipt with the database clock when no clock is injected", async () => {
  const adapter = await LibsqlAdapter.open({ url: `file:${path}` });
  const client = createClient({ url: `file:${path}` });
  try {
    const before = Date.now();
    await adapter.kv.mutateAtomically(request);
    const after = Date.now();
    const rs = await client.execute("SELECT created_at FROM _mirk_atomic_receipts WHERE idempotency_key = 'once'");
    const createdAt = Number(rs.rows[0]!.created_at);
    expect(createdAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(createdAt).toBeLessThanOrEqual(after + 1_000);
  } finally {
    client.close();
    adapter.close();
  }
});

it("gives a receipt without a creation time one full window from when expiry first sees it", async () => {
  const sqlite = new NodeSqliteAdapter({ path, versionIdentity: "shared" });
  expect(sqlite.kv.mutateAtomically(request).status).toBe("applied");
  sqlite.close();
  const client = createClient({ url: `file:${path}` });
  await client.execute("UPDATE _mirk_atomic_receipts SET created_at = NULL");

  let now = 5_000;
  const adapter = await LibsqlAdapter.open({ url: `file:${path}`, receiptRetentionMs: 100, now: () => now });
  try {
    expect(await adapter.kv.mutateAtomically(request)).toMatchObject({ status: "replayed" });
    const rs = await client.execute("SELECT created_at FROM _mirk_atomic_receipts WHERE idempotency_key = 'once'");
    expect(Number(rs.rows[0]!.created_at)).toBe(5_000);
    now += 100;
    expect(await adapter.kv.pruneExpiredReceipts()).toBe(0);
    now += 1;
    expect(await adapter.kv.pruneExpiredReceipts()).toBe(1);
  } finally {
    client.close();
    adapter.close();
  }
});

it("rejects a retention window that is not a positive integer", async () => {
  await expect(LibsqlAdapter.open({ url: `file:${path}`, receiptRetentionMs: 0 })).rejects.toThrow(
    "receiptRetentionMs must be a positive safe integer",
  );
});
