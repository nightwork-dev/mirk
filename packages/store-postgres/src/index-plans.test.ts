import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAdapter } from "./postgres-adapter.js";

const connectionString = process.env.MIRK_POSTGRES_TEST_URL;
const describePostgres = connectionString ? describe : describe.skip;

interface Executed {
  sql: string;
  values: unknown[];
}

/** The pool the adapter runs on, recording every collection read it makes. */
function recording(pool: Pool, log: Executed[]): Pool {
  return new Proxy(pool, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "query") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string, values?: unknown[]) => {
        if (typeof sql === "string" && /^SELECT (data|count)/.test(sql)) log.push({ sql, values: values ?? [] });
        return (value as (sql: string, values?: unknown[]) => unknown).call(target, sql, values);
      };
    },
  });
}

type Kv = PostgresAdapter["kv"];

/** Each read Foreclose filters on, and the declared field whose index must serve it.
 *  `records_f_` indexes `data -> field`; `records_s_` indexes the "C"-collated text. */
const READS: [string, string, "f" | "s", (kv: Kv) => Promise<unknown>][] = [
  ["where equality", "sourceRecordId", "f", (kv) => kv.list("sightings", { where: { sourceRecordId: "r7" } })],
  ["listWhereIn", "sourceRecordId", "f", (kv) => kv.listWhereIn("sightings", "sourceRecordId", ["r1", "r2", "r3"])],
  ["string range gte", "seenAt", "s", (kv) => kv.list("sightings", { where: { seenAt: { gte: "2026-10-28" } } })],
  ["number range gt", "rank", "f", (kv) => kv.list("sightings", { where: { rank: { gt: 2990 } } })],
  ["count over a range", "seenAt", "s", (kv) => kv.count("sightings", { where: { seenAt: { gt: "2026-10-28" } } })],
];

describePostgres("PostgreSQL query plans with declared indexes", { timeout: 120_000 }, () => {
  let pool: Pool;
  const schemas: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString, max: 4 });
  });
  afterAll(async () => {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  async function plans(declare: boolean): Promise<Map<string, string>> {
    const schema = `mirk_plans_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    const log: Executed[] = [];
    const adapter = await PostgresAdapter.open({ pool: recording(pool, log), schema });
    try {
      if (declare) for (const field of ["sourceRecordId", "seenAt", "rank"]) await adapter.kv.ensureIndex("sightings", field);
      await adapter.transaction(async () => {
        for (let i = 0; i < 3000; i += 1) {
          await adapter.kv.put("sightings", {
            id: `s${i}`,
            sourceRecordId: `r${i % 300}`,
            seenAt: `2026-${String(1 + (i % 10)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
            rank: i % 7 === 0 ? null : i,
          });
        }
      });
      await pool.query(`ANALYZE "${schema}".records`);
      const result = new Map<string, string>();
      for (const [label, , , read] of READS) {
        log.length = 0;
        await read(adapter.kv);
        expect(log, label).toHaveLength(1);
        const explained = await pool.query<{ "QUERY PLAN": string }>(`EXPLAIN ${log[0]!.sql}`, log[0]!.values);
        result.set(label, explained.rows.map((row) => row["QUERY PLAN"]).join("\n"));
      }
      return result;
    } finally {
      await adapter.close();
    }
  }

  it("serves Foreclose's filters from the declared field's expression index", async () => {
    const declared = await plans(true);
    for (const [label, field, kind] of READS) {
      const plan = declared.get(label)!;
      const index = /(?:Index Scan using|Index Only Scan using|Bitmap Index Scan on) (records_[fs]_\w+)/.exec(plan)?.[1];
      expect(index, `${label}\n${plan}`).toMatch(new RegExp(`^records_${kind}_`));
      const definition = await pool.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = $1", [index]);
      expect(definition.rows[0]?.indexdef, label).toContain(`'${field}'`);
    }
  });

  it("uses no field index when none is declared", async () => {
    for (const [label, plan] of await plans(false)) expect(plan, label).not.toMatch(/records_[fs]_/);
  });
});
