import { describe, expect, it } from "vitest";

import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { InMemoryStore } from "./backends/memory.js";
import type { SyncStore, SyncStoreInQuery } from "./types.js";

// JSON cannot carry NaN or an infinity, so the corpus cannot pin these cases.
const STORES: [string, () => SyncStore & SyncStoreInQuery][] = [
  ["memory", () => new InMemoryStore()],
  ["better-sqlite3", () => new SqliteAdapter({ path: ":memory:" }).kv],
  ["node:sqlite", () => new NodeSqliteAdapter({ path: ":memory:" }).kv],
];

const filterError = (code: string) => expect.objectContaining({ name: "StoreFilterError", code });

describe.each(STORES)("filter values on %s", (_name, open) => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    it(`rejects ${value} in where and listWhereIn`, () => {
      const store = open();
      store.put("items", { id: "a", f: 1 });
      expect(() => store.list("items", { where: { f: value } })).toThrow(filterError("non-finite-number"));
      expect(() => store.count("items", { where: { f: value } })).toThrow(filterError("non-finite-number"));
      expect(() => store.listWhereIn("items", "f", [1, value])).toThrow(filterError("non-finite-number"));
      expect(() => store.list("items", { where: { f: { gte: value } } })).toThrow(filterError("invalid-range-bound"));
    });
  }

  it("rejects more values than one statement can bind, with a typed error", () => {
    const store = open();
    expect(() => store.listWhereIn("items", "f", Array.from({ length: 32_767 }, (_, i) => i))).toThrow(
      filterError("too-many-in-values"),
    );
  });
});
