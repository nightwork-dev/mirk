import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Surreal, createRemoteEngines } from "surrealdb";
import { createNodeEngines } from "@surrealdb/node";

import { SurrealConnection } from "../src/index.js";
import { SurrealStoreAdapter } from "../src/store.js";

interface Project {
  id: string;
  name: string;
  category: string;
  priority: number;
}

const projects: Project[] = [
  { id: "p1", name: "Alpha", category: "platform", priority: 1 },
  { id: "p2", name: "Beta", category: "ai", priority: 2 },
  { id: "p3", name: "Gamma", category: "tooling", priority: 3 },
  { id: "p4", name: "Delta", category: "creative", priority: 1 },
  { id: "p5", name: "Epsilon", category: "ai", priority: 4 },
];

function createEmbeddedClient(): Surreal {
  return new Surreal({
    engines: {
      ...createRemoteEngines(),
      ...createNodeEngines(),
    },
  });
}

let rawClient: Surreal;
let connection: SurrealConnection;
let store: SurrealStoreAdapter;
let databaseCounter = 0;

beforeEach(async () => {
  rawClient = createEmbeddedClient();
  connection = await SurrealConnection.open({
    client: rawClient,
    endpoint: "mem://",
    namespace: "mirk",
    database: `store_${databaseCounter++}`,
  });
  store = await SurrealStoreAdapter.open(connection);
});

afterEach(async () => {
  await connection.close();
  await rawClient.close();
});

