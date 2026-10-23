import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asyncTransactionContract } from "../../store/src/conformance/transaction-contract.js";
import { PostgresAdapter } from "./postgres-adapter.js";

const connectionString = process.env.MIRK_POSTGRES_TEST_URL;
const describePostgres = connectionString ? describe : describe.skip;

function freshSchema(label: string): string {
  return `mirk_${label}_${randomUUID().replaceAll("-", "")}`;
}

async function dropSchema(schema: string): Promise<void> {
  const pool = new Pool({ connectionString });
  try {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await pool.end();
  }
}

if (connectionString) {
  asyncTransactionContract("PostgreSQL (two adapters, two pools, one schema)", {
    async open() {
      const schema = freshSchema("contract");
      const first = await PostgresAdapter.open({ connectionString, schema });
      const second = await PostgresAdapter.open({ connectionString, schema });
      return {
        first,
        second,
        async close() {
          await first.close();
          await second.close();
          await dropSchema(schema);
        },
      };
    },
  });
}

describePostgres("PostgresAdapter atomic writes across hosts", () => {
  const schema = freshSchema("atomic");
  let a: PostgresAdapter;
  let b: PostgresAdapter;

  beforeAll(async () => {
    a = await PostgresAdapter.open({ connectionString, schema });
    b = await PostgresAdapter.open({ connectionString, schema });
  });
  afterAll(async () => {
    await a?.close();
    await b?.close();
    await dropSchema(schema);
  });

  it("admits exactly one missing-target writer and changes tokens on ordinary writes", async () => {
    const request = {
      conditions: [{ target: { kind: "key" as const, key: "race" }, expected: "missing" as const }],
      operations: [{ op: "set" as const, key: "race", value: 1 }],
    };
    const results = await Promise.all([a.kv.mutateAtomically(request), b.kv.mutateAtomically(request)]);
    expect(results.map((result) => result.status).sort()).toEqual(["applied", "conflict"]);
    const before = await a.kv.getVersioned({ kind: "key", key: "race" });
    await b.kv.set("race", 1);
    expect((await a.kv.getVersioned({ kind: "key", key: "race" }))?.version).not.toBe(before?.version);
    const stale = await a.kv.mutateAtomically({
      conditions: [{ target: { kind: "key", key: "race" }, expected: "version", version: before!.version }],
      operations: [{ op: "set", key: "race", value: 2 }],
    });
    expect(stale.status).toBe("conflict");
  });

  it("replays idempotent receipts across adapters and reopen, and rejects changed requests", async () => {
    const request = {
      operations: [{ op: "put" as const, collection: "jobs", item: { id: "x", value: 1 } }],
      idempotency: { key: "receipt", outcome: { saved: true } },
    };
    const first = await a.kv.mutateAtomically(request);
    await b.kv.put("jobs", { id: "x", value: 99 });
    expect(await b.kv.mutateAtomically(request)).toEqual({ ...first, status: "replayed" });
    const reopened = await PostgresAdapter.open({ connectionString, schema });
    try {
      expect(await reopened.kv.mutateAtomically(request)).toEqual({ ...first, status: "replayed" });
    } finally {
      await reopened.close();
    }
    expect(await b.kv.getById("jobs", "x")).toEqual({ id: "x", value: 99 });
    expect(
      (await b.kv.mutateAtomically({ ...request, operations: [{ op: "delete", key: "race" }] })).status,
    ).toBe("idempotency-conflict");
  });

  it("keeps parallel writes started inside one transaction in that transaction", async () => {
    await expect(
      a.transaction(async () => {
        await Promise.all([1, 2, 3].map((n) => a.kv.set(`parallel${n}`, n)));
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await b.kv.keys("parallel")).toEqual([]);
    await a.transaction(async () => {
      await Promise.all([1, 2, 3].map((n) => a.kv.set(`parallel${n}`, n)));
    });
    expect(await b.kv.keys("parallel")).toEqual(["parallel1", "parallel2", "parallel3"]);
  });

  it("keeps the outer transaction usable after a statement fails inside it", async () => {
    await a.transaction(async () => {
      await a.kv.set("before-failure", 1);
      await expect(a.kv.set("bad", Number.NaN)).rejects.toThrow("JSON-serializable");
      await expect(
        a.kv.mutateAtomically({ operations: [{ op: "put", collection: "", item: { id: "x" } }] }),
      ).rejects.toThrow();
      await a.kv.set("after-failure", 2);
    });
    expect(await b.kv.get("after-failure")).toBe(2);
  });

  it("releases the schema lock held by a stalled transaction", async () => {
    const stalled = await PostgresAdapter.open({ connectionString, schema, transactionIdleTimeoutMs: 200 });
    try {
      const entered = new Promise<void>((resolve) => {
        void stalled
          .transaction(async () => {
            await stalled.kv.set("stalled", 1);
            resolve();
            await new Promise((done) => setTimeout(done, 1500));
            await stalled.kv.set("stalled", 2);
          })
          .catch(() => undefined);
      });
      await entered;
      const started = Date.now();
      await b.kv.set("after-stall", true);
      expect(Date.now() - started).toBeLessThan(1200);
      expect(await b.kv.get("stalled")).toBeNull();
    } finally {
      await stalled.close();
    }
  });

  it("gives a version to a row written without one", async () => {
    const pool = new Pool({ connectionString });
    try {
      await pool.query(`INSERT INTO "${schema}".kv (key, value) VALUES ('unversioned', '1')`);
      await pool.query(`INSERT INTO "${schema}".records (collection, id, data) VALUES ('c', 'unversioned', '{"id":"unversioned"}')`);
    } finally {
      await pool.end();
    }
    const key = await a.kv.getVersioned({ kind: "key", key: "unversioned" });
    expect(key?.version).toMatch(/-v\d+$/);
    expect((await b.kv.getVersioned({ kind: "key", key: "unversioned" }))?.version).toBe(key?.version);
    const record = await a.kv.getVersioned({ kind: "record", collection: "c", id: "unversioned" });
    expect(record?.value).toEqual({ id: "unversioned" });
    expect(record?.version).toMatch(/-v\d+$/);
  });

  it("rejects an invalid idle timeout", async () => {
    await expect(PostgresAdapter.open({ connectionString, schema, transactionIdleTimeoutMs: -1 })).rejects.toMatchObject({
      code: "invalid-timeout",
    });
  });

  it("refuses new transactions after close", async () => {
    const closed = await PostgresAdapter.open({ connectionString, schema });
    await closed.close();
    await expect(closed.transaction(() => undefined)).rejects.toMatchObject({ code: "adapter-closed" });
  });
});

describePostgres("PostgresAdapter schema upgrades", () => {
  it("adds version tokens to rows written before them and keeps hand-patched UUID columns working", async () => {
    const schema = freshSchema("upgrade");
    const pool = new Pool({ connectionString });
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".kv (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await pool.query(`CREATE TABLE "${schema}".records (collection TEXT NOT NULL, id TEXT NOT NULL, data JSONB NOT NULL, ordinal BIGINT GENERATED ALWAYS AS IDENTITY, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (collection, id))`);
      await pool.query(`INSERT INTO "${schema}".kv (key, value) VALUES ('old', '1')`);
      await pool.query(`ALTER TABLE "${schema}".records ADD COLUMN version UUID NOT NULL DEFAULT gen_random_uuid()`);
      await pool.query(`INSERT INTO "${schema}".records (collection, id, data) VALUES ('c', 'r', '{"id":"r"}')`);

      const adapter = await PostgresAdapter.open({ pool, schema });
      const old = await adapter.kv.getVersioned({ kind: "key", key: "old" });
      expect(old?.value).toBe(1);
      const record = await adapter.kv.getVersioned({ kind: "record", collection: "c", id: "r" });
      expect(record?.value).toEqual({ id: "r" });
      const applied = await adapter.kv.mutateAtomically({
        conditions: [{ target: { kind: "key", key: "old" }, expected: "version", version: old!.version }],
        operations: [{ op: "put", collection: "c", item: { id: "r", updated: true } }],
      });
      expect(applied.status).toBe("applied");
      expect(await adapter.kv.getById("c", "r")).toEqual({ id: "r", updated: true });
      await adapter.close();
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
