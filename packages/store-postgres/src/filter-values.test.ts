import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAdapter } from "./postgres-adapter.js";

const connectionString = process.env.MIRK_POSTGRES_TEST_URL;
const describePostgres = connectionString ? describe : describe.skip;

const filterError = (code: string) => expect.objectContaining({ name: "StoreFilterError", code });

// JSON cannot carry NaN or an infinity, so the corpus cannot pin these cases.
describePostgres("PostgreSQL filter values", () => {
  const schema = `mirk_filter_${randomUUID().replaceAll("-", "")}`;
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = await PostgresAdapter.open({ connectionString, schema });
    await adapter.kv.put("items", { id: "a", f: 1 });
  });
  afterAll(async () => {
    await adapter.close();
    const cleanup = new Pool({ connectionString });
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
  });

  it("answers for a field name holding NUL, which no jsonb record can have", async () => {
    const field = "a\u0000b";
    await adapter.kv.ensureIndex("items", field);
    expect(await adapter.kv.list("items", { where: { [field]: 1 } })).toEqual([]);
    expect(await adapter.kv.listWhereIn("items", field, [1])).toEqual([]);
    expect(await adapter.kv.list("items", { sortBy: field })).toEqual([{ id: "a", f: 1 }]);
  });

  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`rejects ${value} in where and listWhereIn`, async () => {
      await expect(adapter.kv.list("items", { where: { f: value } })).rejects.toThrow(filterError("non-finite-number"));
      await expect(adapter.kv.count("items", { where: { f: value } })).rejects.toThrow(filterError("non-finite-number"));
      await expect(adapter.kv.listWhereIn("items", "f", [1, value])).rejects.toThrow(filterError("non-finite-number"));
      await expect(adapter.kv.list("items", { where: { f: { gte: value } } })).rejects.toThrow(
        filterError("invalid-range-bound"),
      );
    });
  }
});
