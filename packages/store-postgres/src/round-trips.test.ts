// Every query is a network round trip. An atomic mutation must cost the same
// small number of them however many operations and conditions it carries.

import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { AtomicMutationRequest, StoreVersion } from "@mirk/store";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresAdapter } from "./postgres-adapter.js";

const connectionString = process.env.MIRK_POSTGRES_TEST_URL;
const describePostgres = connectionString ? describe : describe.skip;

const SIZES = [1, 10, 100];
const MAX_QUERIES = 10;

/** A pool that counts every query its clients send. */
function countingPool(): { pool: Pool; queries: () => number } {
  const pool = new Pool({ connectionString });
  let queries = 0;
  const counted = new WeakSet<PoolClient>();
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  (pool as unknown as { connect: () => Promise<PoolClient> }).connect = async () => {
    const client = await connect();
    if (!counted.has(client)) {
      counted.add(client);
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
        queries += 1;
        return query(...args);
      };
    }
    return client;
  };
  return { pool, queries: () => queries };
}

describePostgres("PostgreSQL atomic mutation round trips", () => {
  const schemas: string[] = [];

  afterAll(async () => {
    const pool = new Pool({ connectionString });
    try {
      for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });

  async function cost(
    request: (n: number) => AtomicMutationRequest,
    prepare?: (adapter: PostgresAdapter, n: number) => Promise<void>,
  ): Promise<number[]> {
    const schema = `mirk_rt_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    const counts: number[] = [];
    for (const n of SIZES) {
      const { pool, queries } = countingPool();
      const adapter = await PostgresAdapter.open({ pool, schema });
      try {
        await prepare?.(adapter, n);
        const before = queries();
        const result = await adapter.kv.mutateAtomically(request(n));
        counts.push(queries() - before);
        expect(result.status).toBe("applied");
      } finally {
        await adapter.close();
        await pool.end();
      }
    }
    return counts;
  }

  const puts = (collection: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ op: "put" as const, collection, item: { id: `r${i}`, i } }));

  it("puts cost the same at every size", async () => {
    const counts = await cost((n) => ({ operations: puts(`c${n}`, n) }));
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_QUERIES);
    expect(counts).toEqual(counts.map(() => counts[0]));
  });

  it("conditions on every target and an idempotency key cost the same at every size", async () => {
    const versions = new Map<number, StoreVersion[]>();
    const counts = await cost(
      (n) => ({
        conditions: versions.get(n)!.map((version, i) => ({
          target: { kind: "record" as const, collection: `v${n}`, id: `r${i}` },
          expected: "version" as const,
          version,
        })),
        operations: [...puts(`v${n}`, n), { op: "delete" as const, key: `k${n}` }],
        idempotency: { key: randomUUID() },
      }),
      async (adapter, n) => {
        const seeded = await adapter.kv.mutateAtomically({ operations: puts(`v${n}`, n) });
        if (seeded.status !== "applied") throw new Error("seed failed");
        versions.set(n, seeded.versions.map((v) => v.version!));
      },
    );
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_QUERIES);
    expect(counts).toEqual(counts.map(() => counts[0]));
  });
});
