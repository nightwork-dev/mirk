import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres-adapter.js";

const connectionString = process.env.MIRK_POSTGRES_TEST_URL;
const describePostgres = connectionString ? describe : describe.skip;

const request = {
  operations: [{ op: "set" as const, key: "k", value: 1 }],
  idempotency: { key: "once", outcome: { saved: true } },
};

describePostgres("PostgreSQL idempotency receipts", () => {
  let pool: Pool;
  const schemas: string[] = [];
  const freshSchema = () => {
    const schema = `mirk_receipts_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    return schema;
  };

  beforeAll(() => {
    pool = new Pool({ connectionString, max: 4 });
  });
  afterAll(async () => {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("stamps a receipt with the database clock when no clock is injected", async () => {
    const schema = freshSchema();
    const adapter = await PostgresAdapter.open({ pool, schema });
    try {
      await adapter.kv.mutateAtomically(request);
      const { rows } = await pool.query<{ created_at: string; db_now: string }>(
        `SELECT created_at, (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS db_now
         FROM "${schema}".atomic_receipts WHERE key = 'once'`,
      );
      const age = Number(rows[0]!.db_now) - Number(rows[0]!.created_at);
      expect(age).toBeGreaterThanOrEqual(0);
      expect(age).toBeLessThan(60_000);
    } finally {
      await adapter.close();
    }
  });

  it("adds the creation column to an earlier release's table and gives its receipts one full window", async () => {
    const schema = freshSchema();
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(
      `CREATE TABLE "${schema}".atomic_receipts (key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result JSONB NOT NULL)`,
    );
    const first = await PostgresAdapter.open({ pool, schema });
    expect((await first.kv.mutateAtomically(request)).status).toBe("applied");
    await first.close();
    await pool.query(`UPDATE "${schema}".atomic_receipts SET created_at = NULL`);

    let now = 5_000;
    const adapter = await PostgresAdapter.open({ pool, schema, receiptRetentionMs: 100, now: () => now });
    try {
      expect(await adapter.kv.mutateAtomically(request)).toMatchObject({ status: "replayed" });
      const { rows } = await pool.query<{ created_at: string }>(
        `SELECT created_at FROM "${schema}".atomic_receipts WHERE key = 'once'`,
      );
      expect(Number(rows[0]!.created_at)).toBe(5_000);
      now += 100;
      expect(await adapter.kv.pruneExpiredReceipts()).toBe(0);
      now += 1;
      expect(await adapter.kv.pruneExpiredReceipts()).toBe(1);
    } finally {
      await adapter.close();
    }
  });

  it("prunes a backlog larger than one batch in several short transactions", async () => {
    const schema = freshSchema();
    let now = 1_000;
    const adapter = await PostgresAdapter.open({ pool, schema, receiptRetentionMs: 10, now: () => now });
    try {
      for (let index = 0; index < 250; index += 1) {
        await adapter.kv.mutateAtomically({
          operations: [{ op: "set", key: `k${index}`, value: index }],
          idempotency: { key: `r${index}` },
        });
      }
      now += 11;
      expect(await adapter.kv.pruneExpiredReceipts()).toBe(250);
      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM "${schema}".atomic_receipts`,
      );
      expect(Number(rows[0]!.count)).toBe(0);
    } finally {
      await adapter.close();
    }
  });
});