describe("SurrealStoreAdapter (AsyncStore)", () => {
  it("get/set/has/delete round-trip", async () => {
    expect(await store.get("k")).toBeNull();
    expect(await store.has("k")).toBe(false);
    await store.set("k", { n: 1, s: "hi" });
    expect(await store.get("k")).toEqual({ n: 1, s: "hi" });
    expect(await store.has("k")).toBe(true);
    expect(await store.delete("k")).toBe(true);
    expect(await store.delete("k")).toBe(false);
    expect(await store.get("k")).toBeNull();
  });

  it("keys() lists all keys deterministically and filters literal prefixes", async () => {
    await store.set("a_b", 1);
    await store.set("axb", 2);
    await store.set("a_c", 3);
    expect(await store.keys()).toEqual(["a_b", "a_c", "axb"]);
    expect(await store.keys("a_")).toEqual(["a_b", "a_c"]);
  });

  it("collection put/getById/remove/count", async () => {
    expect(await store.getById("users", "u1")).toBeNull();
    await store.put("users", { id: "u1", name: "Ada" });
    await store.put("users", { id: "u2", name: "Lin" });
    expect(await store.getById("users", "u1")).toEqual({ id: "u1", name: "Ada" });
    expect(await store.count("users")).toBe(2);
    expect(await store.remove("users", "u1")).toBe(true);
    expect(await store.remove("users", "u1")).toBe(false);
    expect(await store.count("users")).toBe(1);
  });

  it("put overwrites without mutating the caller object or leaking Surreal record ids", async () => {
    const item = { id: "u1", name: "Ada" };
    await store.put("users", item);
    await store.put("users", { id: "u1", name: "Ada Lovelace" });
    expect(item).toEqual({ id: "u1", name: "Ada" });
    expect(await store.getById("users", "u1")).toEqual({ id: "u1", name: "Ada Lovelace" });
    expect(await store.count("users")).toBe(1);
  });

  it("list() honours where / sortBy / sortDir / limit / offset", async () => {
    for (const project of projects) await store.put("projects", project);

    const where = await store.list<Project>("projects", { where: { category: "ai" } });
    expect(where.map((r) => r.id).sort()).toEqual(["p2", "p5"]);

    const asc = await store.list<Project>("projects", {
      where: { category: "ai" },
      sortBy: "priority",
      sortDir: "asc",
    });
    expect(asc.map((r) => r.id)).toEqual(["p2", "p5"]);

    const desc = await store.list<Project>("projects", {
      where: { category: "ai" },
      sortBy: "priority",
      sortDir: "desc",
    });
    expect(desc.map((r) => r.id)).toEqual(["p5", "p2"]);

    const page = await store.list<Project>("projects", {
      sortBy: "name",
      limit: 2,
      offset: 1,
    });
    expect(page.map((r) => r.id)).toEqual(["p2", "p4"]);
    expect(await store.count("projects", { where: { category: "ai" } })).toBe(2);
  });

  it("distinct collection names do not alias after safe encoding", async () => {
    await store.put("foo-bar", { id: "x", v: 1 });
    await store.put("foo_bar", { id: "x", v: 2 });
    expect(await store.getById<{ id: string; v: number }>("foo-bar", "x")).toEqual({
      id: "x",
      v: 1,
    });
    expect(await store.getById<{ id: string; v: number }>("foo_bar", "x")).toEqual({
      id: "x",
      v: 2,
    });
  });

  it("sort puts null/missing fields last in both directions", async () => {
    await store.put("items", { id: "1", n: 2 });
    await store.put("items", { id: "2" });
    await store.put("items", { id: "3", n: 1 });
    const asc = (await store.list<{ id: string; n?: number }>("items", { sortBy: "n" })).map(
      (r) => r.id,
    );
    const desc = (
      await store.list<{ id: string; n?: number }>("items", { sortBy: "n", sortDir: "desc" })
    ).map((r) => r.id);
    expect(asc).toEqual(["3", "1", "2"]);
    expect(desc).toEqual(["1", "3", "2"]);
  });

  it("where: { x: null } matches explicit null, not missing", async () => {
    await store.put("items", { id: "has-null", x: null, tag: "a" });
    await store.put("items", { id: "missing", tag: "b" });
    await store.put("items", { id: "has-value", x: 5, tag: "c" });
    const matched = (await store.list<{ id: string }>("items", { where: { x: null } })).map(
      (r) => r.id,
    );
    expect(matched).toEqual(["has-null"]);
    expect(await store.count("items", { where: { x: null } })).toBe(1);
  });

  it("dotted field names are literal top-level keys for where and sort", async () => {
    await store.put("items", { id: "flat", "a.b": 1 });
    await store.put("items", { id: "nested", a: { b: 1 } });
    const matched = (await store.list<{ id: string }>("items", { where: { "a.b": 1 } })).map(
      (r) => r.id,
    );
    expect(matched).toEqual(["flat"]);

    await store.put("sort", { id: "x", "a.b": 3, a: { b: 1 } });
    await store.put("sort", { id: "y", "a.b": 1, a: { b: 3 } });
    await store.put("sort", { id: "z", "a.b": 2, a: { b: 2 } });
    const sorted = (await store.list<{ id: string }>("sort", { sortBy: "a.b" })).map((r) => r.id);
    expect(sorted).toEqual(["y", "z", "x"]);
  });

  it("hostile collection and field names cannot alter queries", async () => {
    const evilCollection = "items; DELETE mirk_kv;";
    const evilField = "x') OR true OR ('";
    await store.put(evilCollection, { id: "match", [evilField]: 7 });
    await store.put(evilCollection, { id: "other", other: 1 });
    const where = (
      await store.list<{ id: string }>(evilCollection, { where: { [evilField]: 7 } })
    ).map((r) => r.id);
    expect(where).toEqual(["match"]);
  });

  it("listWhereIn uses one engine query and preserves filter semantics", async () => {
    for (const project of projects) await store.put("projects", project);

    let queryCount = 0;
    const originalQuery = connection.query.bind(connection);
    connection.query = (async (sql: string, bindings?: Record<string, unknown>) => {
      queryCount += 1;
      return originalQuery(sql, bindings);
    }) as SurrealConnection["query"];

    const rows = await store.listWhereIn<Project>(
      "projects",
      "category",
      ["ai", "platform"],
      { where: { priority: 2 } },
    );

    expect(rows.map((r) => r.id)).toEqual(["p2"]);
    expect(queryCount).toBe(1);
  });

  it("adapters do not close the shared connection", async () => {
    await store.set("alive", true);
    expect(await store.get("alive")).toBe(true);
    const second = await SurrealStoreAdapter.open(connection);
    expect(await second.get("alive")).toBe(true);
  });
});
