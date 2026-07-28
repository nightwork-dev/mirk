import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAdapter } from "./postgres-adapter.js";

const connectionString = process.env.MIRK_POSTGRES_TEST_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("PostgresAdapter", () => {
  const schema = `mirk_test_${randomUUID().replaceAll("-", "")}`;
  let adapter: PostgresAdapter;

  beforeAll(async () => { adapter = await PostgresAdapter.open({ connectionString, schema }); });
  afterAll(async () => {
    await adapter.close();
    const cleanup = new Pool({ connectionString });
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await cleanup.end();
  });

  it("implements key-value CRUD and literal prefix matching", async () => {
    expect(await adapter.kv.get("missing")).toBeNull();
    await adapter.kv.set("a_1", { n: 1 });
    await adapter.kv.set("axb", { n: 2 });
    await adapter.kv.set("a_2", { n: 3 });
    expect(await adapter.kv.get("a_1")).toEqual({ n: 1 });
    expect(await adapter.kv.has("a_1")).toBe(true);
    expect(await adapter.kv.keys("a_")).toEqual(["a_1", "a_2"]);
    expect(await adapter.kv.delete("a_1")).toBe(true);
    expect(await adapter.kv.delete("a_1")).toBe(false);
  });

  it("implements collection CRUD and isolates arbitrary collection names", async () => {
    await adapter.kv.put("foo-bar", { id: "same", value: 1 });
    await adapter.kv.put("foo_bar", { id: "same", value: 2 });
    expect(await adapter.kv.getById("foo-bar", "same")).toEqual({ id: "same", value: 1 });
    expect(await adapter.kv.getById("foo_bar", "same")).toEqual({ id: "same", value: 2 });
    await adapter.kv.put("foo-bar", { id: "same", value: 3 });
    expect(await adapter.kv.count("foo-bar")).toBe(1);
    expect(await adapter.kv.remove("foo-bar", "same")).toBe(true);
    expect(await adapter.kv.remove("foo-bar", "same")).toBe(false);
  });

  it("preserves filters, ordering, pagination, and null semantics", async () => {
    await adapter.kv.put("items", { id: "a", group: "x", rank: 2, "a.b": 3, nullable: null });
    await adapter.kv.put("items", { id: "b", group: "x", rank: 1, "a.b": 1 });
    await adapter.kv.put("items", { id: "c", group: "y", rank: 3, "a.b": 2, nullable: 1 });
    await adapter.kv.put("items", { id: "d", group: "y", rank: 3, "a.b": 4, nullable: 2 });
    expect((await adapter.kv.list<{ id: string }>("items", { where: { group: "x" }, sortBy: "rank", limit: 1, offset: 1 })).map((item) => item.id)).toEqual(["a"]);
    expect((await adapter.kv.list<{ id: string }>("items", { sortBy: "a.b" })).map((item) => item.id)).toEqual(["b", "c", "a", "d"]);
    expect((await adapter.kv.list<{ id: string }>("items", { sortBy: "rank", sortDir: "desc" })).map((item) => item.id)).toEqual(["c", "d", "a", "b"]);
    expect((await adapter.kv.list<{ id: string }>("items", { sortBy: "nullable" })).map((item) => item.id)).toEqual(["c", "d", "a", "b"]);
    expect((await adapter.kv.list<{ id: string }>("items", { sortBy: "nullable", sortDir: "desc" })).map((item) => item.id)).toEqual(["d", "c", "a", "b"]);
    expect((await adapter.kv.list<{ id: string }>("items", { where: { nullable: null } })).map((item) => item.id)).toEqual(["a"]);
    expect(await adapter.kv.count("items", { where: { group: "x" }, limit: 1 })).toBe(2);
    await adapter.kv.put("items", { id: "a", group: "x", rank: 4, "a.b": 3, nullable: null });
    expect((await adapter.kv.list<{ id: string }>("items")).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("binds hostile field names and supports listWhereIn", async () => {
    const hostile = `x') OR true --`;
    await adapter.kv.put("hostile", { id: "match", [hostile]: 7, from: "a", active: true });
    await adapter.kv.put("hostile", { id: "other", from: "b", active: false });
    expect((await adapter.kv.list<{ id: string }>("hostile", { where: { [hostile]: 7 } })).map((item) => item.id)).toEqual(["match"]);
    expect((await adapter.kv.listWhereIn<{ id: string }>("hostile", "from", ["a", "c"], { where: { active: true } })).map((item) => item.id)).toEqual(["match"]);
    expect(await adapter.kv.listWhereIn("hostile", "from", [])).toEqual([]);
  });

  it("rejects non-JSON values and invalid pagination", async () => {
    await expect(adapter.kv.set("undefined", undefined)).rejects.toThrow(/JSON-serializable/);
    await expect(adapter.kv.set("nested", { lost: undefined })).rejects.toThrow(/JSON-serializable/);
    await expect(adapter.kv.set("nan", Number.NaN)).rejects.toThrow(/JSON-serializable/);
    await expect(adapter.kv.list("items", { limit: -1 })).rejects.toThrow(/non-negative integer/);
    await expect(adapter.kv.list("items", { offset: 1.5 })).rejects.toThrow(/non-negative integer/);
  });

  it("persists across independently owned pools", async () => {
    await adapter.kv.set("persistent", { yes: true });
    const reopened = await PostgresAdapter.open({ connectionString, schema });
    expect(await reopened.kv.get("persistent")).toEqual({ yes: true });
    await reopened.close();
  });

  it("does not end a caller-owned pool", async () => {
    const pool = new Pool({ connectionString });
    const borrowed = await PostgresAdapter.open({ pool, schema });
    await borrowed.close();
    expect((await pool.query("SELECT 1 AS value")).rows[0]?.value).toBe(1);
    await pool.end();
  });

  it("quotes a hostile schema identifier", async () => {
    const hostileSchema = `mirk_\"; SELECT pg_sleep(1); --_${randomUUID()}`;
    const isolated = await PostgresAdapter.open({ connectionString, schema: hostileSchema });
    await isolated.kv.set("safe", true);
    expect(await isolated.kv.get("safe")).toBe(true);
    await isolated.close();
    const cleanup = new Pool({ connectionString });
    await cleanup.query(`DROP SCHEMA IF EXISTS "${hostileSchema.replaceAll('"', '""')}" CASCADE`);
    await cleanup.end();
  });
});
